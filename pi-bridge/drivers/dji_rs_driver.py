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
from collections import deque
from collections.abc import Awaitable, Callable
from time import monotonic
from typing import Optional, Protocol

from .base import Attitude, GimbalError, NotSupported

log = logging.getLogger("dji-bridge.rs3")

NOTIFY_UUID = "0000fff4-0000-1000-8000-00805f9b34fb"
WRITE_UUID = "0000fff5-0000-1000-8000-00805f9b34fb"
CENTER = 1024
# Joystick magnitude sent at full stick deflection — the operator's speed limit
# for this gimbal. 80 is a deliberately gentle default; the deployed systemd
# template documents raising it per instance via DJI_RS3_MAX_JOYSTICK, so the
# variable is read here (see systemd/dji-bridge@.service). Read per driver
# instance, not once at import, because each templated unit is its own process
# with its own env file.
DEFAULT_MAX_JOYSTICK = 80
MAX_JOYSTICK_ENV = "DJI_RS3_MAX_JOYSTICK"
# The payload encodes CENTER+value as an unsigned 16-bit little-endian word, so
# the magnitude can never exceed CENTER without wrapping past zero on the
# negative side. 1000 keeps a margin under that and is the range the service
# file advertises. A typo like 20000 must be clamped, not sent to a camera.
MIN_MAX_JOYSTICK = 1
MAX_MAX_JOYSTICK = 1000
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
        # The gimbal's advertised name and RSSI, from the scan that found it for this connect.
        self.name: str | None = None
        self.rssi: float | None = None

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
        wanted = self.address.upper()

        def match(found: object, adv: object) -> bool:
            # Same lookup as find_device_by_address, but it also keeps the advertised name and signal strength,
            # which /info reports (a linked gimbal stops advertising, so this is the last RSSI there is).
            if str(getattr(found, "address", "")).upper() != wanted:
                return False
            self.name = getattr(adv, "local_name", None) or getattr(found, "name", None)
            rssi = getattr(adv, "rssi", None)
            self.rssi = rssi if isinstance(rssi, (int, float)) else None
            return True

        device = await BleakScanner.find_device_by_filter(match, timeout=SCAN_TIMEOUT_S)
        if device is None and await _release_stale_link(self.address):
            # BlueZ still held a link to it (from a connect that half-failed, or a link this process lost track
            # of). A connected gimbal does not advertise, so no scan could ever find it: let go and look again.
            await asyncio.sleep(1.5)
            device = await BleakScanner.find_device_by_filter(match, timeout=SCAN_TIMEOUT_S)
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


async def _release_stale_link(address: str) -> bool:
    """If BlueZ reports this gimbal connected although we are not, disconnect it. True when a link was released."""
    async def run(*args: str) -> str:
        proc = await asyncio.create_subprocess_exec(
            "bluetoothctl", *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=5.0)
        except asyncio.TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            return ""
        return out.decode(errors="replace")

    try:
        if "Connected: yes" not in await run("info", address):
            return False
        log.warning("RS3 %s: BlueZ still holds a link to it but the bridge does not; releasing it", address)
        await run("disconnect", address)
        return True
    except (FileNotFoundError, OSError):
        return False  # no bluetoothctl (a dev box): nothing to release


async def bleak_scan(timeout: float) -> list[dict[str, object]]:
    """Every BLE device heard for `timeout` seconds: [{address, name, rssi}]. Callers hold the host-wide BLE lock."""
    try:
        from bleak import BleakScanner
    except ImportError as exc:
        raise GimbalError("bleak is required to scan for gimbals") from exc
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    out: list[dict[str, object]] = []
    for device, adv in found.values():
        out.append({
            "address": str(device.address).upper(),
            "name": getattr(adv, "local_name", None) or getattr(device, "name", None),
            "rssi": getattr(adv, "rssi", None),
        })
    return out


# Passive frame census (DJI_RS3_FRAME_CENSUS=0 turns it off): log the first frame of each kind and every change of
# the status frames, so what a sleeping gimbal sends can be compared with an awake one. Listen-only: nothing is
# written to the gimbal for it.
CENSUS_ENV = "DJI_RS3_FRAME_CENSUS"
CENSUS_WATCH = {(0x04, 0x27), (0x0D, 0x02), (0x04, 0x10), (0x04, 0x1C)}
CENSUS_SUMMARY_S = 60.0
# Wake command payload (cmd_set 0x04, cmd_id 0x0f): 23 01 00 = wake; 23 01 01 would put it to sleep.
WAKE_PAYLOAD = bytes((0x23, 0x01, 0x00))

# The gimbal's own "sleep status" notification (cmd_set 0x04, cmd_id 0x27): last payload byte 1 = asleep, 0 = awake
# (jdesbonnet/dji_rs3_control rs3_ble_protocol_spec.md 4.3 / 6.4).
SLEEP_STATUS = (0x04, 0x27)


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


