"""Real DJI RS SDK driver — STUB.

Implement once one of these is decided and acquired:
1. Official DJI RS SDK (download from dji.com/rs-sdk) — Linux shared library
   if available, else implement the documented CAN protocol directly from
   the "RS Stabilizer External Interface Diagram" PDF.
2. ConstantRobotics/DJIR_SDK fork ported to SocketCAN (license review
   required before vendoring).

Hardware expected on the Pi (per docs/dji-gimbal-spec.md §12.8):
- PiCAN3 HAT on can0 at 1 Mbit, OR CANable Pro USB dongle as can0.
- 4-pin GH1.25 pigtail to gimbal RSA port.

Bring-up procedure:
    sudo ip link set can0 up type can bitrate 1000000
    candump can0      # verify gimbal frames are visible
    python3 dji_bridge.py --driver dji-rs-sdk --can-iface can0
"""

from __future__ import annotations

from .base import Attitude, GimbalError, NotSupported


class DjiRsDriver:
    name = "dji-rs-sdk"
    model = "RS4Pro"  # informational; override from config when known
    capabilities = ("velocity", "position", "moveTo")
    connected = False
    mode = "follow"

    def __init__(self, can_iface: str = "can0", bitrate: int = 1_000_000) -> None:
        self.can_iface = can_iface
        self.bitrate = bitrate

    async def connect(self) -> None:
        raise GimbalError(
            "DjiRsDriver is a stub. Implement against the DJI RS SDK or a "
            "SocketCAN port of DJIR_SDK before running with --driver dji-rs-sdk."
        )

    async def close(self) -> None:
        self.connected = False

    async def move_velocity(self, pan: float, tilt: float, roll: float) -> None:
        raise NotSupported("dji-rs-sdk driver not implemented")

    async def stop(self) -> None:
        raise NotSupported("dji-rs-sdk driver not implemented")

    async def get_position(self) -> Attitude:
        raise NotSupported("dji-rs-sdk driver not implemented")

    async def move_to(self, yaw: float, pitch: float, roll: float, speed: float) -> None:
        raise NotSupported("dji-rs-sdk driver not implemented")

    async def recenter(self) -> None:
        raise NotSupported("dji-rs-sdk driver not implemented")

    async def set_mode(self, mode: str) -> None:
        raise NotSupported("dji-rs-sdk driver not implemented")
