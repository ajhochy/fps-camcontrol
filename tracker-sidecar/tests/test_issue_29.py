import asyncio
import json
import subprocess
import sys
import unittest
from sidecar_test_support import ROOT, implementation, receive_type

SESSION = '00000000-0000-4000-8000-000000000001'
ORIGIN = 'http://127.0.0.1:8175'
SOURCE = {'sourceId': 'gimbal', 'frameUrl': ORIGIN + '/api/sony/cameras/camera-1/live-view/frame'}


class SkeletonContract(unittest.IsolatedAsyncioTestCase):
    def server(self, **kwargs):
        module = implementation(self, 'tracker_sidecar')
        return module.TrackerServer(source='mock', port=0, ws_token='w' * 32,
                                    frame_token='f' * 32, backend_origin=ORIGIN, **kwargs)

    async def connect(self, server):
        from websockets.asyncio.client import connect
        return await connect('ws://127.0.0.1:' + str(server.port),
                             additional_headers={'Authorization': 'Bearer ' + 'w' * 32})

    async def send(self, ws, kind, **values):
        await ws.send(json.dumps({'protocol': 1, 'type': kind, **values}))

    async def test_issue29_c1(self):
        async with self.server() as server:
            self.assertEqual(server.host, '127.0.0.1')
            async with await self.connect(server) as ws:
                await self.send(ws, 'hello')
                hello = await receive_type(ws, 'hello')
                self.assertEqual(hello['capabilities'], ['person'])
                self.assertEqual(hello['detector'], 'mock')

    async def test_issue29_c2(self):
        source = implementation(self, 'sources.mock_source').MockSource
        self.assertEqual(source('stationary').sample(0, 1000)['cx'], source('stationary').sample(1000, 2000)['cx'])
        self.assertNotEqual(source('sine').sample(0, 1000)['cx'], source('sine').sample(1000, 2000)['cx'])
        self.assertEqual(source('exit-frame').sample(2200, 3200)['state'], 'lost')
        self.assertEqual(source('exit-frame').sample(6000, 7000)['state'], 'idle')
        async with self.server() as server:
            async with await self.connect(server) as ws:
                await self.send(ws, 'hello'); await receive_type(ws, 'hello')
                await self.send(ws, 'configure', sources=[SOURCE])
                await self.send(ws, 'select', sourceId='gimbal', sessionId=SESSION, x=.5, y=.5)
                first = await receive_type(ws, 'track')
                self.assertEqual(first['state'], 'locking')
                second = await receive_type(ws, 'track')
                self.assertGreater(second['seq'], first['seq'])
                self.assertEqual(second['state'], 'tracking')
                await self.send(ws, 'cancel', sourceId='gimbal', sessionId=SESSION)
                while (await receive_type(ws, 'track'))['state'] != 'idle':
                    pass
                await self.send(ws, 'ping', nonce='still-alive')
                self.assertEqual((await receive_type(ws, 'pong'))['nonce'], 'still-alive')

    async def test_issue29_c3(self):
        async with self.server() as server:
            for value in ['{', json.dumps({'protocol': 1, 'type': 'unknown'}), 'x' * 65537, b'binary']:
                async with await self.connect(server) as ws:
                    await ws.send(value)
                    self.assertEqual((await receive_type(ws, 'error'))['code'], 'invalid_message')
            async with await self.connect(server) as ws:
                await self.send(ws, 'hello')
                self.assertEqual((await receive_type(ws, 'hello'))['protocol'], 1)

    async def test_issue29_c4(self):
        source = implementation(self, 'sources.mock_source').MockSource('stationary')
        result = source.sample(500, 123456)
        self.assertEqual(result['frameTs'], 123456)
        self.assertEqual(result['processedAt'], 123456)

    def test_issue29_c6(self):
        implementation(self, 'tracker_sidecar')
        script = 'import sys;sys.path.insert(0,' + repr(str(ROOT)) + ');import tracker_sidecar;assert not any(k in sys.modules for k in ("numpy","PIL","onnxruntime"))'
        completed = subprocess.run([sys.executable, '-I', '-c', script], capture_output=True)
        self.assertEqual(completed.returncode, 0, completed.stderr.decode())

    def test_protocol_strict_security(self):
        protocol = implementation(self, 'protocol')
        valid = {'protocol': 1, 'type': 'select', 'sourceId': 'gimbal', 'sessionId': SESSION, 'x': .5, 'y': .5}
        self.assertEqual(protocol.parse_message(json.dumps(valid), ORIGIN), valid)
        for changes in [{'protocol': True}, {'x': float('nan')}, {'x': True}, {'x': 1.1}, {'sessionId': 'no'}, {'extra': 1}]:
            with self.assertRaises(ValueError):
                protocol.parse_message(json.dumps({**valid, **changes}), ORIGIN)
        for url in ['http://localhost:8175/api/sony/cameras/x/live-view/frame', ORIGIN + '/api/config',
                    ORIGIN + '/api/sony/cameras/x/live-view/frame#fragment', 'http://evil.example/api/sony/cameras/x/live-view/frame']:
            with self.assertRaises(ValueError):
                protocol.parse_message(json.dumps({'protocol': 1, 'type': 'configure', 'sources': [{'sourceId': 'g', 'frameUrl': url}]}), ORIGIN)
