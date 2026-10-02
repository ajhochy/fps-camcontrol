#!/usr/bin/env python3
"""
DJI RS gimbal bridge for fps-camcontrol.

Speaks the WebSocket/JSON protocol documented in docs/dji-gimbal-spec.md §5.
Hosts a WS server on configurable host:port, performs capability negotiation
    on `hello`, enforces a safety watchdog, and delegates motor commands to a
    pluggable driver (mock by default; RS3 Bluetooth LE when selected).

Usage:
    python3 dji_bridge.py --port 7878 --driver mock
    python3 dji_bridge.py --port 7878 --driver dji-rs3-ble --ble-address 34:D2:62:15:A5:47
"""

import argparse
import asyncio
import fcntl
import json
import logging
import os
import signal
import socket
import sys
import time
from http import HTTPStatus
from typing import Any, Dict, Optional

import websockets
from websockets.server import WebSocketServerProtocol

from urllib.parse import parse_qs, urlsplit

from drivers.base import GimbalDriver, GimbalError, NotSupported
from drivers.mock_driver import MockDriver
from gimbal_select import GimbalSelector, SelectionError, SelectionStore, normalize_address, state_path

PROTOCOL_VERSION = 1
DEFAULT_SAFETY_TIMEOUT_MS = 250
STATUS_INTERVAL_S = 0.5
# Shared by every bridge instance on this host; serialises BLE connects so
# concurrent attempts don't fail with org.bluez.Error.InProgress.
BLE_CONNECT_LOCK = "/tmp/dji-bridge-ble-connect.lock"
GIMBAL_RETRY_MIN_S = 2.0
GIMBAL_RETRY_MAX_S = 30.0
GIMBAL_POLL_S = 2.0

log = logging.getLogger("dji-bridge")

BRIDGE_VERSION = "0.6.0"
INFO_PATH = "/info"
GIMBALS_PATH = "/gimbals"
GIMBAL_PATH = "/gimbal"
# A GET /gimbals?scan=1 or POST /gimbal holds the HTTP request open for a scan (and possibly a wait for the BLE lock
# another bridge holds while connecting), so the handshake timeout must be longer than websockets' 10 s default.
OPEN_TIMEOUT_S = 30


def bridge_info(driver: GimbalDriver, port: int, clients: int, selector: Optional[GimbalSelector] = None) -> Dict[str, Any]:
    """Who this bridge is: lets the app recognise one gimbal under any of the Pi's addresses.

    Served on plain HTTP (GET /info) as well as in the `hello` ack. The HTTP form opens no
    session, so asking it never triggers the stop-on-disconnect in Session.run.
    """
    return {
        "bridgeVersion": BRIDGE_VERSION,
        "hostname": socket.gethostname(),
        "port": port,
        # The systemd instance name (dji-bridge@<instance>), e.g. "rs3pro-a"; None when run by hand.
        "instance": os.environ.get("BRIDGE_INSTANCE") or None,
        "gimbalModel": driver.model,
        # The gimbal's Bluetooth address: which physical gimbal this bridge drives.
        "gimbalAddress": getattr(driver, "address", None),
        "gimbalConnected": bool(driver.connected),
        # Control sessions open right now (normally the app's one).
        "clients": clients,
        "link": link_health(driver),
        "asleep": getattr(driver, "asleep", None),
        # Which Bluetooth gimbal this bridge is set to drive and how it was chosen (bridge >= 0.6.0; see
        # gimbal_select.py). None for a driver without selection support.
        "bluetooth": selector.describe_selection() if selector is not None else None,
    }


def link_health(driver: GimbalDriver) -> Optional[Dict[str, Any]]:
    """The driver's Bluetooth link health, when it measures one (the RS3 driver does; the mock does not)."""
    measure = getattr(driver, "link_health", None)
    if not callable(measure):
        return None
    try:
        return measure()
    except Exception:  # noqa: BLE001 - health reporting must never break a session
        return None


