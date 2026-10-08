"""Original MIT-licensed constant-velocity Kalman and appearance helpers."""
import math
import numpy as np


def valid_box(box):
    if not isinstance(box, dict) or set(box) != {'x', 'y', 'w', 'h', 'conf'}: return False
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in box.values()): return False
    return (0 <= box['x'] < 1 and 0 <= box['y'] < 1 and 0 < box['w'] <= 1 and 0 < box['h'] <= 1 and
            box['x'] + box['w'] <= 1 + 1e-8 and box['y'] + box['h'] <= 1 + 1e-8 and 0 < box['conf'] <= 1)


def center(box):
    return box['x'] + box['w']/2, box['y'] + box['h']/2


def iou(a, b):
    intersection = max(0, min(a['x']+a['w'], b['x']+b['w'])-max(a['x'], b['x'])) * max(0, min(a['y']+a['h'], b['y']+b['h'])-max(a['y'], b['y']))
    union = a['w']*a['h'] + b['w']*b['h'] - intersection
    return intersection / union if union > 0 else 0.


def appearance(image, box):
    width, height = image.size
    x1, y1 = int(box['x']*width), int(box['y']*height)
    x2, y2 = min(width, max(x1+1, int((box['x']+box['w'])*width))), min(height, max(y1+1, int((box['y']+box['h'])*height)))
    crop = np.asarray(image.crop((x1, y1, x2, y2)).convert('RGB'))
    # Independent coarse channel histograms are small, deterministic, and never
    # serialized. This is not facial recognition or a persistent embedding.
    values = np.concatenate([np.histogram(crop[:, :, channel], bins=16, range=(0, 256))[0] for channel in range(3)]).astype(np.float64)
    return values / max(1., values.sum())


def similarity(a, b):
    return float(np.sqrt(a*b).sum())


class Kalman:
    def __init__(self, box, now):
        cx, cy = center(box)
        self.state = np.array([cx, cy, 0., 0.])
        self.covariance = np.diag([.01, .01, .25, .25])
        self.at = now

    def predict(self, now):
        dt = min(1., max(0., (now-self.at)/1000))
        transition = np.array([[1., 0, dt, 0], [0, 1., 0, dt], [0, 0, 1., 0], [0, 0, 0, 1.]])
        self.state = transition @ self.state
        self.covariance = transition @ self.covariance @ transition.T + np.diag([.0002, .0002, .005, .005])*max(dt, .001)
        self.at = now
        return self.state[:2]

    def update(self, box):
        observation = np.array([[1., 0, 0, 0], [0, 1., 0, 0]])
        noise = np.eye(2)*.00005
        innovation = np.asarray(center(box)) - observation @ self.state
        gain = self.covariance @ observation.T @ np.linalg.inv(observation @ self.covariance @ observation.T + noise)
        self.state += gain @ innovation
        self.covariance = (np.eye(4)-gain @ observation) @ self.covariance
        return self.state[:2]

    def clear(self):
        self.state.fill(0); self.covariance.fill(0)
