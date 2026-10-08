"""Bounded, authenticated JPEG polling; source pixels remain in memory only."""
import asyncio
from collections import deque
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
import io
import math
import time
import urllib.error
import urllib.request

from protocol import validate_frame_url

MAX_FRAME_BYTES = 2 * 1024 * 1024
MAX_FRAME_PIXELS = 8 * 1024 * 1024


class FrameError(ValueError):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise FrameError('redirect_rejected')


def request_frame(url, headers, timeout, max_bytes):
    # Never inherit HTTP(S)_PROXY, cookies, credentials or redirect behavior.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    try:
        with opener.open(urllib.request.Request(url, headers=headers), timeout=timeout) as response:
            size = response.headers.get('Content-Length')
            if size and (not size.isdigit() or int(size) > max_bytes):
                raise FrameError('frame_too_large')
            body = response.read(max_bytes + 1)
            if len(body) > max_bytes: raise FrameError('frame_too_large')
            return response.status, dict(response.headers), body
    except urllib.error.HTTPError as error:
        # Do not read/store arbitrary error bodies or follow redirects.
        return error.code, dict(error.headers), b''


@dataclass
class Frame:
    image: object
    captured_at: int
    received_at: int
    degraded_timing: bool


class Metrics:
    def __init__(self):
        self.busy = 0
        self.dropped = 0
        self.degraded_timing = False
        self.durations = deque(maxlen=256)
        self.frame_age = 0.
        self.frames = 0
        self.last_status = None
        self.last_frames = 0

    def record(self, detect_ms, frame_age, now):
        self.durations.append(max(0., float(detect_ms)))
        self.frame_age = max(0., float(frame_age))
        self.frames += 1

    def status(self, source_id, now):
        if self.last_status is not None and now - self.last_status < 1000: return None
        elapsed = 1000 if self.last_status is None else max(1, now - self.last_status)
        values = sorted(self.durations)
        percentile = lambda fraction: values[min(len(values)-1, math.ceil(len(values)*fraction)-1)] if values else 0.
        result = dict(protocol=1, type='status', sourceId=source_id,
                      fps=(self.frames-self.last_frames)*1000/elapsed, dropped=self.dropped, busy=self.busy,
                      detectP50Ms=percentile(.5), detectP95Ms=percentile(.95), frameAgeMs=self.frame_age,
                      degradedTiming=self.degraded_timing)
        self.last_frames, self.last_status = self.frames, now
        return result


class FrameFetcher:
    def __init__(self, url, token, backend_origin, *, requester=request_frame,
                 clock=lambda: time.time_ns() // 1000000, sleep=asyncio.sleep):
        self.url = validate_frame_url(url, backend_origin)
        self.token = token
        self.requester, self.clock, self.sleep = requester, clock, sleep
        self.metrics = Metrics()
        self.next_delay = .125
        self.errors = 0
        self.last_timestamp = None
        self._lock = asyncio.Lock()
        self._pending = None

    def _backoff(self):
        self.errors += 1
        self.next_delay = min(5., .25 * 2 ** min(self.errors-1, 5))
        self.metrics.dropped += 1

    def _retry_after(self, value):
        try:
            delay = float(value)
        except (ValueError, TypeError):
            try: delay = parsedate_to_datetime(value).timestamp() - self.clock()/1000
            except (ValueError, TypeError, OverflowError): return 0.
        return min(30., max(0., delay)) if math.isfinite(delay) else 0.

    async def fetch(self):
        async with self._lock:
            await self.sleep(self.next_delay)
            try:
                if self._pending is None:
                    self._pending = asyncio.create_task(asyncio.to_thread(
                        self.requester, self.url,
                        {'Authorization': 'Bearer ' + self.token, 'Accept': 'image/jpeg'}, 2., MAX_FRAME_BYTES))
                # Canceling a session cannot cancel its socket thread. Preserve
                # and join that exact request before a new session can start one.
                response = await asyncio.shield(self._pending)
                self._pending = None
                status, raw_headers, body = response
                received = self.clock()
                headers = {key.lower(): value for key, value in raw_headers.items()}
                if status == 503:
                    self.metrics.busy += 1
                    self._backoff()
                    self.next_delay = max(self.next_delay, self._retry_after(headers.get('retry-after')))
                    return None
                if status != 200 or len(body) > MAX_FRAME_BYTES or headers.get('content-type', '').split(';')[0].strip().lower() != 'image/jpeg':
                    raise FrameError('invalid_frame')
                captured = headers.get('x-frame-captured-at')
                degraded = captured is None
                if degraded: timestamp = received
                elif isinstance(captured, str) and captured.isdecimal(): timestamp = int(captured)
                else: raise FrameError('invalid_timestamp')
                if timestamp < 0 or timestamp > received + 50 or timestamp > 9007199254740991:
                    raise FrameError('invalid_timestamp')
                if timestamp == self.last_timestamp:
                    self.metrics.dropped += 1
                    self.next_delay = .125
                    return None
                if self.last_timestamp is not None and timestamp < self.last_timestamp:
                    raise FrameError('regressed_timestamp')
                from PIL import Image
                with Image.open(io.BytesIO(body)) as encoded:
                    if encoded.format != 'JPEG' or encoded.width * encoded.height > MAX_FRAME_PIXELS:
                        raise FrameError('invalid_image')
                    # Sony geometry uses encoded image coordinates; EXIF rotation
                    # is deliberately not applied independently of the UI.
                    image = encoded.convert('RGB')
                self.last_timestamp = timestamp
                self.errors, self.next_delay = 0, .125
                self.metrics.degraded_timing |= degraded
                return Frame(image, timestamp, received, degraded)
            except asyncio.CancelledError:
                raise
            except Exception:
                if self._pending is not None and self._pending.done(): self._pending = None
                self._backoff()
                return None

    async def close(self):
        if self._pending is not None:
            try: await asyncio.shield(self._pending)
            except Exception: pass
            self._pending = None
