"""Exclusive click-to-lock with conservative in-memory appearance gating."""
import math
from association import Kalman, appearance, center, iou, similarity, valid_box
from sources.base import sentinel


class TargetTracker:
    def __init__(self, *, radius=.12, reacquire_ms=1000, lost_hold_ms=3000, appearance_threshold=.82):
        if type(reacquire_ms) is not int or not 100 <= reacquire_ms <= 5000 or type(lost_hold_ms) is not int or not 0 <= lost_hold_ms <= 30000:
            raise ValueError('invalid_tracking_timing')
        self.radius, self.reacquire_ms, self.lost_hold_ms = radius, reacquire_ms, lost_hold_ms
        self.appearance_threshold = appearance_threshold
        self.appearance = None
        self.filter = None
        self.box = None
        self.click = None
        self.state = 'idle'
        self.error_code = None
        self.frame_ts = 0
        self.last_seen = 0
        self.lost_since = None

    def cancel(self):
        if self.appearance is not None: self.appearance.fill(0)
        if self.filter is not None: self.filter.clear()
        self.appearance = self.filter = self.box = self.click = None
        self.state, self.error_code = 'idle', None
        self.frame_ts = self.last_seen = 0
        self.lost_since = None

    def select(self, x, y):
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1 for value in (x, y)):
            raise ValueError('invalid_selection')
        self.cancel()
        self.click, self.state = (x, y), 'locking'

    def _choose(self, detections):
        x, y = self.click
        containing = [box for box in detections if box['x'] <= x <= box['x']+box['w'] and box['y'] <= y <= box['y']+box['h']]
        if containing: return min(containing, key=lambda box: box['w']*box['h'])
        distances = [(math.dist((x, y), center(box)), box) for box in detections]
        closest = min(distances, key=lambda entry: entry[0], default=None)
        return closest[1] if closest and closest[0] <= self.radius else None

    def _geometry(self, now, confidence):
        if self.box is None: return sentinel(self.state, now)
        cx, cy = self.filter.state[:2]
        width, height = self.box['w'], self.box['h']
        cx = min(1-width/2, max(width/2, float(cx)))
        cy = min(1-height/2, max(height/2, float(cy)))
        return dict(state=self.state, cx=cx, cy=cy, w=width, h=height,
                    conf=confidence, frameTs=self.frame_ts, processedAt=max(now, self.frame_ts))

    def update(self, detections, image, frame_ts, now):
        self.error_code = None
        detections = [box for box in detections if valid_box(box)]
        if self.state == 'idle': return sentinel('idle', now)
        if self.state == 'locking':
            selected = self._choose(detections)
            if selected is None:
                self.cancel(); self.error_code = 'no_target'
                return sentinel('idle', now)
            self.box = dict(selected)
            self.appearance = appearance(image, selected)
            self.filter = Kalman(selected, now)
            self.frame_ts, self.last_seen, self.state = frame_ts, now, 'tracking'
            self.click = None
            return self._geometry(now, selected['conf'])
        elapsed = max(0, now-self.last_seen)
        loss_boundary = self.lost_since if self.lost_since is not None else self.last_seen + self.reacquire_ms
        if now >= loss_boundary + self.lost_hold_ms:
            self.cancel()
            return sentinel('idle', now)
        predicted = self.filter.predict(now)
        expected = dict(self.box, x=float(predicted[0]-self.box['w']/2), y=float(predicted[1]-self.box['h']/2))
        candidates = []
        if frame_ts > self.frame_ts:
            for candidate in detections:
                distance = math.dist(center(candidate), predicted)
                overlap = iou(expected, candidate)
                if distance > .22 and overlap < .05: continue
                histogram = appearance(image, candidate)
                agreement = similarity(self.appearance, histogram)
                histogram.fill(0)
                if agreement >= self.appearance_threshold:
                    candidates.append((agreement + .25*overlap - .5*distance, candidate))
        candidates.sort(key=lambda entry: entry[0], reverse=True)
        ambiguous = len(candidates) > 1 and candidates[0][0] - candidates[1][0] < .08
        if candidates and not ambiguous:
            selected = candidates[0][1]
            self.filter.update(selected)
            self.box = dict(selected)
            self.frame_ts, self.last_seen, self.state = frame_ts, now, 'tracking'
            self.lost_since = None
            return self._geometry(now, selected['conf'])
        # Visible but mismatched/ambiguous people are positive evidence against
        # identity continuity. Prefer loss to handing control to a neighbor.
        if detections or ambiguous or elapsed >= self.reacquire_ms or self.state == 'lost':
            self.state = 'lost'
            if self.lost_since is None:
                self.lost_since = now if detections else self.last_seen + self.reacquire_ms
            if now >= self.lost_since + self.lost_hold_ms:
                self.cancel()
                return sentinel('idle', now)
            return self._geometry(now, 0.)
        self.state = 'tracking'
        return self._geometry(now, self.box['conf'] * max(.1, 1-elapsed/self.reacquire_ms))
