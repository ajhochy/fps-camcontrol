import asyncio
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

from dji_bridge import Session


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


class SessionTests(unittest.IsolatedAsyncioTestCase):
    async def test_abrupt_connection_close_stops_driver_without_escaping(self):
        driver = Driver()
        await Session(AbruptSocket(), driver, 250).run()
        self.assertEqual(driver.stops, 1)
