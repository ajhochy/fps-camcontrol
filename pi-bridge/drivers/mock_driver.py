"""Mock driver: integrates velocity into attitude over real time.

Useful for running the bridge on a dev box before the Pi/CAN/gimbal exist,
and as the ground truth for the smoke test on the app side.
"""

from __future__ import annotations

import asyncio
import time

from .base import Attitude, GimbalDriver, NotSupported

FULL_SCALE_DEG_PER_SEC = 30.0


class MockDriver:
    name = "mock"
    model = "mock-RS4Pro"
    capabilities = ("velocity", "position", "moveTo", "recenter", "mode")
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

    async def set_mode(self, mode: str) -> None:
        if mode not in ("follow", "pan", "fpv", "lock"):
            raise NotSupported(f"unknown mode {mode}")
        self.mode = mode
