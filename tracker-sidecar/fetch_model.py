"""Explicit build/developer fetch; never invoked automatically by the helper."""
import argparse
import hashlib
import os
from pathlib import Path
import sys
import tempfile
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
from model_manifest import MODEL_BYTES, MODEL_NAME, MODEL_SHA256, MODEL_URL


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('model_redirect_rejected')


def fetch(destination):
    destination = Path(destination).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    digest, size = hashlib.sha256(), 0
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix='.model-', suffix='.partial', dir=destination.parent, delete=False) as output:
            temporary = Path(output.name)
            with opener.open(MODEL_URL, timeout=30) as response:
                for chunk in iter(lambda: response.read(1024*1024), b''):
                    size += len(chunk)
                    if size > MODEL_BYTES: raise ValueError('model_size_mismatch')
                    digest.update(chunk); output.write(chunk)
            output.flush(); os.fsync(output.fileno())
        if size != MODEL_BYTES or digest.hexdigest() != MODEL_SHA256: raise ValueError('model_checksum_mismatch')
        os.replace(temporary, destination)
    finally:
        if temporary is not None and temporary.exists(): temporary.unlink()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Explicitly fetch the pinned Apache-2.0 model')
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parent / 'models' / MODEL_NAME)
    args = parser.parse_args()
    try: fetch(args.output)
    except Exception:
        print('model_fetch_failed', file=sys.stderr)
        raise SystemExit(1)
    print('Model checksum verified.')