async def http_route(
    method: str, path: str, driver: GimbalDriver, port: int, sessions: "set[Any]", selector: Optional[GimbalSelector]
) -> Optional["tuple[int, Dict[str, Any]]"]:
    """Plain-HTTP requests on the bridge port; None hands the request on to the WebSocket handshake.

    None of these opens a control session, so none can trigger the stop-on-disconnect in Session.run.
      GET  /info                     who this bridge is, and which Bluetooth gimbal it drives
      GET  /gimbals[?scan=1]         DJI gimbals in range (scans only when asked or while nothing is linked)
      POST /gimbal?address=<addr|auto>  switch gimbal: persist, drop the current link, connect the new one
    The address travels in the query string: websockets' HTTP parser refuses request bodies.
    """
    parts = urlsplit(path)
    route = parts.path.rstrip("/") or "/"
    query = {k: v[-1] for k, v in parse_qs(parts.query).items()}
    if route == INFO_PATH:
        return HTTPStatus.OK, bridge_info(driver, port, len(sessions), selector)
    if route not in (GIMBALS_PATH, GIMBAL_PATH):
        return None
    if selector is None:
        return HTTPStatus.NOT_IMPLEMENTED, {"ok": False, "error": "this bridge has no gimbal selection"}
    if route == GIMBALS_PATH:
        if method != "GET":
            return HTTPStatus.METHOD_NOT_ALLOWED, {"ok": False, "error": "use GET /gimbals"}
        return HTTPStatus.OK, await selector.gimbals_body(scan=query.get("scan") in ("1", "true", "yes"))
    if method != "POST":
        # Never change the gimbal on a GET: a prefetch or a stray link must not cut a live camera's link.
        return HTTPStatus.METHOD_NOT_ALLOWED, {"ok": False, "error": "use POST /gimbal?address=<address|auto> to switch gimbals"}
    target = query.get("address")
    if not target:
        return HTTPStatus.BAD_REQUEST, {"ok": False, "error": "address is required (?address=AA:BB:CC:DD:EE:FF or ?address=auto)"}
    try:
        selected = await selector.select(target)
    except SelectionError as exc:
        return exc.status, {"ok": False, "error": str(exc), "selected": selector.describe_selection()}
    return HTTPStatus.OK, {"ok": True, "selected": selected}


def info_request_handler(driver: GimbalDriver, port: int, sessions: "set[Any]", selector: Optional[GimbalSelector] = None):
    """A websockets `process_request` hook for the plain-HTTP routes, for the old and the new websockets API."""

    async def process_request(*args: Any) -> Any:
        if len(args) == 2 and isinstance(args[0], str):  # legacy API: (path, request_headers); GET only
            answer = await http_route("GET", args[0], driver, port, sessions, selector)
            if answer is None:
                return None
            status, payload = answer
            return (HTTPStatus(status), [("Content-Type", "application/json"), ("Cache-Control", "no-store")], json.dumps(payload).encode())
        connection, request = args  # websockets >= 14: (connection, request)
        answer = await http_route(getattr(request, "method", "GET") or "GET", request.path, driver, port, sessions, selector)
        if answer is None:
            return None
        status, payload = answer
        response = connection.respond(HTTPStatus(status), json.dumps(payload))
        del response.headers["Content-Type"]
        response.headers["Content-Type"] = "application/json"
        response.headers["Cache-Control"] = "no-store"
        return response

    return process_request


