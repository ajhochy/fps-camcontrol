"""Deterministic metadata-only trajectories. Never imports a vision package."""
import math
from sources.base import sentinel


class MockSource:
    def __init__(self, trajectory='stationary'):
        if trajectory not in ('stationary', 'sine', 'exit-frame'):
            raise ValueError('invalid_trajectory')
        self.trajectory = trajectory

    def sample(self, elapsed_ms, frame_ms):
        if self.trajectory == 'exit-frame' and elapsed_ms >= 2000:
            return sentinel('idle' if elapsed_ms >= 5000 else 'lost', frame_ms)
        cx = .5
        if self.trajectory == 'sine': cx += .25 * math.sin(elapsed_ms / 1000.)
        if self.trajectory == 'exit-frame': cx += min(.39, elapsed_ms / 5000.)
        return dict(state='tracking', cx=cx, cy=.5, w=.2, h=.4, conf=.9,
                    frameTs=frame_ms, processedAt=frame_ms)
