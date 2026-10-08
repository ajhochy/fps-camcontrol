"""Choosing which Bluetooth gimbal a bridge drives (gimbal_select.py, and its HTTP routes in dji_bridge.py).

One Pi per gimbal, but every Pi hears every DJI gimbal in the room and a gimbal takes one connection only. These
pin: the saved choice wins and survives restarts; AUTO takes the strongest DJI gimbal once and then never drifts;
switching drops the old link before the new one; scans happen only when asked or while unlinked; GET never switches.
"""

import asyncio
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))


class ConnectionClosed(Exception):
    pass


# websockets is stubbed, as in test_dji_bridge.py, so the suite runs without it installed.
if "websockets" not in sys.modules:
    websockets = types.ModuleType("websockets")
    websockets.exceptions = types.SimpleNamespace(ConnectionClosed=ConnectionClosed)
    server = types.ModuleType("websockets.server")
    server.WebSocketServerProtocol = object
    websockets.server = server
    sys.modules["websockets"] = websockets
    sys.modules["websockets.server"] = server

import dji_bridge  # noqa: E402
import gimbal_select  # noqa: E402
from drivers.base import GimbalError  # noqa: E402
from drivers.dji_rs_driver import DjiRsDriver  # noqa: E402
from drivers.mock_driver import MockDriver  # noqa: E402
from gimbal_select import GimbalSelector, SelectionError, SelectionStore, normalize_address, pick_strongest  # noqa: E402

TRIPOD = "48:1C:B9:54:C6:BC"
CENTER = "48:1C:B9:56:31:95"
FAR_RIGHT = "34:D2:62:15:A5:47"


class FakeLock:
    def __init__(self):
        self.held = 0
        self.max_held = 0
        self.acquired = 0

    async def acquire(self):
        self.held += 1
        self.acquired += 1
        self.max_held = max(self.max_held, self.held)
        return self

    def release(self, _token):
        self.held -= 1


class RoomDriver(MockDriver):
    """The mock driver in a room with the three real gimbals (addresses as deployed)."""

    def __init__(self, nearby=None):
        super().__init__()
        self.nearby = nearby if nearby is not None else [
            {"address": TRIPOD, "name": "DJI RS3 PRO-0614BW", "rssi": -48},
            {"address": CENTER, "name": "DJI RS3 PRO-0613YW", "rssi": -66},
            {"address": FAR_RIGHT, "name": "DJI RS3-06UH13", "rssi": -80},
            {"address": "11:22:33:44:55:66", "name": "iPhone", "rssi": -30},
        ]
        self.stops = 0
        self.address_history = []

    async def stop(self):
        self.stops += 1
        await super().stop()

    async def set_address(self, address):
        self.address_history.append(address)
        await super().set_address(address)


class SelectorCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "gimbal.json")
        self.store = SelectionStore(self.path)
        self.lock = FakeLock()
        self._settle = gimbal_select.RELEASE_SETTLE_S
        gimbal_select.RELEASE_SETTLE_S = 0.0

    def tearDown(self):
        gimbal_select.RELEASE_SETTLE_S = self._settle
        self.tmp.cleanup()

    def selector(self, driver, configured=None):
        return GimbalSelector(driver, self.store, configured, self.lock.acquire, self.lock.release)

    def saved(self):
        with open(self.path) as fh:
            return json.load(fh)