class Session:
    """One WebSocket client. The orchestrator (Node app) is the only expected client."""

    def __init__(
        self,
        ws: WebSocketServerProtocol,
        driver: GimbalDriver,
        safety_timeout_ms: int,
        port: int = 0,
        selector: Optional[GimbalSelector] = None,
    ):
        self.ws = ws
        self.port = port
        self.selector = selector
        self.driver = driver
        self.safety_timeout_ms = safety_timeout_ms
        self.client_id: Optional[str] = None
        self.safety_task: Optional[asyncio.Task[None]] = None
        self.status_task: Optional[asyncio.Task[None]] = None

    async def run(self) -> None:
        self.status_task = asyncio.create_task(self._status_loop())
        try:
            async for raw in self.ws:
                await self._handle(raw)
        except websockets.exceptions.ConnectionClosed:
            log.info("client connection closed")
        finally:
            if self.safety_task and not self.safety_task.done():
                self.safety_task.cancel()
            if self.status_task and not self.status_task.done():
                self.status_task.cancel()
            # A gimbal whose link just dropped cannot be stopped; that must not
            # turn into an unhandled error on the way out.
            try:
                await self.driver.stop()
            except Exception as e:  # noqa: BLE001
                log.warning("stop on client disconnect failed: %s", e)

    async def _handle(self, raw: Any) -> None:
        try:
            frame = json.loads(raw)
        except json.JSONDecodeError:
            log.warning("bad frame: %r", raw)
            return
        if frame.get("type") != "cmd":
            return
        msg_id = frame.get("id")
        method = frame.get("method")
        params = frame.get("params") or {}

        try:
            result = await self._dispatch(method, params)
            await self._ack(msg_id, result or {})
        except NotSupported as e:
            await self._nack(msg_id, "not_supported", str(e))
        except GimbalError as e:
            await self._nack(msg_id, "sdk_error", str(e))
        except Exception as e:  # noqa: BLE001
            log.exception("unhandled error in %s", method)
            await self._nack(msg_id, "sdk_error", repr(e))

    async def _dispatch(self, method: str, params: Dict[str, Any]) -> Dict[str, Any]:
        if method == "hello":
            self.client_id = params.get("clientId")
            identity = bridge_info(self.driver, self.port, 1, self.selector)
            del identity["clients"]
            capabilities = list(self.driver.capabilities)
            if self.selector is not None:
                capabilities.append("gimbalSelect")  # GET /gimbals and POST /gimbal on this port
            return {**identity, "capabilities": capabilities}
        if method == "ping":
            await self._emit("pong", {"ts": int(time.time() * 1000)})
            return {}
        if method == "moveVelocity":
            self._arm_safety()
            await self.driver.move_velocity(
                pan=float(params.get("pan", 0.0)),
                tilt=float(params.get("tilt", 0.0)),
                roll=float(params.get("roll", 0.0)),
            )
            return {}
        if method == "stop":
            self._cancel_safety()
            await self.driver.stop()
            return {}
        if method == "getPosition":
            pos = await self.driver.get_position()
            return {"yaw": pos.yaw, "pitch": pos.pitch, "roll": pos.roll, "ts": int(time.time() * 1000)}
        if method == "moveToPosition":
            await self.driver.move_to(
                yaw=float(params["yaw"]),
                pitch=float(params["pitch"]),
                roll=float(params.get("roll", 0.0)),
                speed=float(params.get("speed", 0.5)),
            )
            return {"ok": True}
        if method == "recenter":
            await self.driver.recenter()
            return {}
        if method == "wake":
            wake = getattr(self.driver, "wake", None)
            if wake is None or "wake" not in tuple(self.driver.capabilities):
                raise NotSupported("wake is not supported by this gimbal driver")
            log.warning("WAKE sent to the gimbal (asked by client %s)", self.client_id or "unknown")
            await wake()
            return {}
        if method == "setMode":
            await self.driver.set_mode(str(params.get("mode", "follow")))
            return {}
        raise NotSupported(f"unknown method: {method}")

    def _arm_safety(self) -> None:
        self._cancel_safety()
        self.safety_task = asyncio.create_task(self._safety_fire())

    def _cancel_safety(self) -> None:
        if self.safety_task and not self.safety_task.done():
            self.safety_task.cancel()
        self.safety_task = None

    async def _safety_fire(self) -> None:
        try:
            await asyncio.sleep(self.safety_timeout_ms / 1000.0)
            try:
                await self.driver.stop()
            except Exception as e:  # noqa: BLE001
                log.warning("safety stop could not reach the gimbal: %s", e)
            await self._emit("safetyStop", {"reason": "app_timeout"})
            log.warning("safety stop: app_timeout")
        except asyncio.CancelledError:
            pass

    async def _status_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(STATUS_INTERVAL_S)
                try:
                    pos = await self.driver.get_position()
                except Exception:  # noqa: BLE001
                    pos = None
                # Still report status when the read failed, otherwise a gimbal that
                # dropped its link looks like a gimbal that is simply quiet and the
                # app never learns that it is disconnected.
                params: Dict[str, Any] = {
                    "gimbalConnected": self.driver.connected,
                    "sdkConnected": self.driver.connected,
                    "mode": self.driver.mode,
                }
                if pos is not None:
                    params["position"] = {"yaw": pos.yaw, "pitch": pos.pitch, "roll": pos.roll}
                link = link_health(self.driver)
                if link is not None:
                    params["link"] = link
                # The gimbal's own sleep report (None when it has not sent one on this link).
                params["asleep"] = getattr(self.driver, "asleep", None)
                if self.selector is not None:
                    params["bluetooth"] = self.selector.describe_selection()
                await self._emit("status", params)
        except asyncio.CancelledError:
            pass

    async def _emit(self, method: str, params: Dict[str, Any]) -> None:
        await self._send({"v": PROTOCOL_VERSION, "type": "evt", "method": method, "params": params})

    async def _ack(self, msg_id: Optional[int], params: Dict[str, Any]) -> None:
        if msg_id is None:
            return
        await self._send({"v": PROTOCOL_VERSION, "type": "ack", "id": msg_id, "params": params})

    async def _nack(self, msg_id: Optional[int], code: str, message: str) -> None:
        if msg_id is None:
            return
        await self._send(
            {"v": PROTOCOL_VERSION, "type": "ack", "id": msg_id, "error": {"code": code, "message": message}}
        )

    async def _send(self, frame: Dict[str, Any]) -> None:
        try:
            await self.ws.send(json.dumps(frame))
        except websockets.exceptions.ConnectionClosed:
            pass


