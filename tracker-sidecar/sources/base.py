"""Small source boundary used by live and deterministic mock implementations."""
from typing import Protocol


class Source(Protocol):
    async def next(self): ...
    def cancel(self): ...


def sentinel(state, now):
    return dict(state=state, cx=0., cy=0., w=0., h=0., conf=0., frameTs=0, processedAt=now)
