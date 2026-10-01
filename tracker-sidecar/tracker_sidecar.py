"""Authenticated loopback tracker service; stdout contains ready metadata only."""
import argparse
import asyncio
import hmac
from http import HTTPStatus
import json
import logging
import os
from pathlib import Path
import signal
import sys
import time

# Python -I deliberately omits script cwd. Add only this trusted bundled source.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from protocol import MAX_MESSAGE_BYTES, encode, parse_message, validate_origin
from sources.base import sentinel
from sources.mock_source import MockSource

VERSION = '1.0.0'


class Session:
    def __init__(self, server, ws):
        self.server, self.ws = server, ws
        self.hello = False
        self.sources, self.sessions, self.fetchers = {}, {}, {}
        self.tasks = {}
        self.last_ping = time.monotonic()

    async def emit(self, message):
        await self.ws.send(encode(message))

    async def error(self, code, source_id=None, session_id=None):
        descriptions = {'invalid_message': 'Invalid tracking message.', 'handshake_required': 'Hello is required first.',
                        'unknown_source': 'Tracking source is not configured.', 'no_target': 'No person near the selection.',
                        'source_unavailable': 'Tracking source is unavailable.'}
        message = dict(protocol=1, type='error', code=code, message=descriptions[code])
        if source_id is not None: message['sourceId'] = source_id
        if session_id is not None: message['sessionId'] = session_id
        await self.emit(message)

    async def track(self, source_id, entry, values):
        if self.sessions.get(source_id) is not entry: return
        message = dict(protocol=1, type='track', sourceId=source_id, sessionId=entry['id'], seq=entry['seq'], **values)
        entry['seq'] += 1
        await self.emit(message)

    async def cancel(self, source_id, session_id=None, emit=False):
        entry = self.sessions.get(source_id)
        if entry is None or session_id is not None and entry['id'] != session_id: return
        if entry.get('live') is not None: entry['live'].cancel()
        task = self.tasks.pop(source_id, None)
        if task is not None and task is not asyncio.current_task():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        if emit: await self.track(source_id, entry, sentinel('idle', self.server.clock()))
        self.sessions.pop(source_id, None)

    async def reset(self):
        for source_id in list(self.sessions): await self.cancel(source_id)
        for fetcher in self.fetchers.values(): await fetcher.close()
        self.fetchers.clear()
        self.sources.clear()

    async def handle(self, raw):
        try: message = parse_message(raw, self.server.backend_origin)
        except ValueError:
            await self.error('invalid_message'); return
        kind = message['type']
        if kind == 'hello':
            self.hello = True
            await self.emit(dict(protocol=1, type='hello', version=VERSION, capabilities=['person'],
                                 detector=self.server.detector_name, provider=self.server.provider,
                                 degradedTiming=self.server.source == 'live'))
            return
        if not self.hello:
            await self.error('handshake_required'); return
        if kind == 'ping':
            self.last_ping = time.monotonic()
            await self.emit(dict(protocol=1, type='pong', nonce=message['nonce'])); return
        if kind == 'configure':
            await self.reset()
            self.sources = {source['sourceId']: source['frameUrl'] for source in message['sources']}
            return
        source_id = message['sourceId']
        if source_id not in self.sources:
            await self.error('unknown_source', source_id, message['sessionId']); return
        if kind == 'cancel':
            await self.cancel(source_id, message['sessionId'], emit=True); return
        await self.cancel(source_id)
        entry = {'id': message['sessionId'], 'seq': 0, 'started': self.server.clock()}
        self.sessions[source_id] = entry
        if self.server.source == 'live':
            from frames import FrameFetcher
            from sources.live_source import LiveSource
            if source_id not in self.fetchers:
                self.fetchers[source_id] = FrameFetcher(self.sources[source_id], self.server.frame_token,
                                                       self.server.backend_origin, clock=self.server.clock)
            entry['live'] = LiveSource(self.fetchers[source_id], self.server.lane, message['x'], message['y'], self.server.clock,
                                       reacquire_ms=self.server.reacquire_ms, lost_hold_ms=self.server.lost_hold_ms)
        await self.track(source_id, entry, sentinel('locking', self.server.clock()))
        self.tasks[source_id] = asyncio.create_task(self.run_source(source_id, entry))

    async def run_source(self, source_id, entry):
        try:
            mock = MockSource(self.server.trajectory) if self.server.source == 'mock' else None
            while self.sessions.get(source_id) is entry:
                now = self.server.clock()
                if mock is not None:
                    result = mock.sample(now-entry['started'], now)
                    await asyncio.sleep(.125)
                else:
                    result = await entry['live'].next()
                    metric = self.fetchers[source_id].metrics.status(source_id, self.server.clock())
                    if metric: await self.emit(metric)
                if result is None: continue
                await self.track(source_id, entry, result)
                if entry.get('live') is not None and entry['live'].tracker.error_code:
                    await self.error(entry['live'].tracker.error_code, source_id, entry['id'])
                if result['state'] == 'idle':
                    await self.cancel(source_id); return
        except asyncio.CancelledError:
            raise
        except Exception:
            if self.sessions.get(source_id) is entry:
                if entry.get('live') is not None: entry['live'].cancel()
                try:
                    await self.track(source_id, entry, sentinel('idle', self.server.clock()))
                    await self.error('source_unavailable', source_id, entry['id'])
                except Exception: pass
                self.sessions.pop(source_id, None)
        finally:
            if entry.get('live') is not None: entry['live'].cancel()

    async def heartbeat(self):
        while True:
            await asyncio.sleep(.25)
            if time.monotonic()-self.last_ping > 3:
                await self.ws.close(code=1008, reason='heartbeat_timeout'); return

    async def run(self):
        heartbeat = asyncio.create_task(self.heartbeat())
        try:
            async for raw in self.ws:
                await self.handle(raw)
        except Exception:
            pass  # Never retain/log a WebSocket exception with headers/payload.
        finally:
            heartbeat.cancel()
            await asyncio.gather(heartbeat, return_exceptions=True)
            await self.reset()


