"""DJI RS3 Bluetooth LE driver.

The DUML framing and RS3 command layout are implemented from the MIT-licensed
jdesbonnet/dji_rs3_control project at revision
689884f2249e721c5b65c9c74804caddc1e7a68c (Copyright 2026 Joe Desbonnet).
The full MIT notice is in pi-bridge/THIRD_PARTY_NOTICES.md.

Attitude telemetry (measured on an RS3 and an RS3 Pro, 2026-08-13):
ATTITUDE_SUBSCRIBE_PAYLOAD turns on a *sticky* ~1 Hz push of 0x04/0x66 frames
carrying tags 0x22/0x23/0x24 (pitch/roll/yaw, tenths of a degree). It is not a
request/response poll: after one subscribe frame the gimbal keeps pushing with
no further writes, and re-sending the subscribe does not shorten the wait
(measured latency 0.43-0.83 s either way). The other two payloads the driver
used to cycle through *cancel* the attitude push — after one of them, zero pose
frames arrive until the attitude payload is sent again.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from collections.abc import Awaitable, Callable
from time import monotonic
from typing import Optional, Protocol

from .base import Attitude, GimbalError, NotSupported

log = logging.getLogger("dji-bridge.rs3")

NOTIFY_UUID = "0000fff4-0000-1000-8000-00805f9b34fb"
WRITE_UUID = "0000fff5-0000-1000-8000-00805f9b34fb"
CENTER = 1024
MAX_JOYSTICK = 80
# How long to look for the gimbal's advertisement before giving up on one attempt.
# Kept short because the caller holds a host-wide BLE lock while this runs.
SCAN_TIMEOUT_S = 8.0
# Subscribes to the ~1 Hz attitude push. Sticky: send once per link, then again
# only if the push stops. The two payloads that used to be cycled alongside it
# switch the push OFF, which is why reads went stale (issue #17).
ATTITUDE_SUBSCRIBE_PAYLOAD = bytes.fromhex("6624c01d00001c1051010000000c00005000f103")
# Pose pushes arrive every ~0.9-1.15 s, so one read must be allowed to span more
# than one interval, but nowhere near the 15 s connect timeout: getPosition on a
# dead link used to hang for the full timeout (issue #15).
POSE_PUSH_INTERVAL_S = 1.15
POSE_READ_TIMEOUT_S = 3.0
# The newest push is the freshest truth that exists, so serving it is honest as
# long as it is recent AND cannot predate our own last motion command. Waiting
# for the *next* push instead would add up to a full interval to every read and
# blow the app's 1 s getPosition timeout.
MAX_POSE_AGE_S = 1.5
# Re-send the subscribe frame when the push has been quiet for longer than this.
SUBSCRIBE_REFRESH_S = 1.5
# Consecutive reads that see no pose telemetry at all before the link is declared
# dead so maintain_gimbal() rebuilds it.
POSE_FAILURES_BEFORE_LINK_LOSS = 3
# A pose implying faster motion than this is treated as a garbled read and must be
# corroborated by the next frame before it is accepted (issue #17).
MAX_POSE_RATE_DEG_S = 400.0
POSE_JUMP_GRACE_DEG = 10.0
# Notification reassembly buffer cap. A DUML frame is at most 247 bytes.
MAX_RX_BYTES = 1024
LOG_THROTTLE_S = 10.0

NotificationCallback = Callable[[bytes], Optional[Awaitable[None]]]


class BleTransport(Protocol):
    # Set by the driver; invoked (no args) when the link drops unexpectedly.
    on_disconnect: Optional[Callable[[], None]]

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
        self.linked = False
        self.on_disconnect: Callable[[], None] | None = None

    async def connect(self) -> None:
        try:
            from bleak import BleakClient, BleakScanner
        except ImportError as exc:
            raise GimbalError("bleak is required for --driver dji-rs3-ble") from exc
        # Discover before connecting. On Linux/BlueZ, BleakClient(<bare address>)
        # only works when BlueZ already has the device cached; a gimbal that was
        # asleep at startup (or that slept and woke) is not cached, so connect
        # fails with "Device ... was not found" forever even once it is awake.
        # Scanning first is the supported pattern and makes powering a gimbal on
        # mid-service actually reconnect. Callers serialise this (BlueZ allows
        # only one connect/scan operation at a time per adapter).
        device = await BleakScanner.find_device_by_address(self.address, timeout=SCAN_TIMEOUT_S)
        if device is None:
            raise GimbalError(
                f"gimbal {self.address} is not advertising (powered off, asleep, "
                "out of range, or already connected to another host)"
            )
        # bleak calls disconnected_callback in the event loop when the peer goes
        # away. Without it nothing ever notices a gimbal that sleeps mid-service.
        self.client = BleakClient(
            device, timeout=self.timeout, disconnected_callback=self._disconnected
        )
        await self.client.connect()
        self.linked = True

    def _disconnected(self, _client: object) -> None:
        # Keep the client object: BlueZ can hold the ACL link open after the peer
        # goes away, and only this client can tell it to let go. Dropping the
        # reference here left the gimbal linked-but-unusable, not advertising, so
        # no later scan could ever find it again.
        self.linked = False
        if self.on_disconnect is not None:
            self.on_disconnect()

    async def disconnect(self) -> None:
        client, self.client = self.client, None
        self.linked = False
        if client is not None:
            await client.disconnect()

    async def start_notifications(self, callback: NotificationCallback) -> None:
        if self.client is None or not self.linked:
            raise GimbalError("BLE transport is not connected")

        async def dispatch(_sender: object, data: bytearray) -> None:
            result = callback(bytes(data))
            if result is not None:
                await result

        await self.client.start_notify(NOTIFY_UUID, dispatch)

    async def stop_notifications(self) -> None:
        if self.client is not None and self.linked:
            await self.client.stop_notify(NOTIFY_UUID)

    async def write(self, frame: bytes) -> None:
        if self.client is None or not self.linked:
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


def _valid_frame(candidate: bytes) -> bool:
    """Both DUML checksums must match: header CRC-8 and whole-frame CRC-16.

    Verified against 102 consecutive frames captured from a live RS3: every real
    frame passes, so rejecting the rest is safe. Without this the parser accepted
    any run of bytes that merely started with 0x55 and had a plausible length —
    the likeliest source of the bogus yaw=12.1 in issue #17.
    """
    if len(candidate) < 13:
        return False
    return _crc16(candidate[:-2]) == int.from_bytes(candidate[-2:], "little")


def _pose_from_frame(frame: bytes) -> Attitude | None:
    if len(frame) < 13 or frame[9:11] != b"\x04\x66":
        return None
    payload = frame[11:-2]
    fields: dict[int, int] = {}
    lengths: dict[int, int] = {}
    offset = 1  # payload[0] is a return/subscription code, not a TLV
    while offset + 2 <= len(payload):
        tag, length = payload[offset : offset + 2]
        value = payload[offset + 2 : offset + 2 + length]
        if len(value) != length:
            return None
        fields[tag] = int.from_bytes(value, "little", signed=True)
        lengths[tag] = length
        offset += 2 + length
    # A pose frame's TLV stream ends exactly on the payload boundary. Anything
    # left over means the bytes were not really a TLV stream.
    if offset != len(payload):
        return None
    if any(lengths.get(tag) != 2 for tag in (0x22, 0x23, 0x24)):
        return None
    return Attitude(yaw=fields[0x24] / 10.0, pitch=fields[0x22] / 10.0, roll=fields[0x23] / 10.0)


def _angle_delta(a: float, b: float) -> float:
    return abs((a - b + 180.0) % 360.0 - 180.0)


def _pose_delta(a: Attitude, b: Attitude) -> float:
    return max(
        _angle_delta(a.yaw, b.yaw),
        _angle_delta(a.pitch, b.pitch),
        _angle_delta(a.roll, b.roll),
    )


def _is_link_error(exc: BaseException) -> bool:
    """Does this write failure mean the BLE link is gone?

    Matched by module name so this file never has to import bleak (mock mode and
    the tests run without it). A link that dropped underneath us surfaces as
    BleakError("Service Discovery has not been performed yet") — observed live on
    the RS3 that slept mid-service (issue #15).
    """
    if isinstance(exc, (OSError, EOFError, TimeoutError, asyncio.TimeoutError, GimbalError)):
        return True
    return (type(exc).__module__ or "").split(".")[0] in {"bleak", "dbus_fast", "dbus_next"}


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
        with contextlib.suppress(AttributeError):
            self._transport.on_disconnect = self._on_link_lost
        self._sequence = 0x5000
        self._pose: Attitude | None = None
        self._pose_at = 0.0
        self._pose_seq = 0
        self._last_command_at = 0.0
        self._unconfirmed: Attitude | None = None
        self._waiters: list[asyncio.Future[None]] = []
        self._rx = bytearray()
        self._accepted = 0
        self._discarded = 0
        self._read_failures = 0
        self._closing = False
        self._had_link = False
        self._logged_at: dict[str, float] = {}
        self.connected = False

    async def connect(self) -> None:
        self._closing = False
        if self._had_link:
            # Drop the stale client from the link we lost before building a new one.
            with contextlib.suppress(Exception):
                await self._transport.disconnect()
        try:
            await self._transport.connect()
            await self._transport.start_notifications(self._handle_notification)
        except Exception as exc:
            with contextlib.suppress(Exception):
                await self._transport.disconnect()
            raise GimbalError(f"failed to connect to RS3 at {self.address}: {exc}") from exc
        # A pose from the previous link must never be served on this one.
        self._pose = None
        self._pose_at = 0.0
        self._unconfirmed = None
        self._rx.clear()
        self._read_failures = 0
        self._had_link = True
        self.connected = True
        try:
            await self._subscribe_attitude()
        except GimbalError as exc:
            log.warning("RS3 %s connected but attitude subscribe failed: %s", self.address, exc)

    async def close(self) -> None:
        self._closing = True
        if not self.connected:
            self._wake_waiters()
            return
        try:
            with contextlib.suppress(Exception):
                await self.stop()
        finally:
            try:
                with contextlib.suppress(Exception):
                    await self._transport.stop_notifications()
            finally:
                with contextlib.suppress(Exception):
                    await self._transport.disconnect()
                self.connected = False
                self._wake_waiters()

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
                if not self.connected:
                    break
                await self._write(0x04, 0x01, _joystick_payload())
                await asyncio.sleep(0.1)

    async def get_position(self) -> Attitude:
        """Return a pose that is recent and provably later than our last command.

        Attitude is a ~1 Hz push, not a poll answer, so "the position now" is only
        ever known to within one interval. What must never happen is returning a
        sample from *before* the move we just commanded: that is how a preset save
        stored the wrong position and recall then drove the camera somewhere
        unexpected on air (issue #17). So a cached pose is served only while it is
        younger than MAX_POSE_AGE_S and newer than the last motion command;
        otherwise this waits for a push that arrives after the call.
        """
        if not self.connected:
            raise GimbalError("RS3 is not connected")
        started = monotonic()
        cached = self._usable_cached_pose(started)
        if cached is not None:
            self._read_failures = 0
            return cached
        deadline = started + min(self.timeout, POSE_READ_TIMEOUT_S)
        seen = self._pose_seq
        # The push is sticky, so only nudge it when telemetry has gone quiet.
        quiet = started - self._pose_at > SUBSCRIBE_REFRESH_S
        while True:
            if not self.connected:
                raise GimbalError("RS3 link lost while reading position")
            pose = self._pose
            if pose is not None and self._pose_seq != seen and self._pose_at >= started:
                self._read_failures = 0
                return pose
            remaining = deadline - monotonic()
            if remaining <= 0:
                break
            # Register interest before writing: on a fast link the push can land
            # inside the write, and a waiter created afterwards would miss it.
            waiter = self._new_waiter()
            try:
                if quiet:
                    await self._subscribe_attitude()
                await asyncio.wait_for(waiter, timeout=min(POSE_PUSH_INTERVAL_S, remaining))
            except (asyncio.TimeoutError, TimeoutError):
                quiet = True  # nothing arrived: the subscription may have lapsed
            finally:
                self._drop_waiter(waiter)
        self._read_failures += 1
        if self._read_failures >= POSE_FAILURES_BEFORE_LINK_LOSS:
            self._on_link_lost("no pose telemetry")
            raise GimbalError("RS3 stopped answering pose telemetry — link marked down")
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

    def _usable_cached_pose(self, now: float) -> Attitude | None:
        pose = self._pose
        if pose is None:
            return None
        if now - self._pose_at > MAX_POSE_AGE_S:
            return None  # telemetry has stalled; do not pass off old news as now
        if self._pose_at < self._last_command_at:
            return None  # sampled before our own last motion command
        return pose

    async def _subscribe_attitude(self) -> None:
        await self._write(0x04, 0x12, ATTITUDE_SUBSCRIBE_PAYLOAD, receiver=0xE5)

    async def _write(self, cmd_set: int, cmd_id: int, payload: bytes, receiver: int = 0x04) -> None:
        if not self.connected:
            raise GimbalError("RS3 is not connected")
        if (cmd_set, cmd_id) != (0x04, 0x12):
            # Anything that is not the telemetry subscribe can move the gimbal, so
            # every pose sampled before now is potentially out of date.
            self._last_command_at = monotonic()
        sequence = self._sequence
        self._sequence = (self._sequence + 1) & 0xFFFF
        frame = _frame(sequence, cmd_set, cmd_id, payload)
        if receiver != 0x04:
            frame = frame[:5] + bytes((receiver,)) + frame[6:-2]
            checksum = _crc16(frame)
            frame += bytes((checksum & 0xFF, checksum >> 8))
        try:
            await self._transport.write(frame)
        except Exception as exc:
            if _is_link_error(exc):
                self._on_link_lost(f"write failed: {exc}")
                raise GimbalError(f"RS3 link lost while writing: {exc}") from exc
            raise

    def _on_link_lost(self, reason: str = "BLE link dropped") -> None:
        """Mark the link dead so maintain_gimbal() rebuilds it.

        Called from bleak's disconnected_callback, and from any write or read that
        proves the link is gone. `connected` staying True through a silent drop is
        exactly what left a slept gimbal dead until a service restart (issue #15).
        """
        was_connected = self.connected
        self.connected = False
        self._pose = None
        self._unconfirmed = None
        self._rx.clear()
        self._read_failures = 0
        self._wake_waiters()
        if was_connected and not self._closing:
            self._throttled_warning("link-lost", "RS3 %s link lost: %s — reconnecting", self.address, reason)

    def _throttled_warning(self, key: str, message: str, *args: object) -> None:
        now = monotonic()
        if now - self._logged_at.get(key, 0.0) < LOG_THROTTLE_S:
            return
        self._logged_at[key] = now
        log.warning(message, *args)

    def _new_waiter(self) -> asyncio.Future[None]:
        waiter: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._waiters.append(waiter)
        return waiter

    def _drop_waiter(self, waiter: asyncio.Future[None]) -> None:
        if waiter in self._waiters:
            self._waiters.remove(waiter)

    def _wake_waiters(self) -> None:
        for waiter in self._waiters:
            if not waiter.done():
                waiter.set_result(None)
        self._waiters.clear()

    async def _handle_notification(self, data: bytes) -> None:
        self._rx.extend(data)
        if len(self._rx) > MAX_RX_BYTES:
            del self._rx[:-MAX_RX_BYTES]
        for frame in self._take_frames():
            pose = _pose_from_frame(frame)
            if pose is None or not self._plausible(pose):
                continue
            self._pose = pose
            self._pose_at = monotonic()
            self._pose_seq += 1
            self._wake_waiters()

    def _take_frames(self) -> list[bytes]:
        """Pull complete, checksum-valid frames out of the receive buffer.

        One notification can carry several frames and a frame can straddle two
        notifications (both observed live), so the stream has to be reassembled
        rather than parsed per packet.
        """
        frames: list[bytes] = []
        while True:
            start = self._rx.find(0x55)
            if start < 0:
                self._rx.clear()
                return frames
            if start:
                del self._rx[:start]
            if len(self._rx) < 4:
                return frames
            length = self._rx[1] | ((self._rx[2] & 0x03) << 8)
            if not 13 <= length <= 247 or self._rx[3] != _crc8(bytes(self._rx[:3])):
                del self._rx[:1]  # not a real header; resync past this 0x55
                continue
            if len(self._rx) < length:
                return frames  # frame still arriving
            candidate = bytes(self._rx[:length])
            if not _valid_frame(candidate):
                # Expected occasionally: a dropped notification truncates a frame,
                # so the bytes behind it no longer line up. Resync and carry on.
                del self._rx[:1]
                self._discarded += 1
                self._throttled_warning(
                    "bad-crc",
                    "RS3 %s resynced past a bad checksum (%d discarded, %d frames accepted)",
                    self.address, self._discarded, self._accepted,
                )
                continue
            self._accepted += 1
            del self._rx[:length]
            frames.append(candidate)

    def _plausible(self, pose: Attitude) -> bool:
        """Reject a pose that implies impossible motion unless the next one agrees.

        Idle sampling on real hardware held every axis within 0.1 deg, so a large
        one-frame jump is a bad read, not the camera moving — but a genuine fast
        move must still get through, hence the corroboration path.
        """
        previous = self._pose
        if previous is None:
            return True
        elapsed = max(0.05, monotonic() - self._pose_at)
        allowed = POSE_JUMP_GRACE_DEG + MAX_POSE_RATE_DEG_S * elapsed
        if _pose_delta(previous, pose) <= allowed:
            self._unconfirmed = None
            return True
        unconfirmed, self._unconfirmed = self._unconfirmed, pose
        if unconfirmed is not None and _pose_delta(unconfirmed, pose) <= POSE_JUMP_GRACE_DEG:
            return True  # two frames agree: the gimbal really is there
        self._throttled_warning(
            "implausible",
            "RS3 %s rejected implausible pose yaw=%.1f pitch=%.1f roll=%.1f (was yaw=%.1f pitch=%.1f roll=%.1f)",
            self.address, pose.yaw, pose.pitch, pose.roll, previous.yaw, previous.pitch, previous.roll,
        )
        return False
