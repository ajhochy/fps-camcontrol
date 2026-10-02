"""Aggregate-only actual ONNX + synthetic JPEG/HTTP timing, never real footage."""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import sys
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


async def measure(model, count=12):
    from PIL import Image, ImageDraw
    from detector import OnnxDetector, MODEL_SHA256
    from frames import FrameFetcher
    from sources.live_source import InferenceLane
    detector = OnnxDetector(model)
    lane = InferenceLane(detector)
    images = []
    for background in ((50, 80, 110), (110, 80, 50)):
        image = Image.new('RGB', (640, 480), background)
        ImageDraw.Draw(image).rectangle((240, 150, 320, 400), fill=(180, 40, 30))
        body = io.BytesIO(); image.save(body, format='JPEG'); images.append(body.getvalue())
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def do_GET(self):
            if self.headers.get('Authorization') != 'Bearer ' + 'f'*32:
                self.send_response(401); self.end_headers(); return
            requests.append(1)
            body = images[len(requests) % len(images)]
            self.send_response(200)
            self.send_header('Content-Type', 'image/jpeg')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('X-Frame-Captured-At', str(time.time_ns()//1000000))
            self.end_headers(); self.wfile.write(body)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    origin = 'http://127.0.0.1:' + str(server.server_port)
    fetcher = FrameFetcher(origin + '/api/sony/cameras/synthetic/live-view/frame', 'f'*32, origin)
    durations, ages, people = [], [], []
    began = time.perf_counter()
    try:
        for _ in range(count):
            frame = await fetcher.fetch()
            if frame is None: raise AssertionError('Synthetic frame receipt failed')
            inference = time.perf_counter()
            detections = await lane.detect(frame.image)
            durations.append((time.perf_counter()-inference)*1000)
            ages.append(time.time_ns()//1000000 - frame.captured_at)
            people.append(len(detections))
            frame.image.close()
        elapsed = time.perf_counter()-began
        percentile = lambda values, fraction: sorted(values)[min(len(values)-1, int((len(values)-1)*fraction))]
        return dict(modelSha256=MODEL_SHA256, provider=detector.provider, inferenceCount=detector.inference_count,
                    frames=count, requests=len(requests), fps=count/elapsed,
                    detectP50Ms=percentile(durations,.5), detectP95Ms=percentile(durations,.95),
                    frameAgeP50Ms=percentile(ages,.5), frameAgeP95Ms=percentile(ages,.95), frameAgeMaxMs=max(ages),
                    peopleCounts=people, degradedTiming=fetcher.metrics.degraded_timing,
                    scope='Actual model and synthetic loopback JPEG transport; not Sony exposure/motion latency or accuracy')
    finally:
        await fetcher.close(); await asyncio.to_thread(server.shutdown); server.server_close()


if __name__ == '__main__':
    if len(sys.argv) != 2: raise SystemExit('model_path_required')
    print(json.dumps(asyncio.run(measure(Path(sys.argv[1]))), sort_keys=True))