class TrackerServer:
    def __init__(self, *, source='mock', port=7900, ws_token, frame_token, backend_origin,
                 model=None, trajectory='stationary', clock=lambda: time.time_ns() // 1000000,
                 reacquire_ms=1000, lost_hold_ms=3000):
        if source not in ('mock', 'live') or type(port) is not int or not 0 <= port <= 65535: raise ValueError('invalid_options')
        if type(reacquire_ms) is not int or not 100 <= reacquire_ms <= 5000 or type(lost_hold_ms) is not int or not 0 <= lost_hold_ms <= 30000:
            raise ValueError('invalid_tracking_timing')
        if not isinstance(ws_token, str) or len(ws_token) < 32 or not isinstance(frame_token, str) or len(frame_token) < 32: raise ValueError('credentials_required')
        self.host, self.port, self.source = '127.0.0.1', port, source
        self.ws_token, self.frame_token = ws_token, frame_token
        self.backend_origin = validate_origin(backend_origin)
        self.clock, self.trajectory = clock, trajectory
        self.reacquire_ms, self.lost_hold_ms = reacquire_ms, lost_hold_ms
        self.detector_name, self.provider = 'mock', 'none'
        self.lane = None
        self.clients = set()
        self.server = None
        if source == 'live':
            from detector import OnnxDetector
            from PIL import Image
            from sources.live_source import InferenceLane
            detector = OnnxDetector(model)
            detector.detect(Image.new('RGB', (64, 64), (114, 114, 114)))
            self.lane = InferenceLane(detector)
            self.detector_name, self.provider = detector.name, detector.provider

    async def authenticate(self, connection, request):
        try:
            authorized = (request.path == '/' and request.headers.get('Origin') is None and
                          hmac.compare_digest(request.headers.get('Authorization', ''), 'Bearer ' + self.ws_token))
        except Exception: authorized = False
        if not authorized: return connection.respond(HTTPStatus.UNAUTHORIZED, 'Unauthorized\n')
        if self.clients: return connection.respond(HTTPStatus.CONFLICT, 'Tracker already connected\n')

    async def handler(self, ws):
        # Concurrent upgrades can both authenticate before either handler runs.
        # Claim ownership atomically here, before the first await/protocol read.
        if self.clients:
            await ws.close(code=1008, reason='tracker_already_connected')
            return
        session = Session(self, ws)
        self.clients.add(session)
        try: await session.run()
        finally: self.clients.discard(session)

    async def __aenter__(self):
        from websockets.asyncio.server import serve
        logger = logging.getLogger('fps-tracker-socket')
        logger.addHandler(logging.NullHandler()); logger.propagate = False
        # The app protocol rejects >64KiB before parsing; the transport also
        # caps framing buffers. Larger attacks close with1009 without parsing.
        self.server = await serve(self.handler, self.host, self.port, process_request=self.authenticate,
                                  max_size=MAX_MESSAGE_BYTES*2, max_queue=4, write_limit=65536,
                                  compression=None, ping_interval=None, close_timeout=1, logger=logger)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *_):
        self.server.close()
        await self.server.wait_closed()


async def run_cli(args, watchdogs):
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    from parent_watchdog import ParentWatchdog
    watchdog = ParentWatchdog(lambda: loop.call_soon_threadsafe(stop.set))
    watchdogs.append(watchdog)
    if not args.no_parent_watchdog: watchdog.start()
    def stop_requested():
        stop.set(); watchdog.request_stop()
    for sig in (signal.SIGTERM, signal.SIGINT): loop.add_signal_handler(sig, stop_requested)
    server = TrackerServer(source=args.source, port=args.port, model=args.model, trajectory=args.trajectory,
                           ws_token=os.environ.get('TRACKER_WS_TOKEN'), frame_token=os.environ.get('TRACKER_FRAME_TOKEN'),
                           backend_origin=os.environ.get('TRACKER_BACKEND_ORIGIN'),
                           reacquire_ms=args.reacquire_ms, lost_hold_ms=args.lost_hold_ms)
    async with server:
        if stop.is_set(): return
        print(json.dumps(dict(type='ready', protocol=1, port=server.port, pid=os.getpid()), separators=(',', ':')), flush=True)
        await stop.wait()


def main():
    parser = argparse.ArgumentParser(description='Private FPS person tracking helper')
    parser.add_argument('--source', choices=('mock', 'live'), default='mock')
    parser.add_argument('--port', type=int, default=7900)
    parser.add_argument('--model')
    parser.add_argument('--trajectory', choices=('stationary', 'sine', 'exit-frame'), default='stationary')
    parser.add_argument('--reacquire-ms', type=int, default=1000)
    parser.add_argument('--lost-hold-ms', type=int, default=3000)
    parser.add_argument('--no-parent-watchdog', action='store_true', help='Developer terminal only; never use in packaged launches')
    args = parser.parse_args()
    watchdogs = []
    try: asyncio.run(run_cli(args, watchdogs))
    except KeyboardInterrupt: pass
    except Exception:
        print('tracker_startup_failed', file=sys.stderr)
        return 1
    finally:
        # asyncio.run also joins executor threads after run_cli returns. Keep
        # parent-loss enforcement active until those native workers are gone.
        for watchdog in watchdogs: watchdog.close()
    return 0


if __name__ == '__main__': raise SystemExit(main())
