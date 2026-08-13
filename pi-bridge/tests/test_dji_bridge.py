import asyncio
import json
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))


class ConnectionClosed(Exception):
    pass


websockets = types.ModuleType("websockets")
websockets.exceptions = types.SimpleNamespace(ConnectionClosed=ConnectionClosed)
server = types.ModuleType("websockets.server")
server.WebSocketServerProtocol = object
websockets.server = server
sys.modules["websockets"] = websockets
sys.modules["websockets.server"] = server

import dji_bridge
from dji_bridge import Session, maintain_gimbal


class AbruptSocket:
    remote_address = "test"

    def __aiter__(self):
        return self

    async def __anext__(self):
        raise ConnectionClosed()


class Driver:
    connected = True
    mode = "follow"
    model = "test"
    capabilities = ()

    def __init__(self):
        self.stops = 0

    async def stop(self):
        self.stops += 1


class IdleSocket:
    """Stays open (so the status loop runs) and records what was sent."""

    remote_address = "test"

    def __init__(self):
        self.sent = []

    def __aiter__(self):
        return self

    async def __anext__(self):
        await asyncio.sleep(3600)

    async def send(self, raw):
        self.sent.append(json.loads(raw))


class DeadLinkDriver:
    """A gimbal whose BLE link has gone away: reads fail, stop is a no-op."""

    mode = "follow"
    model = "RS3"
    capabilities = ()
    connected = False

    async def get_position(self):
        raise RuntimeError("RS3 is not connected")

    async def stop(self):
        pass


class SessionTests(unittest.IsolatedAsyncioTestCase):
    async def test_abrupt_connection_close_stops_driver_without_escaping(self):
        driver = Driver()
        await Session(AbruptSocket(), driver, 250).run()
        self.assertEqual(driver.stops, 1)

    async def test_status_still_reports_a_gimbal_whose_link_is_gone(self):
        """A failed read used to skip the status event entirely, so the app never
        learned that the gimbal had dropped — it just saw stale position data."""
        original = dji_bridge.STATUS_INTERVAL_S
        dji_bridge.STATUS_INTERVAL_S = 0.01
        try:
            ws = IdleSocket()
            task = asyncio.create_task(Session(ws, DeadLinkDriver(), 250).run())
            for _ in range(200):
                await asyncio.sleep(0.01)
                if any(frame.get("method") == "status" for frame in ws.sent):
                    break
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        finally:
            dji_bridge.STATUS_INTERVAL_S = original
        statuses = [frame for frame in ws.sent if frame.get("method") == "status"]
        self.assertTrue(statuses, "status must be emitted even when the position read fails")
        self.assertFalse(statuses[0]["params"]["gimbalConnected"])
        self.assertNotIn("position", statuses[0]["params"], "no position is better than a stale one")


class FlakyDriver:
    """Fails `fail_times` connects, then succeeds — like a gimbal being switched on."""

    mode = "follow"
    model = "RS3"
    capabilities = ()

    def __init__(self, fail_times):
        self.fail_times = fail_times
        self.attempts = 0
        self.connected = False

    async def connect(self):
        self.attempts += 1
        if self.attempts <= self.fail_times:
            raise RuntimeError("[org.bluez.Error.InProgress] Operation already in progress")
        self.connected = True

    async def stop(self):
        pass


class MaintainGimbalTests(unittest.IsolatedAsyncioTestCase):
    """A gimbal that is off (or racing another connect) must NOT kill the bridge.

    Regression: serve() used to await driver.connect() before binding the WS
    listener, so an absent gimbal crash-looped the process and the port never
    opened — the app then saw "connection refused" and a healthy Pi looked dead.
    """

    def setUp(self):
        self._orig = (dji_bridge.GIMBAL_RETRY_MIN_S, dji_bridge.GIMBAL_RETRY_MAX_S, dji_bridge.GIMBAL_POLL_S)
        dji_bridge.GIMBAL_RETRY_MIN_S = 0.01
        dji_bridge.GIMBAL_RETRY_MAX_S = 0.02
        dji_bridge.GIMBAL_POLL_S = 0.01

    def tearDown(self):
        (dji_bridge.GIMBAL_RETRY_MIN_S, dji_bridge.GIMBAL_RETRY_MAX_S, dji_bridge.GIMBAL_POLL_S) = self._orig

    async def test_retries_until_gimbal_appears_without_raising(self):
        driver = FlakyDriver(fail_times=3)
        task = asyncio.create_task(maintain_gimbal(driver))
        for _ in range(200):
            if driver.connected:
                break
            await asyncio.sleep(0.01)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        self.assertTrue(driver.connected, "should eventually connect once the gimbal appears")
        self.assertGreater(driver.attempts, 3, "should have retried past the failures")

    async def test_link_lost_after_a_good_connect_is_reconnected(self):
        """Issue #15: the RS3 slept mid-service, `connected` stayed True, and the
        maintainer never retried — it stayed dead until systemctl restart."""
        driver = FlakyDriver(fail_times=0)
        task = asyncio.create_task(maintain_gimbal(driver))
        for _ in range(200):
            await asyncio.sleep(0.01)
            if driver.connected:
                break
        self.assertEqual(driver.attempts, 1)

        driver.connected = False  # what the BLE disconnect callback does
        for _ in range(200):
            await asyncio.sleep(0.01)
            if driver.attempts > 1:
                break
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        self.assertEqual(driver.attempts, 2, "a dropped link must be reconnected without a restart")
        self.assertTrue(driver.connected)

    async def test_connect_failure_never_propagates(self):
        driver = FlakyDriver(fail_times=10**6)  # never succeeds
        task = asyncio.create_task(maintain_gimbal(driver))
        await asyncio.sleep(0.1)
        self.assertFalse(task.done(), "maintainer must keep running, not die, when the gimbal is absent")
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
