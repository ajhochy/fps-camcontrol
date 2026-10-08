"""Bundled isolated-Python entry point; no cwd or host site-package imports."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tracker_sidecar import main

if __name__ == '__main__': raise SystemExit(main())
