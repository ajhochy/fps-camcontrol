import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
import subprocess
import sys
import threading
import time
import unittest
from sidecar_test_support import ROOT, implementation, receive_type
from test_issue_29 import ORIGIN, SESSION, SOURCE
from test_issue_30 import jpeg
from test_issue_31 import box, scene


class FrameSafety(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_queued_inference_closes_unowned_image(self):
        lane_module = implementation(self, 'sources.live_source')
        from PIL import Image
        class Detector:
            def detect(self, _):
                raise AssertionError('queued image must not reach native inference')
        lane = lane_module.InferenceLane(Detector())
        await lane.lock.acquire()
        image = Image.new('RGB', (4, 4))
        queued = asyncio.create_task(lane.detect(image))
        try:
            await asyncio.sleep(0)
            self.assertFalse(queued.done())
            queued.cancel()
            with self.assertRaises(asyncio.CancelledError): await queued
            self.assertTrue(lane.lock.locked(), 'canceled waiter must not release another owner')
            with self.assertRaises(ValueError): image.getpixel((0, 0))
        finally:
            lane.lock.release(); image.close()

    async def test_cancel_does_not_start_a_second_http_request(self):
        frames = implementation(self, 'frames')
        started, release = threading.Event(), threading.Event()
        calls = []
        body = jpeg()
        def request(*_):
            calls.append(1); started.set(); release.wait(3)
            return 200, {'Content-Type': 'image/jpeg', 'X-Frame-Captured-At': '9990'}, body
        fetcher = frames.FrameFetcher(SOURCE['frameUrl'], 'f'*32, ORIGIN, requester=request, clock=lambda: 10000)
        first = asyncio.create_task(fetcher.fetch())
        try:
            await asyncio.to_thread(started.wait, 2)
            first.cancel()
            await asyncio.gather(first, return_exceptions=True)
            second = asyncio.create_task(fetcher.fetch())
            await asyncio.sleep(.2)
            self.assertEqual(len(calls), 1)
            release.set()
            self.assertIsNotNone(await second)
            self.assertEqual(len(calls), 1)
        finally:
            release.set(); await fetcher.close()

    async def test_real_http_redirect_corrupt_oversize_timeout_and_recovery(self):
        frames = implementation(self, 'frames')
        plans, requests = [], []
        body = jpeg()
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_GET(self):
                requests.append(dict(self.headers))
                status, headers, payload, delay = plans.pop(0)
                time.sleep(delay)
                try:
                    self.send_response(status)
                    for key, value in headers.items(): self.send_header(key, value)
                    self.end_headers(); self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError): pass
        class Server(ThreadingHTTPServer):
            def handle_error(self, *_): pass
        server = Server(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        origin = 'http://127.0.0.1:' + str(server.server_port)
        delays = []
        async def sleep(delay): delays.append(delay)
        def request(url, headers, _, limit): return frames.request_frame(url, headers, .05, limit)
        fetcher = frames.FrameFetcher(origin + '/api/sony/cameras/test/live-view/frame', 'f'*32, origin,
                                      requester=request, clock=lambda: 10000, sleep=sleep)
        try:
            plans.append((302, {'Location': origin + '/api/config'}, b'', 0))
            self.assertIsNone(await fetcher.fetch())
            self.assertEqual(len(requests), 1, 'redirect must not be followed')
            plans.append((200, {'Content-Type': 'image/jpeg'}, b'not JPEG', 0))
            self.assertIsNone(await fetcher.fetch())
            plans.append((200, {'Content-Type': 'image/jpeg', 'Content-Length': str(frames.MAX_FRAME_BYTES + 1)}, b'', 0))
            self.assertIsNone(await fetcher.fetch())
            plans.append((200, {'Content-Type': 'image/jpeg'}, body, .15))
            self.assertIsNone(await fetcher.fetch())
            plans.append((503, {'Retry-After': '2'}, b'private upstream body', 0))
            self.assertIsNone(await fetcher.fetch())
            plans.append((200, {'Content-Type': 'image/jpeg', 'X-Frame-Captured-At': '9999'}, body, 0))
            result = await fetcher.fetch()
            self.assertEqual(result.captured_at, 9999)
            self.assertGreaterEqual(delays[-1], 2)
            self.assertTrue(all(item.get('Authorization') == 'Bearer ' + 'f'*32 for item in requests))
            self.assertTrue(all('Cookie' not in item for item in requests))
        finally:
            await fetcher.close(); await asyncio.to_thread(server.shutdown); server.server_close()

    async def test_decoded_pixel_bound_and_future_timestamp(self):
        frames = implementation(self, 'frames')
        from PIL import Image
        large = io.BytesIO(); Image.new('RGB', (3000, 3000)).save(large, format='JPEG')
        async def sleep(_): pass
        for headers, body in [({'Content-Type': 'image/jpeg'}, large.getvalue()),
                              ({'Content-Type': 'image/jpeg', 'X-Frame-Captured-At': '10051'}, jpeg())]:
            fetcher = frames.FrameFetcher(SOURCE['frameUrl'], 'f'*32, ORIGIN,
                                          requester=lambda *_: (200, headers, body), clock=lambda: 10000, sleep=sleep)
            self.assertIsNone(await fetcher.fetch())
            self.assertGreater(fetcher.next_delay, 0)


class SocketSafety(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_authenticated_upgrades_have_only_one_owner(self):
        from websockets.asyncio.client import connect
        from websockets.exceptions import ConnectionClosed
        tracker = implementation(self, 'tracker_sidecar')
        arrived = []
        barrier = asyncio.Event()
        class ConcurrentServer(tracker.TrackerServer):
            async def authenticate(self, connection, request):
                result = await super().authenticate(connection, request)
                arrived.append(1)
                if len(arrived) == 2: barrier.set()
                await barrier.wait()
                return result
        async with ConcurrentServer(ws_token='w'*32, frame_token='f'*32, backend_origin=ORIGIN, port=0) as server:
            address = 'ws://127.0.0.1:' + str(server.port)
            # Hold both process_request calls at the same boundary to exercise
            # the actual authenticated-upgrade race deterministically.
            connections = await asyncio.gather(*[connect(address, additional_headers={'Authorization': 'Bearer ' + 'w'*32}) for _ in range(2)], return_exceptions=True)
            self.assertEqual(len(arrived), 2)
            owners = []
            try:
                for ws in connections:
                    if isinstance(ws, Exception): continue
                    try:
                        await ws.send(json.dumps({'protocol':1, 'type':'hello'}))
                        await receive_type(ws, 'hello'); owners.append(ws)
                    except ConnectionClosed: pass
                self.assertEqual(len(owners), 1)
                self.assertEqual(len(server.clients), 1)
                await owners[0].send(json.dumps({'protocol':1, 'type':'configure', 'sources':[SOURCE]}))
                await owners[0].send(json.dumps({'protocol':1, 'type':'ping', 'nonce':'configured'}))
                await receive_type(owners[0], 'pong')
                for ws in connections:
                    if isinstance(ws, Exception) or ws is owners[0]: continue
                    with self.assertRaises(ConnectionClosed):
                        await ws.send(json.dumps({'protocol':1, 'type':'configure', 'sources':[]}))
                self.assertEqual(next(iter(server.clients)).sources, {'gimbal': SOURCE['frameUrl']})
            finally:
                await asyncio.gather(*[ws.close() for ws in connections if not isinstance(ws, Exception)], return_exceptions=True)

    async def test_auth_origin_and_second_client_rejected(self):
        from websockets.asyncio.client import connect
        from websockets.exceptions import InvalidStatus
        tracker = implementation(self, 'tracker_sidecar')
        async with tracker.TrackerServer(ws_token='w'*32, frame_token='f'*32, backend_origin=ORIGIN, port=0) as server:
            address = 'ws://127.0.0.1:' + str(server.port)
            for kwargs in ({}, {'additional_headers': {'Authorization': 'Bearer wrong'}},
                           {'additional_headers': {'Authorization': 'Bearer ' + 'w'*32}, 'origin': ORIGIN}):
                with self.assertRaises(InvalidStatus):
                    async with connect(address, **kwargs): pass
            async with connect(address, additional_headers={'Authorization': 'Bearer ' + 'w'*32}):
                with self.assertRaises(InvalidStatus):
                    async with connect(address, additional_headers={'Authorization': 'Bearer ' + 'w'*32}): pass

    async def test_stale_cancel_and_configure_clear_sessions(self):
        from websockets.asyncio.client import connect
        tracker = implementation(self, 'tracker_sidecar')
        async with tracker.TrackerServer(ws_token='w'*32, frame_token='f'*32, backend_origin=ORIGIN, port=0) as server:
            async with connect('ws://127.0.0.1:' + str(server.port), additional_headers={'Authorization': 'Bearer ' + 'w'*32}) as ws:
                async def send(kind, **values): await ws.send(json.dumps(dict(protocol=1, type=kind, **values)))
                await send('hello'); await receive_type(ws, 'hello')
                await send('configure', sources=[SOURCE])
                newer = '00000000-0000-4000-8000-000000000002'
                await send('select', sourceId='gimbal', sessionId=newer, x=.5, y=.5)
                await receive_type(ws, 'track')
                await send('cancel', sourceId='gimbal', sessionId=SESSION)
                self.assertEqual((await receive_type(ws, 'track'))['sessionId'], newer)
                await send('configure', sources=[])
                await send('ping', nonce='configured')
                await receive_type(ws, 'pong')
                with self.assertRaises(asyncio.TimeoutError): await asyncio.wait_for(ws.recv(), .2)
                session = next(iter(server.clients))
                self.assertEqual(session.sessions, {})
                self.assertEqual(session.tasks, {})


class IdentitySafety(unittest.TestCase):
    def test_configured_prediction_and_lost_hold_deadlines(self):
        tracker_module = implementation(self, 'tracker')
        live_module = implementation(self, 'sources.live_source')
        source = live_module.LiveSource(None, None, .4, .5, lambda:1000, reacquire_ms=200, lost_hold_ms=500)
        tracker = source.tracker
        target = box()
        tracker.update([target], scene([target], ['red']), 1000, 1000)
        self.assertEqual(tracker.update([], scene([], []), 1199, 1199)['state'], 'tracking')
        self.assertEqual(tracker.update([], scene([], []), 1200, 1200)['state'], 'lost')
        self.assertEqual(tracker.update([], scene([], []), 1699, 1699)['state'], 'lost')
        self.assertEqual(tracker.update([], scene([], []), 1700, 1700)['state'], 'idle')
        for options in ({'reacquire_ms':99}, {'reacquire_ms':5001}, {'lost_hold_ms':-1}, {'lost_hold_ms':30001}):
            with self.assertRaises(ValueError): tracker_module.TargetTracker(**options)

    def test_ambiguous_same_appearance_prefers_loss(self):
        tracker = implementation(self, 'tracker').TargetTracker()
        tracker.select(.4, .5)
        target = box()
        tracker.update([target], scene([target], ['red']), 1000, 1000)
        neighbors = [box(.27), box(.33)]
        result = tracker.update(neighbors, scene(neighbors, ['red', 'red']), 1100, 1100)
        self.assertEqual(result['state'], 'lost')
        self.assertEqual(result['conf'], 0)

    def test_crossing_never_hands_target_to_different_color(self):
        tracker = implementation(self, 'tracker').TargetTracker()
        target = box(.1, w=.12)
        tracker.select(.16, .5)
        tracker.update([target], scene([target], ['red']), 1000, 1000)
        for index in range(1, 12):
            target = box(.1 + index*.045, w=.12)
            neighbor = box(.75 - index*.045, w=.12)
            result = tracker.update([neighbor, target], scene([neighbor, target], ['blue', 'red']), 1000+index*100, 1000+index*100)
            if result['state'] == 'tracking':
                self.assertLess(abs(result['cx']-(target['x']+.06)), .08)


class ParentSafety(unittest.TestCase):
    def test_actual_parent_sigkill_closes_helper_pipe_and_leaves_no_helper(self):
        implementation(self, 'main')
        script = '''import json,os,subprocess,sys,time
child=subprocess.Popen([sys.executable,'-I','-B',ENTRY,'--source','mock','--port','0'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=os.environ.copy())
print(json.dumps({'child':child.pid}),flush=True)
print(child.stdout.readline().decode().strip(),flush=True)
while True:
    child.stdin.write(b'heartbeat\\n');child.stdin.flush();time.sleep(.1)
'''.replace('ENTRY', repr(str(ROOT / 'main.py')))
        env = dict(os.environ, TRACKER_WS_TOKEN='w'*32, TRACKER_FRAME_TOKEN='f'*32, TRACKER_BACKEND_ORIGIN=ORIGIN)
        parent = subprocess.Popen([sys.executable, '-I', '-B', '-c', script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        helper_pid = None
        def alive(pid):
            try: os.kill(pid, 0); return True
            except ProcessLookupError: return False
        try:
            helper_pid = json.loads(parent.stdout.readline())['child']
            self.assertEqual(json.loads(parent.stdout.readline())['pid'], helper_pid)
            parent.kill(); parent.wait(timeout=3)
            deadline = time.monotonic() + 5
            while alive(helper_pid) and time.monotonic() < deadline: time.sleep(.02)
            self.assertFalse(alive(helper_pid), 'owned tracker must exit after its parent pipe disappears')
        finally:
            if parent.poll() is None: parent.kill(); parent.wait()
            if helper_pid is not None and alive(helper_pid): os.kill(helper_pid, 9)
            parent.stdout.close(); parent.stderr.close()

    def test_cli_watchdog_survives_asyncio_blocked_worker_shutdown(self):
        implementation(self, 'tracker_sidecar')
        script = '''import asyncio,sys,threading
sys.path.insert(0, ROOT)
import tracker_sidecar
class Blocked:
    def __init__(self, **kwargs): self.port=7900
    async def __aenter__(self):
        asyncio.create_task(asyncio.to_thread(threading.Event().wait))
        await asyncio.sleep(.05)
        return self
    async def __aexit__(self,*args): pass
tracker_sidecar.TrackerServer=Blocked
raise SystemExit(tracker_sidecar.main())
'''.replace('ROOT', repr(str(ROOT)))
        child = subprocess.Popen([sys.executable, '-I', '-B', '-c', script], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            ready = json.loads(child.stdout.readline())
            self.assertEqual(ready['pid'], child.pid)
            child.stdin.close()
            child.wait(timeout=5)
            self.assertEqual(child.returncode, 1, 'watchdog must terminate a stuck native/executor worker')
        finally:
            if child.poll() is None: child.kill(); child.wait()
            child.stdout.close(); child.stderr.close()


class DetectorSafety(unittest.TestCase):
    def test_preprocess_letterbox_and_class_filter(self):
        detector = implementation(self, 'detector')
        import numpy as np
        from PIL import Image
        tensor, ratio, size = detector.preprocess(Image.new('RGB', (320, 240), (200, 10, 20)))
        self.assertEqual(ratio, 2)
        self.assertEqual(float(tensor[0, 0, 479, 0]), 200)
        self.assertTrue((tensor[:, :, 480:, :] == 114).all())
        self.assertEqual(tensor.dtype, np.float32)
        output = np.zeros((1, 8400, 85), dtype=np.float32)
        output[0, 0, 4] = 1; output[0, 0, 6] = 1  # Non-person class.
        self.assertEqual(detector.decode(output, ratio, size), [])
        output[0, 0, 5] = float('nan')
        with self.assertRaises(ValueError): detector.decode(output, ratio, size)

    def test_first_inference_acceleration_failure_reopens_cpu(self):
        detector = implementation(self, 'detector')
        import numpy as np
        from PIL import Image
        from types import SimpleNamespace
        class Failed:
            def run(self, *_): raise RuntimeError('private runtime path')
        class CPU:
            def get_inputs(self): return [SimpleNamespace(type='tensor(float)', shape=[1,3,640,640], name='images')]
            def get_outputs(self): return [SimpleNamespace(shape=[1,8400,85])]
            def run(self, *_): return [np.zeros((1,8400,85), dtype=np.float32)]
        instance = detector.OnnxDetector.__new__(detector.OnnxDetector)
        instance.session, instance.provider, instance.input_name = Failed(), 'CoreMLExecutionProvider', 'images'
        instance.inference_count = 0
        calls = []
        def create(providers): calls.append(providers); return CPU()
        instance._create = create
        instance.infer_raw(Image.new('RGB', (40, 30)))
        self.assertEqual(calls, [['CPUExecutionProvider']])
        self.assertEqual(instance.provider, 'CPUExecutionProvider')
        self.assertEqual(instance.inference_count, 1)