class HelperTests(unittest.TestCase):
    def test_addresses_are_normalised_and_junk_refused(self):
        self.assertEqual(normalize_address(" 48:1c:b9:54:c6:bc "), TRIPOD)
        self.assertEqual(normalize_address("48-1C-B9-54-C6-BC"), TRIPOD)
        for junk in ("auto", "48:1C:B9:54:C6", "", None, 42, "ZZ:1C:B9:54:C6:BC"):
            self.assertIsNone(normalize_address(junk))

    def test_strongest_is_a_dji_gimbal_never_a_phone(self):
        found = [
            {"address": "11:22:33:44:55:66", "name": "iPhone", "rssi": -20},
            {"address": CENTER, "name": "DJI RS3 PRO-0613YW", "rssi": -70},
            {"address": TRIPOD, "name": "DJI RS3 PRO-0614BW", "rssi": -50},
            {"address": FAR_RIGHT, "name": None, "rssi": -10},
        ]
        self.assertEqual(pick_strongest(found)["address"], TRIPOD)
        self.assertIsNone(pick_strongest([{"address": "11:22:33:44:55:66", "name": "iPhone", "rssi": -20}]))

    def test_equal_signals_pick_deterministically(self):
        found = [{"address": TRIPOD, "name": "DJI RS3 PRO", "rssi": -60}, {"address": FAR_RIGHT, "name": "DJI RS3", "rssi": -60}]
        self.assertEqual(pick_strongest(found)["address"], FAR_RIGHT)
        self.assertEqual(pick_strongest(list(reversed(found)))["address"], FAR_RIGHT)

    def test_state_file_per_instance(self):
        self.assertTrue(gimbal_select.state_path(None, "/x").endswith("/x/gimbal.json"))
        self.assertTrue(gimbal_select.state_path("rs3pro-b", "/x").endswith("/x/gimbal-rs3pro-b.json"))


class StoreTests(SelectorCase):
    def test_round_trip_and_tolerance(self):
        self.assertIsNone(self.store.load())
        self.assertTrue(self.store.save({"address": TRIPOD, "name": "DJI RS3 PRO-0614BW", "rssi": -50, "chosenBy": "operator", "chosenAt": 1.0}))
        self.assertEqual(self.store.load()["address"], TRIPOD)
        with open(self.path, "w") as fh:
            fh.write("{not json")
        self.assertIsNone(self.store.load(), "a broken file must not crash the bridge")
        with open(self.path, "w") as fh:
            json.dump({"address": "nonsense"}, fh)
        self.assertIsNone(self.store.load())

    def test_unwritable_directory_keeps_the_choice_in_memory(self):
        store = SelectionStore(os.path.join(self.tmp.name, "missing-dir", "gimbal.json"))
        self.assertFalse(store.save({"address": TRIPOD}))


class PriorityTests(SelectorCase):
    def test_saved_choice_beats_the_env_address(self):
        self.store.save({"address": TRIPOD, "chosenBy": "operator"})
        sel = self.selector(RoomDriver(), configured=FAR_RIGHT)
        self.assertEqual(sel.address, TRIPOD)
        self.assertEqual(sel.describe_selection()["mode"], "fixed")

    def test_env_address_used_when_nothing_saved_and_not_written(self):
        sel = self.selector(RoomDriver(), configured=FAR_RIGHT.lower())
        self.assertEqual(sel.address, FAR_RIGHT)
        self.assertFalse(os.path.exists(self.path), "the env default must stay the source of truth until someone chooses")

    def test_nothing_set_means_auto(self):
        sel = self.selector(RoomDriver())
        self.assertIsNone(sel.address)
        self.assertEqual(sel.describe_selection()["mode"], "auto")


class AutoTests(SelectorCase):
    async def test_auto_picks_the_strongest_dji_gimbal_and_saves_it(self):
        driver = RoomDriver()
        sel = self.selector(driver)
        self.assertTrue(await sel.auto_pick())
        self.assertEqual(driver.address, TRIPOD)
        self.assertEqual(self.saved()["address"], TRIPOD)
        self.assertEqual(self.saved()["chosenBy"], "auto-strongest")
        self.assertEqual(self.lock.max_held, 1, "a scan must hold the BLE lock")

    async def test_a_saved_auto_pick_never_drifts_when_signals_change(self):
        await self.selector(RoomDriver()).auto_pick()
        louder_far_right = RoomDriver([
            {"address": TRIPOD, "name": "DJI RS3 PRO-0614BW", "rssi": -85},
            {"address": FAR_RIGHT, "name": "DJI RS3-06UH13", "rssi": -40},
        ])
        sel = self.selector(louder_far_right)  # the bridge restarts
        self.assertEqual(sel.address, TRIPOD)
        self.assertTrue(await sel.auto_pick())
        self.assertEqual(louder_far_right.scans, 0, "with a saved choice there is nothing to scan for")

    async def test_nothing_advertising_is_reported_not_guessed(self):
        sel = self.selector(RoomDriver(nearby=[{"address": "11:22:33:44:55:66", "name": "iPhone", "rssi": -30}]))
        self.assertFalse(await sel.auto_pick())
        self.assertIsNone(sel.address)
        self.assertIn("no DJI gimbal", sel.describe_selection()["error"])
        self.assertFalse(os.path.exists(self.path))