def resolve_max_joystick(raw: str | int | None) -> int:
    """Turn a configured joystick gain into a value that is safe to send.

    This number is how fast a real camera moves at full stick, so a missing,
    malformed, or out-of-range setting must degrade to the gentle default or the
    nearest safe bound rather than being trusted. Every correction is logged: a
    silently ignored setting is exactly the bug this function exists to fix.
    """
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return DEFAULT_MAX_JOYSTICK
    try:
        value = int(str(raw).strip())
    except ValueError:
        log.warning(
            "%s=%r is not an integer — using the default %d",
            MAX_JOYSTICK_ENV, raw, DEFAULT_MAX_JOYSTICK,
        )
        return DEFAULT_MAX_JOYSTICK
    clamped = max(MIN_MAX_JOYSTICK, min(MAX_MAX_JOYSTICK, value))
    if clamped != value:
        log.warning(
            "%s=%d is outside the safe range %d..%d — clamped to %d",
            MAX_JOYSTICK_ENV, value, MIN_MAX_JOYSTICK, MAX_MAX_JOYSTICK, clamped,
        )
    return clamped


class DjiRsDriver:
    name = "dji-rs3-ble"
    model = "RS3"
    capabilities = ("velocity", "position", "moveTo", "recenter", "wake")
    mode = "follow"

    def __init__(
        self,
        address: str | None = None,
        timeout: float = 15.0,
        transport_factory: Callable[[str, float], BleTransport] = _BleakTransport,
        max_joystick: str | int | None = None,
        scanner: Callable[[float], Awaitable[list[dict[str, object]]]] | None = bleak_scan,
    ) -> None:
        # None is allowed: the bridge's gimbal selector (gimbal_select.py) supplies the address (the saved choice,
        # DJI_RS3_BLE_ADDRESS, or the strongest DJI gimbal in range) through set_address() before the first connect.
        self.address = address
        self._transport_factory = transport_factory
        self._scanner = scanner
        configured = max_joystick if max_joystick is not None else os.environ.get(MAX_JOYSTICK_ENV)
        self.max_joystick = resolve_max_joystick(configured)
        log.info(
            "RS3 %s max joystick gain %d (%s; safe range %d..%d)",
            self.address or "(gimbal not chosen yet)",
            self.max_joystick,
            "built-in default" if configured is None else f"from {MAX_JOYSTICK_ENV}",
            MIN_MAX_JOYSTICK,
            MAX_MAX_JOYSTICK,
        )
        self.timeout = timeout
        self._transport: BleTransport | None = None
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
        # Link health, reported to the app (see link_health): recent drops, and the frames accepted and
        # discarded as corrupt in the last minute. Corrupt frames are what a weak Bluetooth signal looks like
        # before the link actually drops.
        self._drop_times: deque[float] = deque(maxlen=50)
        self._frame_events: deque[tuple[float, bool]] = deque(maxlen=4000)
        self._linked_at = 0.0
        # The gimbal's own sleep report (0x04/0x27): True asleep, False awake, None not reported on this link yet.
        self.asleep: Optional[bool] = None
        self._census_on = os.environ.get(CENSUS_ENV, "1").strip() not in ("0", "false", "off", "")
        self._census_counts: dict[tuple[int, int, int, int], int] = {}
        self._census_last: dict[tuple[int, int], bytes] = {}
        self._census_logged_at = monotonic()
        self._read_failures = 0
        self._closing = False
        self._had_link = False
        self._logged_at: dict[str, float] = {}
        self.connected = False
        if self.address:
            self._make_transport()

    def _make_transport(self) -> None:
        self._transport = self._transport_factory(self.address, self.timeout)
        with contextlib.suppress(AttributeError):
            self._transport.on_disconnect = self._on_link_lost

    @property
    def linked_name(self) -> str | None:
        """The advertised name of the gimbal this driver connects to (seen by its last connect), if known."""
        name = getattr(self._transport, "name", None) if self._transport is not None else None
        return name if isinstance(name, str) else None

    @property
    def linked_rssi(self) -> float | None:
        rssi = getattr(self._transport, "rssi", None) if self._transport is not None else None
        return rssi if isinstance(rssi, (int, float)) and not isinstance(rssi, bool) else None

    async def scan(self, timeout: float) -> list[dict[str, object]]:
        """Advertising BLE devices nearby (the bridge keeps the DJI gimbals). The caller holds the BLE lock."""
        if self._scanner is None:
            raise NotSupported("this driver has no Bluetooth scanner")
        return await self._scanner(timeout)

    async def set_address(self, address: str | None) -> None:
        """Drive a different gimbal: stop and drop the current link (a DJI gimbal accepts one connection), then
        point at `address`; maintain_gimbal() connects it. None leaves the driver with no gimbal."""
        if address == self.address and (address is None or self._transport is not None):
            return
        await self.close()
        self.address = address
        self._transport = None
        self._had_link = False
        self._linked_at = 0.0
        self._drop_times.clear()
        self._frame_events.clear()
        self.asleep = None
        if address:
            self._make_transport()
        log.warning("RS3 driver now set to gimbal %s", address or "(none)")

    async def connect(self) -> None:
        if not self.address or self._transport is None:
            raise GimbalError("no gimbal selected yet (choose one with POST /gimbal, or set DJI_RS3_BLE_ADDRESS)")
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
        self._linked_at = monotonic()
        self.asleep = None  # a new link has not reported its sleep state yet
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

    async def wake(self) -> None:
        """Ask a sleeping gimbal to switch its motors back on (operator-initiated only, never automatic).

        Documented upstream (jdesbonnet/dji_rs3_control rs3_ble_protocol_spec.md 6.4, rev 689884f):
        cmd_set 0x04, cmd_id 0x0f, payload 23 01 00 = wake (23 01 01 would be sleep). Confirmed there on an
        RS3, not on an RS3 Pro, and unknown for a gimbal stopped by motor protection. Whether it worked is
        read from the gimbal's own 0x04/0x27 sleep report; `asleep` is never set here.
        """
        if not self.connected:
            raise GimbalError("RS3 is not connected")
        await self._write(0x04, 0x0F, WAKE_PAYLOAD, receiver=0x04)

    async def set_mode(self, mode: str) -> None:
        raise NotSupported("set_mode is not implemented for dji-rs3-ble")

    def _joystick(self, value: float) -> int:
        return round(max(-1.0, min(1.0, value)) * self.max_joystick)

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
        if was_connected and not self._closing:
            self._drop_times.append(monotonic())
        self.connected = False
        self._pose = None
        self._unconfirmed = None
        self._rx.clear()
        self._read_failures = 0
        self._wake_waiters()
        if was_connected and not self._closing:
            self._throttled_warning("link-lost", "RS3 %s link lost: %s — reconnecting", self.address, reason)

    def link_health(self) -> dict[str, float | int | None]:
        """How well the Bluetooth link is holding up: drops in the last 10 minutes and the share of frames
        that arrived corrupt in the last minute. Raw numbers only; the app decides what counts as weak."""
        now = monotonic()
        recent = [ok for at, ok in self._frame_events if now - at <= 60.0]
        corrupt = sum(1 for ok in recent if not ok)
        return {
            "drops10m": sum(1 for at in self._drop_times if now - at <= 600.0),
            "framesLastMin": len(recent),
            "corruptLastMin": corrupt,
            "linkedForS": round(now - self._linked_at) if self.connected and self._linked_at else None,
        }

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
            self._observe(frame)
            pose = _pose_from_frame(frame)
            if pose is None or not self._plausible(pose):
                continue
            self._pose = pose
            self._pose_at = monotonic()
            self._pose_seq += 1
            self._wake_waiters()

    def _observe(self, frame: bytes) -> None:
        """Every valid frame: pick up the sleep report, and feed the census. Never raises."""
        try:
            sender, receiver, cmd_set, cmd_id = frame[4], frame[5], frame[9], frame[10]
            payload = frame[11:-2]
            if (cmd_set, cmd_id) == SLEEP_STATUS and payload:
                asleep = payload[-1] == 0x01
                if asleep != self.asleep:
                    log.warning("RS3 %s reports it is %s", self.address, "ASLEEP" if asleep else "awake")
                self.asleep = asleep
            if not self._census_on:
                return
            key = (sender, receiver, cmd_set, cmd_id)
            first = key not in self._census_counts
            self._census_counts[key] = self._census_counts.get(key, 0) + 1
            if first:
                log.info("census RS3 %s first %02x>%02x %02x/%02x len=%d payload=%s",
                         self.address, sender, receiver, cmd_set, cmd_id, len(payload), payload[:64].hex())
            short = (cmd_set, cmd_id)
            if short in CENSUS_WATCH and self._census_last.get(short) != payload:
                if not first:
                    log.info("census RS3 %s change %02x/%02x payload=%s", self.address, cmd_set, cmd_id, payload[:64].hex())
                self._census_last[short] = payload
            now = monotonic()
            if now - self._census_logged_at >= CENSUS_SUMMARY_S:
                self._census_logged_at = now
                summary = " ".join(f"{k[2]:02x}/{k[3]:02x}:{v}" for k, v in sorted(self._census_counts.items()))
                log.info("census RS3 %s last %ds asleep=%s counts %s", self.address, int(CENSUS_SUMMARY_S), self.asleep, summary)
                self._census_counts = {k: 0 for k in self._census_counts}
        except Exception:  # noqa: BLE001 - observation must never break the link
            pass

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
                self._frame_events.append((monotonic(), False))
                self._throttled_warning(
                    "bad-crc",
                    "RS3 %s resynced past a bad checksum (%d discarded, %d frames accepted)",
                    self.address, self._discarded, self._accepted,
                )
                continue
            self._accepted += 1
            self._frame_events.append((monotonic(), True))
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
