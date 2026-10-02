import io
import json
import subprocess
import sys
import unittest
from sidecar_test_support import ROOT, implementation


class CalibrationFrameContract(unittest.TestCase):
    def test_actual_isolated_helper_decodes_bounded_synthetic_jpeg(self):
        implementation(self, 'calibration_frame')
        from PIL import Image
        encoded = io.BytesIO()
        Image.new('RGB', (320, 180), (80, 80, 80)).save(encoded, format='JPEG')
        result = subprocess.run([sys.executable, '-I', '-B', str(ROOT / 'calibration_frame.py')],
                                input=encoded.getvalue(), capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(len(result.stdout), 65536)
        self.assertEqual(result.stderr, b'')
        value = json.loads(result.stdout)
        self.assertEqual(set(value), {'width', 'height', 'pixels'})
        self.assertEqual((value['width'], value['height']), (160, 90))
        self.assertEqual(len(value['pixels']), 14400)
        self.assertTrue(all(type(pixel) is int and 0 <= pixel <= 255 for pixel in value['pixels']))
        self.assertAlmostEqual(sum(value['pixels'])/14400, 80, delta=1)

    def test_invalid_oversize_and_non_jpeg_are_curated(self):
        module = implementation(self, 'calibration_frame')
        for body in (b'private corrupt frame', b'x'*(2*1024*1024+1)):
            with self.assertRaises(ValueError): module.decode_jpeg(body)
        result = subprocess.run([sys.executable, '-I', '-B', str(ROOT / 'calibration_frame.py')],
                                input=b'private corrupt frame', capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b'')
        self.assertEqual(result.stderr, b'calibration_frame_invalid\n')