class SwitchTests(SelectorCase):
    async def asyncSetUp(self):
        self.driver = RoomDriver()
        self.sel = self.selector(self.driver, configured=CENTER)
        await self.driver.set_address(CENTER)
        await self.driver.connect()
        self.driver.stops = 0

    async def test_switch_stops_drops_the_link_then_points_at_the_new_gimbal(self):
        result = await self.sel.select(TRIPOD.lower())
        self.assertEqual(self.driver.address_history[-2:], [None, TRIPOD], "the old link is dropped before the new address is set")
        self.assertGreaterEqual(self.driver.stops, 1)
        self.assertFalse(self.driver.connected, "maintain_gimbal connects the new gimbal")
        self.assertEqual(result["address"], TRIPOD)
        self.assertEqual(result["chosenBy"], "operator")
        self.assertTrue(result["saved"])
        self.assertEqual(self.saved()["address"], TRIPOD)

    async def test_switch_uses_the_name_from_the_last_scan(self):
        await self.sel.scan()
        result = await self.sel.select(TRIPOD)
        self.assertEqual(result["name"], "DJI RS3 PRO-0614BW")

    async def test_auto_drops_the_link_first_so_the_current_gimbal_can_be_heard(self):
        quiet_room = RoomDriver([{"address": CENTER, "name": "DJI RS3 PRO-0613YW", "rssi": -45},
                                 {"address": FAR_RIGHT, "name": "DJI RS3-06UH13", "rssi": -80}])
        sel = self.selector(quiet_room, configured=CENTER)
        await quiet_room.set_address(CENTER)
        await quiet_room.connect()
        result = await sel.select("auto")
        self.assertEqual(result["address"], CENTER, "linked gimbals don't advertise; once released it is the strongest")
        self.assertEqual(result["chosenBy"], "auto-strongest")

    async def test_auto_with_nothing_heard_keeps_the_previous_gimbal(self):
        self.driver.nearby = []
        with self.assertRaises(SelectionError) as caught:
            await self.sel.select("auto")
        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(self.driver.address, CENTER)
        self.assertEqual(self.sel.address, CENTER)

    async def test_bad_address_is_refused_without_touching_the_link(self):
        with self.assertRaises(SelectionError) as caught:
            await self.sel.select("not-an-address")
        self.assertEqual(caught.exception.status, 400)
        self.assertTrue(self.driver.connected)
        self.assertEqual(self.driver.stops, 0)

    async def test_choosing_the_linked_gimbal_again_changes_nothing(self):
        await self.sel.select(CENTER)
        self.assertTrue(self.driver.connected)
        self.assertEqual(self.driver.address_history, [CENTER])

    async def test_one_switch_at_a_time(self):
        self.sel.switching = True
        with self.assertRaises(SelectionError) as caught:
            await self.sel.select(TRIPOD)
        self.assertEqual(caught.exception.status, 409)


