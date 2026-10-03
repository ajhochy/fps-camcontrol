"""Live frame-to-target composition. Cancellation wipes identity immediately."""
import asyncio
import time
from tracker import TargetTracker


class InferenceLane:
    """At most one native inference; canceled work cannot release its slot early."""
    def __init__(self, detector):
        self.detector = detector
        self.lock = asyncio.Lock()

    async def detect(self, image):
        try:
            await self.lock.acquire()
        except asyncio.CancelledError:
            # No native task owns this frame while it is queued for the lane.
            image.close()
            raise
        task = asyncio.create_task(asyncio.to_thread(self.detector.detect, image))
        released = False
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            def finished(completed):
                try: completed.result()
                except Exception: pass
                image.close()
                self.lock.release()
            task.add_done_callback(finished)
            released = True
            raise
        finally:
            if not released: self.lock.release()


class LiveSource:
    def __init__(self, fetcher, lane, x, y, clock, *, reacquire_ms=1000, lost_hold_ms=3000):
        self.fetcher, self.lane, self.clock = fetcher, lane, clock
        self.tracker = TargetTracker(reacquire_ms=reacquire_ms, lost_hold_ms=lost_hold_ms)
        self.tracker.select(x, y)

    async def next(self):
        frame = await self.fetcher.fetch()
        if frame is None: return None
        began = time.perf_counter()
        try:
            detections = await self.lane.detect(frame.image)
            now = self.clock()
            result = self.tracker.update(detections, frame.image, frame.captured_at, now)
            self.fetcher.metrics.record((time.perf_counter()-began)*1000, now-frame.captured_at, now)
            frame.image.close()
            return result
        except asyncio.CancelledError:
            # The lane closes queued frames now or retained native frames later.
            raise
        except Exception:
            frame.image.close()
            self.tracker.cancel()
            raise

    def cancel(self):
        self.tracker.cancel()
