import unittest
from sidecar_test_support import ROOT, implementation


def box(x=.3, y=.3, w=.2, h=.4, conf=.9):
    return dict(x=x, y=y, w=w, h=h, conf=conf)


def scene(boxes, colors):
    from PIL import Image, ImageDraw
    image = Image.new('RGB', (200, 200), 'black')
    draw = ImageDraw.Draw(image)
    for b, color in zip(boxes, colors):
        draw.rectangle((int(b['x'] * 200), int(b['y'] * 200), int((b['x'] + b['w']) * 200)-1, int((b['y'] + b['h']) * 200)-1), fill=color)
    return image


class IdentityContract(unittest.TestCase):
    def tracker(self, **kwargs):
        return implementation(self, 'tracker').TargetTracker(**kwargs)

    def lock(self, **kwargs):
        tracker = self.tracker(**kwargs)
        tracker.select(.4, .5)
        target = box()
        result = tracker.update([target], scene([target], ['red']), 1000, 1000)
        self.assertEqual(result['state'], 'tracking')
        return tracker

    def test_issue31_c1(self):
        tracker = self.tracker(radius=.1)
        outer, inner = box(.1, .1, .8, .8), box()
        tracker.select(.4, .5)
        result = tracker.update([outer, inner], scene([outer, inner], ['blue', 'red']), 1000, 1000)
        self.assertAlmostEqual(result['w'], .2)
        narrow = box(.4, w=.1)
        tracker.select(.52, .5)  # Outside the right edge, but within .1 of center.
        self.assertEqual(tracker.update([narrow], scene([narrow], ['red']), 1100, 1100)['state'], 'tracking')
        tracker.select(.01, .01)
        self.assertEqual(tracker.update([inner], scene([inner], ['red']), 1200, 1200)['state'], 'idle')
        self.assertEqual(tracker.error_code, 'no_target')

    def test_issue31_c2(self):
        tracker = self.lock()
        for index in range(1, 5):
            target, neighbor = box(.3 + index * .02), box(.65 - index * .02)
            result = tracker.update([neighbor, target], scene([neighbor, target], ['blue', 'red']), 1000 + index * 100, 1000 + index * 100)
            self.assertEqual(result['state'], 'tracking')
            self.assertLess(abs(result['cx'] - (target['x'] + .1)), .035)
        neighbor = box(.38)
        result = tracker.update([neighbor], scene([neighbor], ['blue']), 1600, 1600)
        self.assertEqual(result['state'], 'lost', 'appearance mismatch must not replace selected person')

    def test_issue31_c3(self):
        tracker = self.lock(reacquire_ms=400)
        result = tracker.update([], scene([], []), 1100, 1100)
        self.assertEqual(result['state'], 'tracking')
        self.assertGreater(result['conf'], 0)
        self.assertLess(result['conf'], .9)
        self.assertEqual(result['frameTs'], 1000, 'prediction never refreshes genuine observation time')

    def test_issue31_c4(self):
        tracker = self.lock(reacquire_ms=400, lost_hold_ms=3000)
        self.assertEqual(tracker.update([], scene([], []), 1500, 1500)['state'], 'lost')
        wrong = box()
        self.assertEqual(tracker.update([wrong], scene([wrong], ['blue']), 1600, 1600)['state'], 'lost')
        self.assertEqual(tracker.update([wrong], scene([wrong], ['red']), 1700, 1700)['state'], 'tracking')
        self.assertEqual(tracker.update([], scene([], []), 5100, 5100)['state'], 'idle')
        self.assertIsNone(tracker.appearance)

    def test_issue31_c5(self):
        tracker = self.lock()
        original = tracker.appearance
        tracker.cancel()
        self.assertIsNone(tracker.appearance)
        self.assertTrue((original == 0).all(), 'old histogram buffer must also be wiped')
        self.assertEqual(tracker.state, 'idle')

    def test_issue31_c6(self):
        tracker = self.lock()
        moved = box(.32)
        result = tracker.update([moved], scene([moved], ['red']), 1100, 1120)
        self.assertEqual(result['frameTs'], 1100)
        self.assertEqual(result['processedAt'], 1120)
        self.assertGreaterEqual(result['cx'] - result['w'] / 2, 0)
        self.assertLessEqual(result['cx'] + result['w'] / 2, 1)

    def test_issue31_c7(self):
        implementation(self, 'association')
        self.assertIn('original', (ROOT / 'THIRD_PARTY_NOTICES.md').read_text())
        self.assertNotIn('opencv', (ROOT / 'requirements.txt').read_text().lower())
