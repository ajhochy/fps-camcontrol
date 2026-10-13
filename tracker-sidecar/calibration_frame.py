"""Private one-shot calibration JPEG pipe. Never persists images or pixels."""
import io
import json
import sys

MAX_BYTES = 2 * 1024 * 1024
MAX_PIXELS = 8 * 1024 * 1024


def decode_jpeg(data):
    if not data or len(data) > MAX_BYTES: raise ValueError('calibration_frame_invalid')
    from PIL import Image
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.format != 'JPEG' or image.width * image.height > MAX_PIXELS:
                raise ValueError('calibration_frame_invalid')
            grayscale = image.convert('L').resize((160, 90), Image.Resampling.BILINEAR)
            return dict(width=160, height=90, pixels=list(grayscale.get_flattened_data()))
    except Exception:
        raise ValueError('calibration_frame_invalid') from None


def main():
    try:
        result = decode_jpeg(sys.stdin.buffer.read(MAX_BYTES + 1))
        sys.stdout.write(json.dumps(result, separators=(',', ':')) + '\n')
        return 0
    except Exception:
        sys.stderr.write('calibration_frame_invalid\n')
        return 1


if __name__ == '__main__': raise SystemExit(main())
