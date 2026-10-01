"""Owned-process parent pipe watchdog, independent of the asyncio event loop."""
import os
import select
import threading
import time


class ParentWatchdog:
    def __init__(self, lost, *, fd=0, deadline=3., grace=2., terminate=os._exit):
        self.lost, self.fd, self.deadline, self.grace, self.terminate = lost, fd, deadline, grace, terminate
        self.closed = threading.Event()
        self.requested = threading.Event()
        self.thread = threading.Thread(target=self._run, name='tracker-parent-watchdog', daemon=True)

    def start(self):
        self.thread.start()

    def close(self):
        self.closed.set()

    def request_stop(self):
        self.requested.set()

    def _run(self):
        last = time.monotonic()
        pending = b''
        try:
            while not self.closed.is_set():
                if self.requested.is_set(): break
                if time.monotonic()-last >= self.deadline: break
                ready, _, _ = select.select([self.fd], [], [], min(.1, self.deadline))
                if not ready: continue
                chunk = os.read(self.fd, 1024)
                if not chunk: break
                pending += chunk
                if len(pending) > 1024: break
                invalid = False
                while b'\n' in pending:
                    line, pending = pending.split(b'\n', 1)
                    if line != b'heartbeat': invalid = True; break
                    last = time.monotonic()
                if invalid: break
        except (OSError, ValueError):
            pass
        if self.closed.is_set(): return
        try: self.lost()
        except Exception: pass
        # Normal EOF asks the event loop to wipe sessions/close sockets first.
        # If native inference is blocked, terminate only this owned process.
        if not self.closed.wait(self.grace): self.terminate(1)