class ListingTests(SelectorCase):
    async def test_linked_bridge_does_not_scan_unless_asked(self):
        driver = RoomDriver()
        sel = self.selector(driver, configured=CENTER)
        await driver.set_address(CENTER)
        await driver.connect()
        body = await sel.gimbals_body(scan=False)
        self.assertFalse(body["scanned"])
        self.assertEqual(driver.scans, 0)
        self.assertIn("Not scanned", body["note"])
        self.assertEqual([g["address"] for g in body["gimbals"]], [CENTER], "the selected gimbal is listed although it does not advertise")
        self.assertTrue(body["gimbals"][0]["selected"] and body["gimbals"][0]["connected"])
        self.assertFalse(body["gimbals"][0]["advertising"])

    async def test_asked_scan_lists_dji_gimbals_strongest_first_and_says_it_may_disturb(self):
        driver = RoomDriver()
        sel = self.selector(driver, configured=CENTER)
        await driver.set_address(CENTER)
        await driver.connect()
        body = await sel.gimbals_body(scan=True)
        self.assertTrue(body["scanned"])
        self.assertIn("disturb", body["note"])
        addresses = [g["address"] for g in body["gimbals"]]
        self.assertEqual(addresses, [CENTER, TRIPOD, FAR_RIGHT], "selected first (not advertising), then by signal; no phone")
        strongest = [g["address"] for g in body["gimbals"] if g["strongest"]]
        self.assertEqual(strongest, [TRIPOD])

    async def test_unlinked_bridge_scans_by_itself(self):
        driver = RoomDriver()
        sel = self.selector(driver, configured=CENTER)
        body = await sel.gimbals_body(scan=False)
        self.assertTrue(body["scanned"])
        row = next(g for g in body["gimbals"] if g["address"] == CENTER)
        self.assertTrue(row["selected"] and row["advertising"] and not row["connected"])
        self.assertEqual(body["selected"]["rssi"], -66, "the selected gimbal's RSSI comes from the scan")


class HttpRouteTests(SelectorCase):
    async def asyncSetUp(self):
        self.driver = RoomDriver()
        self.sel = self.selector(self.driver, configured=CENTER)
        await self.driver.set_address(CENTER)
        await self.driver.connect()

    async def route(self, method, path, selector="default"):
        return await dji_bridge.http_route(method, path, self.driver, 7878, set(), self.sel if selector == "default" else selector)

    async def test_info_names_the_bluetooth_gimbal(self):
        status, body = await self.route("GET", "/info")
        self.assertEqual(status, 200)
        self.assertEqual(body["bluetooth"]["address"], CENTER)
        self.assertEqual(body["bluetooth"]["name"], "DJI RS3 PRO-0613YW")
        self.assertEqual(body["bluetooth"]["rssi"], -66)
        self.assertTrue(body["bluetooth"]["connected"])

    async def test_info_carries_the_battery(self):
        self.driver.battery_percent = 23
        _, body = await self.route("GET", "/info")
        self.assertEqual(body["battery"], {"percent": 23, "ageS": 0})
        self.driver.battery_percent = None
        _, body = await self.route("GET", "/info")
        self.assertIsNone(body["battery"])

    async def test_get_gimbal_never_switches(self):
        status, body = await self.route("GET", f"/gimbal?address={TRIPOD}")
        self.assertEqual(status, 405)
        self.assertEqual(self.driver.address, CENTER)
        self.assertTrue(self.driver.connected)

    async def test_post_gimbal_switches_and_needs_an_address(self):
        self.assertEqual((await self.route("POST", "/gimbal"))[0], 400)
        status, body = await self.route("POST", f"/gimbal?address={TRIPOD}")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(self.driver.address, TRIPOD)
        status, body = await self.route("POST", "/gimbal?address=bogus")
        self.assertEqual(status, 400)
        self.assertFalse(body["ok"])

    async def test_gimbals_query_controls_the_scan(self):
        _, quiet = await self.route("GET", "/gimbals")
        self.assertFalse(quiet["scanned"])
        _, scanned = await self.route("GET", "/gimbals?scan=1")
        self.assertTrue(scanned["scanned"])
        self.assertEqual((await self.route("POST", "/gimbals"))[0], 405)

    async def test_other_paths_go_to_the_websocket_handshake(self):
        self.assertIsNone(await self.route("GET", "/"))
        self.assertIsNone(await self.route("GET", "/ws"))

    async def test_a_bridge_without_selection_says_so(self):
        status, _ = await self.route("GET", "/gimbals", selector=None)
        self.assertEqual(status, 501)

    async def test_legacy_hook_serves_gimbals(self):
        hook = dji_bridge.info_request_handler(self.driver, 7878, set(), self.sel)
        status, headers, body = await hook("/gimbals", {})
        self.assertEqual(int(status), 200)
        self.assertIn("gimbals", json.loads(body))

    async def test_new_api_hook_passes_the_method(self):
        class Headers(dict):
            pass

        class Response:
            def __init__(self, status, text):
                self.status, self.text = status, text
                self.headers = Headers({"Content-Type": "text/plain"})

        class Connection:
            def respond(self, status, text):
                return Response(status, text)

        hook = dji_bridge.info_request_handler(self.driver, 7878, set(), self.sel)
        response = await hook(Connection(), types.SimpleNamespace(path=f"/gimbal?address={TRIPOD}", method="POST"))
        self.assertEqual(int(response.status), 200)
        self.assertEqual(response.headers["Content-Type"], "application/json")
        self.assertEqual(self.driver.address, TRIPOD)


