import asyncio
import sys
import unittest
from pathlib import Path
from time import monotonic

sys.path.insert(0, str(Path(__file__).parents[1]))

from drivers.base import GimbalError
from drivers.dji_rs_driver import (
    ATTITUDE_SUBSCRIBE_PAYLOAD,
    MAX_POSE_AGE_S,
    DjiRsDriver,
    _BleakTransport,
    _frame,
)

# The two payloads the driver used to cycle alongside the attitude subscribe.
# Measured on a live RS3 and RS3 Pro: each of these switches the ~1 Hz attitude
# push OFF, which is why position reads went stale (issue #17). Nothing may send
# them again.
PUSH_CANCELLING_PAYLOADS = (
    bytes.fromhex("660cc01d108401000e000c000050000000000000000010"),
    bytes.fromhex("660cc01d103e010000000c000050"),
)
DEFAULT_TENTHS = {0x22: -123, 0x23: 30, 0x24: 200}  # pitch, roll, yaw


def pose_frame(tenths=None, sequence=1):
    """Build a 0x04/0x66 attitude frame the way the gimbal really does."""
    fields = dict(DEFAULT_TENTHS if tenths is None else tenths)
    payload = b"\x01" + b"".join(
        bytes((tag, 2)) + value.to_bytes(2, "little", signed=True) for tag, value in sorted(fields.items())
    )
    return _frame(sequence, 0x04, 0x66, payload)


def corrupt(frame):
    """Same frame with a flipped payload byte, so the CRC-16 no longer matches."""
    broken = bytearray(frame)
    broken[12] ^= 0xFF
    return bytes(broken)


class FakeTransport:
    def __init__(self, _address=None, _timeout=None):
        self.callback = None
        self.frames = []
        self.disconnected = False
        self.connects = 0
        self.calls = []
        self.on_disconnect = None
        self.answer_subscribes = True
        self.tenths = dict(DEFAULT_TENTHS)
        self.write_error = None

    async def connect(self):
        self.connects += 1
        self.calls.append("connect")
        self.disconnected = False

    async def disconnect(self):
        self.calls.append("disconnect")
        self.disconnected = True

    async def start_notifications(self, callback):
        self.callback = callback

    async def stop_notifications(self):
        pass

    async def write(self, frame):
        self.frames.append(frame)
        if self.write_error is not None:
            raise self.write_error
        if frame[9:11] == b"\x04\x12" and self.answer_subscribes:
            await self.push(pose_frame(self.tenths))

    async def push(self, data):
        await self.callback(data)

    def drop(self):
        """What bleak's disconnected_callback does when the peer goes away."""
        self.disconnected = True
        if self.on_disconnect is not None:
            self.on_disconnect()


def payload(frame):
    return frame[11:-2]


class DjiRsDriverTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.transport = FakeTransport(None, None)
        self.driver = DjiRsDriver("34:D2:62:15:A5:47", transport_factory=lambda *_: self.transport)
        await self.driver.connect()

    def go_quiet(self):
        """Telemetry has stopped: nothing answers and nothing recent is cached."""
        self.transport.answer_subscribes = False
        self.driver._pose_at -= MAX_POSE_AGE_S + 1.0

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

    # --- issue #15: a dropped link must be noticed ---------------------------

    async def test_unexpected_link_loss_clears_connected(self):
        self.transport.drop()
        self.assertFalse(self.driver.connected, "maintain_gimbal only retries when connected is False")

    async def test_read_fails_fast_when_the_link_drops_mid_read(self):
        self.go_quiet()
        self.driver.timeout = 5.0
        read = asyncio.create_task(self.driver.get_position())
        await asyncio.sleep(0.05)
        started = monotonic()
        self.transport.drop()
        with self.assertRaises(GimbalError):
            await asyncio.wait_for(read, timeout=1.0)
        self.assertLess(monotonic() - started, 0.5, "getPosition must not hang out the full timeout")

    async def test_write_failure_that_means_the_link_is_gone_marks_it_down(self):
        class BleakError(Exception):
            pass

        BleakError.__module__ = "bleak.exc"
        self.transport.write_error = BleakError("Service Discovery has not been performed yet")
        with self.assertRaises(GimbalError):
            await self.driver.move_velocity(0.1, 0.0, 0.0)
        self.assertFalse(self.driver.connected)

    async def test_repeated_silent_reads_mark_the_link_down(self):
        self.go_quiet()
        self.driver.timeout = 0.1
        for _ in range(3):
            with self.assertRaises(GimbalError):
                await self.driver.get_position()
        self.assertFalse(self.driver.connected, "a wedged link must not stay connected forever")

    async def test_commands_on_a_lost_link_fail_instead_of_pretending(self):
        self.transport.drop()
        with self.assertRaises(GimbalError):
            await self.driver.get_position()
        with self.assertRaises(GimbalError):
            await self.driver.move_velocity(0.1, 0.0, 0.0)

    async def test_reconnect_rebuilds_the_transport_and_forgets_the_old_pose(self):
        await self.driver.get_position()
        self.transport.drop()
        self.transport.answer_subscribes = False
        await self.driver.connect()
        self.assertTrue(self.driver.connected)
        self.assertEqual(self.transport.connects, 2)
        # BlueZ can hold the ACL open after the peer vanishes, and only an explicit
        # disconnect releases it. Without this the gimbal stops advertising and no
        # later scan can find it — a link that never comes back.
        self.assertEqual(self.transport.calls[-2:], ["disconnect", "connect"])
        self.driver.timeout = 0.2
        with self.assertRaises(GimbalError):
            await self.driver.get_position()  # must not serve the pre-drop pose

    # --- issue #17: reads must be fresh and validated -----------------------

    async def test_get_position_never_returns_a_pose_sampled_before_a_command(self):
        """The stale read that started issue #17: a commanded move showed up only
        on the *next* getPosition, because the pose predating it was served."""
        await self.driver.get_position()
        self.transport.answer_subscribes = False  # no new push yet
        await self.driver.move_velocity(0.2, 0.0, 0.0)
        self.driver.timeout = 0.3
        with self.assertRaises(GimbalError):
            await self.driver.get_position()
        self.assertEqual(self.driver._pose.yaw, 20.0, "cached, but deliberately withheld")

        # Once a push lands after the move, that value is served straight away.
        await self.transport.push(pose_frame({0x22: 0, 0x23: 0, 0x24: 219}))
        pose = await self.driver.get_position()
        self.assertEqual(pose.yaw, 21.9)

    async def test_get_position_refuses_to_serve_stale_telemetry(self):
        await self.driver.get_position()
        self.go_quiet()  # telemetry stalled longer ago than MAX_POSE_AGE_S
        self.driver.timeout = 0.3
        with self.assertRaises(GimbalError):
            await self.driver.get_position()

    async def test_an_idle_gimbal_answers_from_the_latest_push(self):
        """Attitude is a ~1 Hz push, so waiting for the *next* one would add up to
        a second to every read and blow the app's 1 s getPosition timeout."""
        await self.driver.get_position()
        self.transport.answer_subscribes = False
        started = monotonic()
        pose = await self.driver.get_position()
        self.assertEqual(pose.yaw, 20.0)
        self.assertLess(monotonic() - started, 0.2)

    async def test_reads_only_ever_send_the_attitude_subscribe_payload(self):
        await self.driver.get_position()
        self.driver.timeout = 0.2
        self.go_quiet()
        with self.assertRaises(GimbalError):
            await self.driver.get_position()
        sent = [payload(frame) for frame in self.transport.frames if frame[9:11] == b"\x04\x12"]
        self.assertTrue(sent)
        for candidate in sent:
            self.assertEqual(candidate, ATTITUDE_SUBSCRIBE_PAYLOAD)
            self.assertNotIn(candidate, PUSH_CANCELLING_PAYLOADS)

    async def test_a_garbled_frame_is_rejected_rather_than_parsed_as_pose(self):
        before = self.driver._pose_seq
        await self.transport.push(corrupt(pose_frame({0x22: 0, 0x23: 0, 0x24: 121})))
        self.assertEqual(self.driver._pose_seq, before, "bad checksum must not update the pose")
        await self.transport.push(pose_frame({0x22: 0, 0x23: 0, 0x24: 210}))
        self.assertEqual(self.driver._pose_seq, before + 1)
        self.assertEqual(self.driver._pose.yaw, 21.0)

    async def test_junk_on_the_wire_is_rejected_and_the_stream_resyncs(self):
        before = self.driver._pose_seq
        # A plausible-looking header (0x55, length 14, valid header CRC-8) whose
        # body is nonsense: exactly what the old parser would have parsed.
        await self.transport.push(b"\x55\x0e\x04\x66junkjunkjunk")
        self.assertEqual(self.driver._pose_seq, before)
        await self.transport.push(pose_frame({0x22: 0, 0x23: 0, 0x24: 210}))
        self.assertEqual(self.driver._pose_seq, before + 1, "the parser must recover after junk")
        self.assertEqual(self.driver._pose.yaw, 21.0)

    async def test_a_frame_split_across_notifications_is_reassembled(self):
        before = self.driver._pose_seq
        frame = pose_frame({0x22: 0, 0x23: 0, 0x24: 210})
        await self.transport.push(frame[:9])
        self.assertEqual(self.driver._pose_seq, before, "half a frame is not a pose")
        await self.transport.push(frame[9:])
        self.assertEqual(self.driver._pose_seq, before + 1)
        self.assertEqual(self.driver._pose.yaw, 21.0)

    async def test_several_frames_in_one_notification_are_all_parsed(self):
        before = self.driver._pose_seq
        blob = pose_frame({0x22: 0, 0x23: 0, 0x24: 205}) + pose_frame({0x22: 0, 0x23: 0, 0x24: 210})
        await self.transport.push(blob)
        self.assertEqual(self.driver._pose_seq, before + 2)
        self.assertEqual(self.driver._pose.yaw, 21.0)

    async def test_an_implausible_jump_needs_a_second_frame_to_agree(self):
        await self.transport.push(pose_frame({0x22: 0, 0x23: 0, 0x24: 60}))
        self.assertEqual(self.driver._pose.yaw, 6.0)
        await self.transport.push(pose_frame({0x22: 0, 0x23: 0, 0x24: 1210}))
        self.assertEqual(self.driver._pose.yaw, 6.0, "a lone wild reading is not a position")
        await self.transport.push(pose_frame({0x22: 0, 0x23: 0, 0x24: 1210}))
        self.assertEqual(self.driver._pose.yaw, 121.0, "but a corroborated one is")

    async def test_real_gimbal_movement_is_not_mistaken_for_a_bad_read(self):
        await self.transport.push(pose_frame({0x22: 0, 0x23: 0, 0x24: 60}))
        for tenths in range(70, 260, 10):  # a real pan, one push apart
            await self.transport.push(pose_frame({0x22: 0, 0x23: 0, 0x24: tenths}))
        self.assertEqual(self.driver._pose.yaw, 25.0)


class BleakTransportTests(unittest.IsolatedAsyncioTestCase):
    """The bleak-backed transport, exercised without bleak installed."""

    def setUp(self):
        self.transport = _BleakTransport("34:D2:62:15:A5:47", 15.0)
        self.transport.client = object()
        self.transport.linked = True

    async def test_a_dropped_link_keeps_the_client_so_bluez_can_be_released(self):
        seen = []
        self.transport.on_disconnect = lambda: seen.append(True)
        self.transport._disconnected(self.transport.client)
        self.assertFalse(self.transport.linked)
        self.assertIsNotNone(self.transport.client, "the client is what releases the BlueZ link")
        self.assertEqual(seen, [True], "the driver must be told")

    async def test_writes_on_a_dropped_link_fail_instead_of_touching_a_dead_client(self):
        self.transport._disconnected(self.transport.client)
        with self.assertRaises(GimbalError):
            await self.transport.write(b"\x55")
        with self.assertRaises(GimbalError):
            await self.transport.start_notifications(lambda _data: None)


if __name__ == "__main__":
    unittest.main()
