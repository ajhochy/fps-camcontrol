"""DJI RS3 Bluetooth LE driver.

The DUML framing and RS3 command layout are implemented from the MIT-licensed
jdesbonnet/dji_rs3_control project at revision
689884f2249e721c5b65c9c74804caddc1e7a68c (Copyright 2026 Joe Desbonnet).
The full MIT notice is in pi-bridge/THIRD_PARTY_NOTICES.md.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Awaitable, Callable
from time import monotonic
from typing import Optional, Protocol

from .base import Attitude, GimbalError, NotSupported

NOTIFY_UUID = "0000fff4-0000-1000-8000-00805f9b34fb"
WRITE_UUID = "0000fff5-0000-1000-8000-00805f9b34fb"
CENTER = 1024
MAX_JOYSTICK = 80
POLL_PAYLOADS = (
    bytes.fromhex("660cc01d108401000e000c000050000000000000000010"),
    bytes.fromhex("660cc01d103e010000000c000050"),
    bytes.fromhex("6624c01d00001c1051010000000c00005000f103"),
)

NotificationCallback = Callable[[bytes], Optional[Awaitable[None]]]


class BleTransport(Protocol):
    async def connect(self) -> None: ...
    async def disconnect(self) -> None: ...
    async def start_notifications(self, callback: NotificationCallback) -> None: ...
    async def stop_notifications(self) -> None: ...
    async def write(self, frame: bytes) -> None: ...


class _BleakTransport:
    def __init__(self, address: str, timeout: float) -> None:
        self.address = address
        self.timeout = timeout
        self.client = None

    async def connect(self) -> None:
        try:
            from bleak import BleakClient
        except ImportError as exc:
            raise GimbalError("bleak is required for --driver dji-rs3-ble") from exc
        self.client = BleakClient(self.address, timeout=self.timeout)
        await self.client.connect()

    async def disconnect(self) -> None:
        if self.client is not None:
            await self.client.disconnect()
            self.client = None

    async def start_notifications(self, callback: NotificationCallback) -> None:
        if self.client is None:
            raise GimbalError("BLE transport is not connected")

        async def dispatch(_sender: object, data: bytearray) -> None:
            result = callback(bytes(data))
            if result is not None:
                await result

        await self.client.start_notify(NOTIFY_UUID, dispatch)

    async def stop_notifications(self) -> None:
        if self.client is not None:
            await self.client.stop_notify(NOTIFY_UUID)

    async def write(self, frame: bytes) -> None:
        if self.client is None:
            raise GimbalError("BLE transport is not connected")
        await self.client.write_gatt_char(WRITE_UUID, frame, response=False)


def _crc8(data: bytes, seed: int = 0x77) -> int:
    crc = seed
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0x8C if crc & 1 else crc >> 1
    return crc & 0xFF


def _crc16(data: bytes, seed: int = 0x3692) -> int:
    crc = seed
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0x8408 if crc & 1 else crc >> 1
    return crc & 0xFFFF


def _frame(sequence: int, cmd_set: int, cmd_id: int, payload: bytes) -> bytes:
    length = 13 + len(payload)
    body = bytearray([0x55, length & 0xFF, 0x04 | ((length >> 8) & 0x03)])
    body.append(_crc8(body))
    body.extend((0x02, 0x04, sequence & 0xFF, sequence >> 8, 0x40, cmd_set, cmd_id))
    body.extend(payload)
    checksum = _crc16(body)
    body.extend((checksum & 0xFF, checksum >> 8))
    return bytes(body)


def _joystick_payload(tilt: int = 0, roll: int = 0, pan: int = 0) -> bytes:
    return b"".join((CENTER + value).to_bytes(2, "little") for value in (tilt, roll, pan)) + b"\0\0\x02"


def _embedded_frames(data: bytes) -> list[bytes]:
    frames: list[bytes] = []
    offset = 0
    while (start := data.find(b"\x55", offset)) >= 0 and start + 3 <= len(data):
        length = data[start + 1] | ((data[start + 2] & 0x03) << 8)
        if 13 <= length <= 247 and start + length <= len(data):
            frames.append(data[start : start + length])
            offset = start + length
        else:
            offset = start + 1
    return frames


def _pose_from_frame(frame: bytes) -> Attitude | None:
    if len(frame) < 13 or frame[9:11] != b"\x04\x66":
        return None
    payload = frame[11:-2]
    fields: dict[int, int] = {}
    offset = 1
    while offset + 2 <= len(payload):
        tag, length = payload[offset : offset + 2]
        value = payload[offset + 2 : offset + 2 + length]
        if len(value) != length:
            return None
        fields[tag] = int.from_bytes(value, "little", signed=True)
        offset += 2 + length
    if not all(tag in fields for tag in (0x22, 0x23, 0x24)):
        return None
    return Attitude(yaw=fields[0x24] / 10.0, pitch=fields[0x22] / 10.0, roll=fields[0x23] / 10.0)


class DjiRsDriver:
    name = "dji-rs3-ble"
    model = "RS3"
    capabilities = ("velocity", "position", "moveTo", "recenter")
    mode = "follow"

    def __init__(
        self,
        address: str | None = None,
        timeout: float = 15.0,
        transport_factory: Callable[[str, float], BleTransport] = _BleakTransport,
    ) -> None:
        self.address = address or os.environ.get("DJI_RS3_BLE_ADDRESS")
        if not self.address:
            raise GimbalError("set --ble-address or DJI_RS3_BLE_ADDRESS")
        self.timeout = timeout
        self._transport = transport_factory(self.address, timeout)
        self._sequence = 0x5000
        self._pose: Attitude | None = None
        self._pose_at = 0.0
        self._pose_event = asyncio.Event()
        self._poll_index = 0
        self.connected = False

    async def connect(self) -> None:
        try:
            await self._transport.connect()
            await self._transport.start_notifications(self._handle_notification)
        except Exception as exc:
            await self._transport.disconnect()
            raise GimbalError(f"failed to connect to RS3 at {self.address}: {exc}") from exc
        self.connected = True

    async def close(self) -> None:
        if not self.connected:
            return
        try:
            await self.stop()
        finally:
            try:
                await self._transport.stop_notifications()
            finally:
                await self._transport.disconnect()
                self.connected = False

    async def move_velocity(self, pan: float, tilt: float, roll: float) -> None:
        await self._write(0x04, 0x01, _joystick_payload(
            tilt=self._joystick(tilt), roll=self._joystick(roll), pan=self._joystick(pan)
        ))

    async def stop(self) -> None:
        if not self.connected:
            return
        try:
            await self._write(0x04, 0x0C, b"\0\0\0\0\0\0\0")
        finally:
            for _ in range(3):
                await self._write(0x04, 0x01, _joystick_payload())
                await asyncio.sleep(0.1)

    async def get_position(self) -> Attitude:
        started = monotonic()
        self._pose_event.clear()
        while monotonic() - started < self.timeout:
            payload = POLL_PAYLOADS[self._poll_index % len(POLL_PAYLOADS)]
            self._poll_index += 1
            await self._write(0x04, 0x12, payload, receiver=0xE5)
            try:
                await asyncio.wait_for(self._pose_event.wait(), timeout=min(0.5, self.timeout))
            except TimeoutError:
                continue
            if self._pose is not None and self._pose_at >= started:
                return self._pose
        raise GimbalError("timed out waiting for active RS3 pose telemetry")

    async def move_to(self, yaw: float, pitch: float, roll: float, speed: float) -> None:
        duration = max(1, min(255, round(10 / max(0.05, min(1.0, speed)))))
        payload = b"".join(round(value * 10).to_bytes(2, "little", signed=True) for value in (yaw, roll, pitch))
        await self._write(0x04, 0x14, payload + bytes((1, duration)))

    async def recenter(self) -> None:
        await self._write(0x04, 0x4C, bytes.fromhex("fe01"))

    async def set_mode(self, mode: str) -> None:
        raise NotSupported("set_mode is not implemented for dji-rs3-ble")

    @staticmethod
    def _joystick(value: float) -> int:
        return round(max(-1.0, min(1.0, value)) * MAX_JOYSTICK)

    async def _write(self, cmd_set: int, cmd_id: int, payload: bytes, receiver: int = 0x04) -> None:
        if not self.connected:
            raise GimbalError("RS3 is not connected")
        sequence = self._sequence
        self._sequence = (self._sequence + 1) & 0xFFFF
        frame = _frame(sequence, cmd_set, cmd_id, payload)
        if receiver != 0x04:
            frame = frame[:5] + bytes((receiver,)) + frame[6:-2]
            checksum = _crc16(frame)
            frame += bytes((checksum & 0xFF, checksum >> 8))
        await self._transport.write(frame)

    async def _handle_notification(self, data: bytes) -> None:
        for frame in _embedded_frames(data):
            pose = _pose_from_frame(frame)
            if pose is not None:
                self._pose = pose
                self._pose_at = monotonic()
                self._pose_event.set()