class SessionTests(SelectorCase):
    class Socket:
        remote_address = "t"

        def __init__(self):
            self.sent = []

        async def send(self, raw):
            self.sent.append(json.loads(raw))

    async def test_hello_advertises_selection_and_status_carries_bluetooth(self):
        driver = RoomDriver()
        sel = self.selector(driver, configured=CENTER)
        await driver.set_address(CENTER)
        await driver.connect()
        ws = self.Socket()
        session = dji_bridge.Session(ws, driver, 250, 7878, sel)
        hello = await session._dispatch("hello", {"clientId": "app"})
        self.assertIn("gimbalSelect", hello["capabilities"])
        self.assertEqual(hello["bluetooth"]["address"], CENTER)
        original = dji_bridge.STATUS_INTERVAL_S
        dji_bridge.STATUS_INTERVAL_S = 0.01
        try:
            task = asyncio.create_task(session._status_loop())
            for _ in range(100):
                await asyncio.sleep(0.01)
                if ws.sent:
                    break
            task.cancel()
        finally:
            dji_bridge.STATUS_INTERVAL_S = original
        self.assertEqual(ws.sent[0]["params"]["bluetooth"]["address"], CENTER)
        self.assertEqual(ws.sent[0]["params"]["battery"]["percent"], 76, "status carries the battery (mock reports 76%)")


