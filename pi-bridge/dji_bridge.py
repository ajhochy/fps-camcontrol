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

from drivers.base import GimbalDriver, GimbalError, NotSupported
from drivers.mock_driver import MockDriver

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

BRIDGE_VERSION = "0.5.0"
INFO_PATH = "/info"


def bridge_info(driver: GimbalDriver, port: int, clients: int) -> Dict[str, Any]:
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


def info_request_handler(driver: GimbalDriver, port: int, sessions: "set[Any]"):
    """A websockets `process_request` hook answering GET /info, for the old and the new websockets API."""

    def body() -> bytes:
        return json.dumps(bridge_info(driver, port, len(sessions))).encode()

    def process_request(*args: Any) -> Any:
        if len(args) == 2 and isinstance(args[0], str):  # legacy API: (path, request_headers)
            if args[0].split("?")[0] != INFO_PATH:
                return None
            return (HTTPStatus.OK, [("Content-Type", "application/json"), ("Cache-Control", "no-store")], body())
        connection, request = args  # websockets >= 14: (connection, request)
        if request.path.split("?")[0] != INFO_PATH:
            return None
        response = connection.respond(HTTPStatus.OK, body().decode())
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
    ):
        self.ws = ws
        self.port = port
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
            identity = bridge_info(self.driver, self.port, 1)
            del identity["clients"]
            return {**identity, "capabilities": list(self.driver.capabilities)}
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


async def maintain_gimbal(driver: GimbalDriver) -> None:
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
        if was_connected:
            # Dropped after a good connect: reconnect immediately, no backoff.
            log.warning("gimbal link lost — reconnecting")
            was_connected = False
            backoff = GIMBAL_RETRY_MIN_S
        lock = await _hold_ble_lock()
        try:
            await driver.connect()
        except Exception as exc:  # noqa: BLE001
            log.warning("gimbal connect failed: %s (retry in %.0fs)", exc, backoff)
            _release_ble_lock(lock)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, GIMBAL_RETRY_MAX_S)
            continue
        else:
            _release_ble_lock(lock)
            log.info("gimbal connected (%s)", driver.model)
            was_connected = True
            backoff = GIMBAL_RETRY_MIN_S
        await asyncio.sleep(GIMBAL_POLL_S)


async def serve(host: str, port: int, driver: GimbalDriver, safety_timeout_ms: int) -> None:
    # Bind the listener FIRST, then bring the gimbal up in the background, so the
    # bridge is always reachable and reports gimbal state instead of vanishing.
    connector = asyncio.create_task(maintain_gimbal(driver))

    sessions: "set[Session]" = set()

    async def handler(ws: WebSocketServerProtocol) -> None:
        log.info("client connected: %s", ws.remote_address)
        session = Session(ws, driver, safety_timeout_ms, port)
        sessions.add(session)
        try:
            await session.run()
        finally:
            sessions.discard(session)
            log.info("client disconnected: %s", ws.remote_address)

    log.info("DJI bridge listening on ws://%s:%d (driver=%s)", host, port, driver.name)
    try:
        async with websockets.serve(handler, host, port, process_request=info_request_handler(driver, port, sessions)):
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
        return DjiRsDriver(address=args.ble_address)
    print(f"unknown driver: {name}", file=sys.stderr)
    sys.exit(2)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=7878)
    ap.add_argument("--driver", default="mock", choices=["mock", "dji-rs3-ble"])
    ap.add_argument("--safety-timeout-ms", type=int, default=DEFAULT_SAFETY_TIMEOUT_MS)
    ap.add_argument("--ble-address", help="RS3 BLE address (or DJI_RS3_BLE_ADDRESS)")
    ap.add_argument("--log-level", default="INFO")
    args = ap.parse_args()

    logging.basicConfig(level=args.log_level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    driver = build_driver(args.driver, args)
    try:
        asyncio.run(serve(args.host, args.port, driver, args.safety_timeout_ms))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