async def _hold_ble_lock() -> Any:
    """Acquire the host-wide BLE connect lock (blocking, off the event loop).

    BlueZ serialises connection *attempts* per adapter: two concurrent connects
    fail with `org.bluez.Error.InProgress`. Multiple established links are fine,
    so we only serialise the connect itself. The lock is a file lock so it works
    across the separate bridge processes (one per gimbal), not just within one.
    """
    def _acquire() -> Any:
        fh = open(BLE_CONNECT_LOCK, "a+")
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        return fh

    return await asyncio.to_thread(_acquire)


def _release_ble_lock(fh: Any) -> None:
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
    finally:
        fh.close()


async def maintain_gimbal(driver: GimbalDriver, selector: Optional[GimbalSelector] = None) -> None:
    """Keep the gimbal connected, retrying forever, without killing the server.

    The bridge must stay reachable even when the gimbal is off: the app treats a
    refused port as "the whole Pi is down". Previously `serve()` awaited
    `driver.connect()` before binding the listener, so an absent gimbal raised
    GimbalError -> exit(1) -> systemd restart, and port 7878 never opened.

    This loop is also what recovers a gimbal that drops its link mid-service (DJI
    gimbals sleep on their own). That only works because the driver now clears
    `connected` when the link goes away instead of leaving it True forever.
    """
    backoff = GIMBAL_RETRY_MIN_S
    was_connected = False
    while True:
        if driver.connected:
            was_connected = True
            await asyncio.sleep(GIMBAL_POLL_S)
            continue
        if selector is not None and selector.switching:
            # A gimbal switch owns the link right now; reconnecting the old gimbal would undo it.
            was_connected = False
            await asyncio.sleep(GIMBAL_POLL_S)
            continue
        if was_connected:
            # Dropped after a good connect: reconnect immediately, no backoff.
            log.warning("gimbal link lost — reconnecting")
            was_connected = False
            backoff = GIMBAL_RETRY_MIN_S
        if selector is not None and not getattr(driver, "address", None) and selector.can_scan:
            # AUTO mode and nothing chosen yet: nothing is linked, so scanning cannot disturb a link.
            try:
                picked = await selector.auto_pick()
            except Exception as exc:  # noqa: BLE001
                selector.last_error = f"scan failed: {exc}"
                picked = False
            if not picked:
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, GIMBAL_RETRY_MAX_S)
                continue
        lock = await _hold_ble_lock()
        try:
            await driver.connect()
        except Exception as exc:  # noqa: BLE001
            log.warning("gimbal connect failed: %s (retry in %.0fs)", exc, backoff)
            if selector is not None:
                selector.last_error = str(exc)
            _release_ble_lock(lock)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, GIMBAL_RETRY_MAX_S)
            continue
        else:
            _release_ble_lock(lock)
            log.info("gimbal connected (%s %s)", driver.model, getattr(driver, "address", None) or "")
            if selector is not None:
                selector.last_error = None
            was_connected = True
            backoff = GIMBAL_RETRY_MIN_S
        await asyncio.sleep(GIMBAL_POLL_S)


def make_selector(driver: GimbalDriver, configured_address: Optional[str], state_dir: Optional[str] = None) -> Optional[GimbalSelector]:
    """The gimbal selector for drivers that can be pointed at another gimbal (both shipped drivers can)."""
    if not callable(getattr(driver, "set_address", None)):
        return None
    store = SelectionStore(state_path(os.environ.get("BRIDGE_INSTANCE") or None, state_dir))
    return GimbalSelector(driver, store, configured_address, _hold_ble_lock, _release_ble_lock)


