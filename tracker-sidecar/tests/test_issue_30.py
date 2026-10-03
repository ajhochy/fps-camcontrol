import asyncio
import io
import os
from pathlib import Path
import unittest
from sidecar_test_support import ROOT, implementation

URL = 'http://127.0.0.1:8175/api/sony/cameras/test/live-view/frame'


def jpeg():
    from PIL import Image
    result = io.BytesIO()
    Image.new('RGB', (40, 30), 'red').save(result, format='JPEG')
    return result.getvalue()


class DetectionContract(unittest.IsolatedAsyncioTestCase):
    def fetcher(self, requester, **kwargs):
        return implementation(self, 'frames').FrameFetcher(URL, 'f' * 32, 'http://127.0.0.1:8175',
                                                         requester=requester, clock=lambda: 10000, **kwargs)

    async def test_issue30_c1(self):
        sleeps, calls = [], []
        async def sleep(delay): sleeps.append(delay)
        def request(*args):
            calls.append(args)
            return (503, {'Retry-After': '2'}, b'private camera details')
        fetcher = self.fetcher(request, sleep=sleep)
        self.assertIsNone(await fetcher.fetch())
        self.assertIsNone(await fetcher.fetch())
        self.assertGreaterEqual(sleeps[-1], 2)
        self.assertEqual(fetcher.metrics.busy, 2)
        self.assertEqual(calls[0][1], {'Authorization': 'Bearer ' + 'f' * 32, 'Accept': 'image/jpeg'})
        self.assertGreater(fetcher.next_delay, 0)

    async def test_issue30_c2(self):
        fetcher = self.fetcher(lambda *_: (200, {'Content-Type': 'image/jpeg', 'X-Frame-Captured-At': '9990'}, jpeg()))
        first = await fetcher.fetch()
        self.assertEqual(first.captured_at, 9990)
        self.assertIsNone(await fetcher.fetch())
        self.assertEqual(fetcher.metrics.dropped, 1)

    async def test_issue30_c3(self):
        fetcher = self.fetcher(lambda *_: (200, {'Content-Type': 'image/jpeg'}, jpeg()))
        frame = await fetcher.fetch()
        self.assertEqual(frame.captured_at, 10000)
        self.assertTrue(frame.degraded_timing)
        self.assertTrue(fetcher.metrics.degraded_timing)

    def test_issue30_c4(self):
        detector = implementation(self, 'detector')
        import numpy as np
        from PIL import Image
        tensor, ratio, size = detector.preprocess(Image.new('RGB', (640, 640), (255, 0, 0)))
        self.assertEqual(tensor.shape, (1, 3, 640, 640))
        self.assertEqual(float(tensor[0, 0, 0, 0]), 255, 'YOLOX input is not /255 normalized')
        output = np.zeros((1, 8400, 85), dtype=np.float32)
        index = 40 * 80 + 40
        output[0, index, :4] = [0, 0, np.log(20), np.log(20)]
        output[0, index, 4:6] = [1, .9]
        boxes = detector.decode(output, ratio, size)
        self.assertEqual(len(boxes), 1)
        self.assertAlmostEqual(boxes[0]['x'], .375)
        self.assertAlmostEqual(boxes[0]['w'], .25)
        self.assertGreater(boxes[0]['conf'], .89)

    def test_issue30_c5(self):
        detector = implementation(self, 'detector')
        notices = (ROOT / 'THIRD_PARTY_NOTICES.md').read_text()
        self.assertIn('Apache-2.0', notices)
        self.assertIn('c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063', notices)
        self.assertNotIn('ultralytics', (ROOT / 'requirements.txt').read_text().lower())
        with self.assertRaises(detector.ModelUnavailable):
            detector.verify_model(ROOT / 'requirements.txt')

    def test_issue30_c6(self):
        detector = implementation(self, 'detector')
        calls = []
        def create(providers):
            calls.append(providers)
            if providers[0] == 'CoreMLExecutionProvider': raise RuntimeError('private accelerated failure')
            return object()
        _, provider = detector.create_provider_session(create, ['CoreMLExecutionProvider', 'CPUExecutionProvider'])
        self.assertEqual(provider, 'CPUExecutionProvider')
        self.assertEqual(calls[0][0], 'CoreMLExecutionProvider')

    async def test_issue30_c7(self):
        detector = implementation(self, 'detector')
        if not os.environ.get('TRACKER_TEST_MODEL'):
            self.skipTest('opt-in actual model proof requires TRACKER_TEST_MODEL')
        report = detector.verify_inference(Path(os.environ['TRACKER_TEST_MODEL']))
        self.assertEqual(report['inferenceCount'], 2)
        self.assertEqual(report['shape'], [1, 8400, 85])
        self.assertTrue(report['finite'])
        self.assertTrue(report['inputDependent'])
        self.assertGreater(report['detectP95Ms'], 0)
        self.assertGreater(report['fps'], 0)
        from model_pipeline_probe import measure
        pipeline = await measure(Path(os.environ['TRACKER_TEST_MODEL']), count=4)
        self.assertEqual(pipeline['requests'], 4)
        self.assertEqual(pipeline['inferenceCount'], 4)
        self.assertFalse(pipeline['degradedTiming'])
        self.assertGreater(pipeline['frameAgeP95Ms'], 0)
        self.assertLessEqual(pipeline['fps'], 8)

    def test_issue30_c8(self):
        implementation(self, 'fetch_model')
        self.assertIn('models/', (ROOT / '.gitignore').read_text())
        self.assertIn('fetch_model.py', (ROOT / 'README.md').read_text())
        self.assertEqual(list(ROOT.rglob('*.onnx')), [])

    def test_issue30_c9(self):
        metrics = implementation(self, 'frames').Metrics()
        metrics.record(12, 20, 1000)
        message = metrics.status('gimbal', 1000)
        self.assertIsNotNone(message)
        self.assertIsNone(metrics.status('gimbal', 1500))
        self.assertGreater(metrics.status('gimbal', 2000)['detectP50Ms'], 0)
        self.assertEqual(set(message), {'type', 'protocol', 'sourceId', 'fps', 'dropped', 'busy', 'detectP50Ms', 'detectP95Ms', 'frameAgeMs', 'degradedTiming'})
