"""Driver interface for gimbal hardware adapters."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Protocol


class GimbalError(Exception):
    """Generic SDK / transport error."""


class NotSupported(Exception):
    """Capability not advertised or not implemented by this driver."""


@dataclass
class Attitude:
    yaw: float
    pitch: float
    roll: float


class GimbalDriver(Protocol):
    """Minimal contract every driver must satisfy.

    Capabilities advertise to the app what the bridge can do. The bridge
    refuses methods outside the advertised set.
    """

    name: str
    model: str
    capabilities: Iterable[str]
    connected: bool
    mode: str

    async def connect(self) -> None: ...
    async def close(self) -> None: ...

    async def move_velocity(self, pan: float, tilt: float, roll: float) -> None: ...
    async def stop(self) -> None: ...
    async def get_position(self) -> Attitude: ...
    async def move_to(self, yaw: float, pitch: float, roll: float, speed: float) -> None: ...
    async def recenter(self) -> None: ...
    async def set_mode(self, mode: str) -> None: ...
    # Optional: drivers that advertise the "wake" capability also implement
    # `async def wake(self) -> None` (switch a sleeping gimbal's motors back on).
    # Optional: drivers that advertise the "sleep" capability also implement
    # `async def sleep(self) -> None` (put the gimbal to sleep; operator-initiated only).