class MaintainTests(SelectorCase):
    def setUp(self):
        super().setUp()
        self._orig = (dji_bridge.GIMBAL_RETRY_MIN_S, dji_bridge.GIMBAL_RETRY_MAX_S, dji_bridge.GIMBAL_POLL_S,
                      dji_bridge._hold_ble_lock, dji_bridge._release_ble_lock)
        dji_bridge.GIMBAL_RETRY_MIN_S = dji_bridge.GIMBAL_RETRY_MAX_S = dji_bridge.GIMBAL_POLL_S = 0.01
        dji_bridge._hold_ble_lock = self.lock.acquire
        dji_bridge._release_ble_lock = self.lock.release

    def tearDown(self):
        (dji_bridge.GIMBAL_RETRY_MIN_S, dji_bridge.GIMBAL_RETRY_MAX_S, dji_bridge.GIMBAL_POLL_S,
         dji_bridge._hold_ble_lock, dji_bridge._release_ble_lock) = self._orig
        super().tearDown()

    async def run_until(self, task, condition):
        for _ in range(300):
            await asyncio.sleep(0.01)
            if condition():
                break
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def test_auto_mode_picks_saves_and_connects(self):
        driver = RoomDriver()
        sel = self.selector(driver)
        await self.run_until(asyncio.create_task(dji_bridge.maintain_gimbal(driver, sel)), lambda: driver.connected)
        self.assertTrue(driver.connected)
        self.assertEqual(driver.address, TRIPOD)
        self.assertEqual(self.saved()["address"], TRIPOD)

    async def test_switch_then_reconnect_to_the_new_gimbal(self):
        driver = RoomDriver()
        sel = self.selector(driver, configured=CENTER)
        await driver.set_address(CENTER)
        task = asyncio.create_task(dji_bridge.maintain_gimbal(driver, sel))
        for _ in range(100):
            await asyncio.sleep(0.01)
            if driver.connected:
                break
        await sel.select(FAR_RIGHT)
        await self.run_until(task, lambda: driver.connected)
        self.assertTrue(driver.connected)
        self.assertEqual(driver.address, FAR_RIGHT)

    async def test_no_reconnect_while_a_switch_is_in_progress(self):
        driver = RoomDriver()
        sel = self.selector(driver, configured=CENTER)
        await driver.set_address(CENTER)
        sel.switching = True
        task = asyncio.create_task(dji_bridge.maintain_gimbal(driver, sel))
        await asyncio.sleep(0.1)
        self.assertFalse(driver.connected, "reconnecting the old gimbal mid-switch would undo the switch")
        sel.switching = False
        await self.run_until(task, lambda: driver.connected)
        self.assertTrue(driver.connected)


class FakeTransport:
    instances = []

    def __init__(self, address, _timeout):
        self.address = address
        self.name = "DJI RS3 PRO-0614BW"
        self.rssi = -55
        self.on_disconnect = None
        self.disconnects = 0
        FakeTransport.instances.append(self)

    async def connect(self):
        pass

    async def disconnect(self):
        self.disconnects += 1

    async def start_notifications(self, _cb):
        pass

    async def stop_notifications(self):
        pass

    async def write(self, _frame):
        pass


class Rs3DriverSelectionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        FakeTransport.instances = []

    async def test_no_address_means_no_connect_but_no_crash(self):
        driver = DjiRsDriver(None, transport_factory=FakeTransport, max_joystick=80)
        with self.assertRaises(GimbalError):
            await driver.connect()

    async def test_set_address_drops_the_old_link_and_builds_a_new_transport(self):
        driver = DjiRsDriver(CENTER, transport_factory=FakeTransport, max_joystick=80)
        await driver.connect()
        old = FakeTransport.instances[-1]
        await driver.set_address(TRIPOD)
        self.assertFalse(driver.connected)
        self.assertGreaterEqual(old.disconnects, 1, "a DJI gimbal takes one connection: let the old one go")
        self.assertEqual(FakeTransport.instances[-1].address, TRIPOD)
        await driver.connect()
        self.assertTrue(driver.connected)
        self.assertEqual(driver.linked_name, "DJI RS3 PRO-0614BW")
        self.assertEqual(driver.linked_rssi, -55)

    async def test_scan_uses_the_injected_scanner(self):
        async def scanner(timeout):
            return [{"address": TRIPOD, "name": "DJI RS3 PRO-0614BW", "rssi": -50, "t": timeout}]

        driver = DjiRsDriver(None, transport_factory=FakeTransport, max_joystick=80, scanner=scanner)
        self.assertEqual((await driver.scan(1.5))[0]["t"], 1.5)


class SelectCliTests(unittest.TestCase):
    def test_select_gimbal_writes_the_state_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(dji_bridge.save_selection(TRIPOD.lower(), tmp), 0)
            with open(os.path.join(tmp, "gimbal.json")) as fh:
                saved = json.load(fh)
            self.assertEqual(saved["address"], TRIPOD)
            self.assertEqual(saved["chosenBy"], "installer")
            self.assertEqual(dji_bridge.save_selection("nope", tmp), 2)


if __name__ == "__main__":
    unittest.main()
