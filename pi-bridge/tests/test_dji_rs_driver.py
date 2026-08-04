import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))

from drivers.dji_rs_driver import DjiRsDriver, _frame


class FakeTransport:
    def __init__(self, _address, _timeout):
        self.callback = None
        self.frames = []
        self.disconnected = False

    async def connect(self): pass
    async def disconnect(self): self.disconnected = True
    async def start_notifications(self, callback): self.callback = callback
    async def stop_notifications(self): pass

    async def write(self, frame):
        self.frames.append(frame)
        if frame[9:11] == b"\x04\x12":
            payload = b"\0" + b"\x22\x02\x85\xff\x23\x02\x1e\0\x24\x02\xc8\0"
            await self.callback(_frame(1, 0x04, 0x66, payload))


def payload(frame):
    return frame[11:-2]


class DjiRsDriverTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.transport = FakeTransport(None, None)
        self.driver = DjiRsDriver("34:D2:62:15:A5:47", transport_factory=lambda *_: self.transport)
        await self.driver.connect()

    async def test_velocity_maps_normalized_pan_tilt_roll_to_rs3_axes(self):
        await self.driver.move_velocity(0.5, -0.25, 1.0)
        self.assertEqual(payload(self.transport.frames[-1]), b"\xec\x03\x50\x04\x28\x04\0\0\x02")

    async def test_active_pose_poll_translates_tilt_roll_pan_to_attitude(self):
        pose = await self.driver.get_position()
        self.assertEqual((pose.yaw, pose.pitch, pose.roll), (20.0, -12.3, 3.0))
        self.assertEqual(self.transport.frames[-1][9:11], b"\x04\x12")
        self.assertEqual(self.transport.frames[-1][5], 0xE5)

    async def test_stop_and_close_send_rate_stop_and_neutral_frames(self):
        await self.driver.close()
        self.assertTrue(self.transport.disconnected)
        self.assertEqual([frame[9:11] for frame in self.transport.frames[-4:]], [b"\x04\x0c", b"\x04\x01", b"\x04\x01", b"\x04\x01"])
        self.assertTrue(all(payload(frame) == b"\0\x04\0\x04\0\x04\0\0\x02" for frame in self.transport.frames[-3:]))
