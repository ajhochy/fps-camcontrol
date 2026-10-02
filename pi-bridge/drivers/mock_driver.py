"""Mock driver: integrates velocity into attitude over real time.

Useful for running the bridge on a dev box before the Pi/CAN/gimbal exist,
and as the ground truth for the smoke test on the app side.
"""

from __future__ import annotations

import asyncio
import time

from .base import Attitude, GimbalDriver, NotSupported

FULL_SCALE_DEG_PER_SEC = 30.0
# Fake Bluetooth neighbourhood for --driver mock: two DJI gimbals and a phone (which must never be offered).
MOCK_NEARBY = (
    {"address": "AA:00:00:00:00:01", "name": "DJI RS3 PRO-MOCK01", "rssi": -52},
    {"address": "AA:00:00:00:00:02", "name": "DJI RS3-MOCK02", "rssi": -74},
    {"address": "AA:00:00:00:00:03", "name": "Someone's phone", "rssi": -40},
)


class MockDriver:
    name = "mock"
    model = "mock-RS4Pro"
    capabilities = ("velocity", "position", "moveTo", "recenter", "mode", "wake")
    connected = False
    mode = "follow"

    def __init__(self) -> None:
        self._yaw = 0.0
        self._pitch = 0.0
        self._roll = 0.0
        self._vel_pan = 0.0
        self._vel_tilt = 0.0
        self._vel_roll = 0.0
        self._last = time.monotonic()
        self._lock = asyncio.Lock()
        self.asleep: bool | None = None
        self.wakes = 0
        # Bluetooth gimbal selection, simulated: which fake gimbal this "bridge" drives, and what a scan hears.
        self.address: str | None = None
        self.nearby = [dict(g) for g in MOCK_NEARBY]
        self.scans = 0

    @property
    def linked_name(self) -> str | None:
        return next((g["name"] for g in self.nearby if g["address"] == self.address), None)

    @property
    def linked_rssi(self) -> float | None:
        return next((g["rssi"] for g in self.nearby if g["address"] == self.address), None)

    async def scan(self, timeout: float) -> list[dict[str, object]]:
        """What a BLE scan hears: every nearby device except the one linked to us (a linked gimbal stops advertising)."""
        self.scans += 1
        await asyncio.sleep(min(timeout, 0.05))
        return [dict(g) for g in self.nearby if not (self.connected and g["address"] == self.address)]

    async def set_address(self, address: str | None) -> None:
        if address == self.address:
            return
        await self.stop()
        self.connected = False
        self.address = address

    async def connect(self) -> None:
        self.connected = True

    async def close(self) -> None:
        self.connected = False

    def _integrate(self) -> None:
        now = time.monotonic()
        dt = now - self._last
        self._last = now
        self._yaw += self._vel_pan * FULL_SCALE_DEG_PER_SEC * dt
        self._pitch += self._vel_tilt * FULL_SCALE_DEG_PER_SEC * dt
        self._roll += self._vel_roll * FULL_SCALE_DEG_PER_SEC * dt

    async def move_velocity(self, pan: float, tilt: float, roll: float) -> None:
        async with self._lock:
            self._integrate()
            self._vel_pan = max(-1.0, min(1.0, pan))
            self._vel_tilt = max(-1.0, min(1.0, tilt))
            self._vel_roll = max(-1.0, min(1.0, roll))

    async def stop(self) -> None:
        async with self._lock:
            self._integrate()
            self._vel_pan = 0.0
            self._vel_tilt = 0.0
            self._vel_roll = 0.0

    async def get_position(self) -> Attitude:
        async with self._lock:
            self._integrate()
            return Attitude(yaw=self._yaw, pitch=self._pitch, roll=self._roll)

    async def move_to(self, yaw: float, pitch: float, roll: float, speed: float) -> None:
        async with self._lock:
            self._integrate()
            self._vel_pan = 0.0
            self._vel_tilt = 0.0
            self._vel_roll = 0.0
            self._yaw = yaw
            self._pitch = pitch
            self._roll = roll

    async def recenter(self) -> None:
        await self.move_to(0.0, 0.0, 0.0, 0.5)

    async def wake(self) -> None:
        self.wakes += 1
        if self.asleep:
            self.asleep = False

    async def set_mode(self, mode: str) -> None:
        if mode not in ("follow", "pan", "fpv", "lock"):
            raise NotSupported(f"unknown mode {mode}")
        self.mode = mode