async def serve(host: str, port: int, driver: GimbalDriver, safety_timeout_ms: int, selector: Optional[GimbalSelector] = None) -> None:
    if selector is not None and selector.address:
        await driver.set_address(selector.address)  # type: ignore[attr-defined]
    # Bind the listener FIRST, then bring the gimbal up in the background, so the
    # bridge is always reachable and reports gimbal state instead of vanishing.
    connector = asyncio.create_task(maintain_gimbal(driver, selector))

    sessions: "set[Session]" = set()

    async def handler(ws: WebSocketServerProtocol) -> None:
        log.info("client connected: %s", ws.remote_address)
        session = Session(ws, driver, safety_timeout_ms, port, selector)
        sessions.add(session)
        try:
            await session.run()
        finally:
            sessions.discard(session)
            log.info("client disconnected: %s", ws.remote_address)

    log.info("DJI bridge listening on ws://%s:%d (driver=%s)", host, port, driver.name)
    try:
        async with websockets.serve(
            handler, host, port,
            process_request=info_request_handler(driver, port, sessions, selector),
            open_timeout=OPEN_TIMEOUT_S,
        ):
            stop = asyncio.Event()
            loop = asyncio.get_running_loop()
            for sig in (signal.SIGINT, signal.SIGTERM):
                loop.add_signal_handler(sig, stop.set)
            await stop.wait()
    finally:
        connector.cancel()
        try:
            await connector
        except asyncio.CancelledError:
            pass
        await driver.close()


def build_driver(name: str, args: argparse.Namespace) -> GimbalDriver:
    if name == "mock":
        return MockDriver()
    if name == "dji-rs3-ble":
        # Deferred import keeps mock mode usable without bleak installed.
        try:
            from drivers.dji_rs_driver import DjiRsDriver  # type: ignore
        except ImportError as e:
            print(f"dji-rs3-ble driver unavailable: {e}", file=sys.stderr)
            sys.exit(2)
        # No address here: the selector decides (saved choice > --ble-address/DJI_RS3_BLE_ADDRESS > strongest).
        return DjiRsDriver(address=None)
    print(f"unknown driver: {name}", file=sys.stderr)
    sys.exit(2)


def save_selection(address: str, state_dir: Optional[str]) -> int:
    """--select-gimbal: write gimbal.json and exit (the installer pre-sets the gimbal this way). No Bluetooth."""
    normalized = normalize_address(address)
    if not normalized:
        print(f"not a Bluetooth address: {address!r}", file=sys.stderr)
        return 2
    store = SelectionStore(state_path(os.environ.get("BRIDGE_INSTANCE") or None, state_dir))
    os.makedirs(os.path.dirname(store.path), exist_ok=True)
    if not store.save({"address": normalized, "name": None, "rssi": None, "chosenBy": "installer", "chosenAt": time.time()}):
        return 1
    print(f"saved gimbal {normalized} to {store.path}")
    return 0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=7878)
    ap.add_argument("--driver", default="mock", choices=["mock", "dji-rs3-ble"])
    ap.add_argument("--safety-timeout-ms", type=int, default=DEFAULT_SAFETY_TIMEOUT_MS)
    ap.add_argument("--ble-address", help="default RS3 BLE address (or DJI_RS3_BLE_ADDRESS); a saved choice in gimbal.json wins")
    ap.add_argument("--state-dir", help="where gimbal.json lives (or DJI_BRIDGE_STATE_DIR; default /var/lib/dji-bridge)")
    ap.add_argument("--select-gimbal", metavar="ADDRESS", help="save ADDRESS as the gimbal to drive, then exit")
    ap.add_argument("--log-level", default="INFO")
    args = ap.parse_args()

    logging.basicConfig(level=args.log_level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if args.select_gimbal:
        sys.exit(save_selection(args.select_gimbal, args.state_dir))

    driver = build_driver(args.driver, args)
    selector = make_selector(driver, args.ble_address or os.environ.get("DJI_RS3_BLE_ADDRESS"), args.state_dir)
    try:
        asyncio.run(serve(args.host, args.port, driver, args.safety_timeout_ms, selector))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
