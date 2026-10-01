import crypto from 'crypto';
import { IncomingMessage } from 'http';
import { AppState } from '../app/state';
import { ActivityLog } from '../app/activityLog';
import { AppConfig } from '../config/configLoader';
import { InputArbiter, OwnerChange } from './inputArbiter';
import { NormalizedInput } from './normalizers';
import { standardFrameToInput } from './browserGamepad';
import {
  parseClientMessage, TokenBucket, WindowCounter,
  MAX_INVALID_MESSAGES, MAX_DROPS_PER_WINDOW, DROP_WINDOW_MS,
} from './remoteFrame';

/**
 * Server side of the iPad remote (/ws/remote-controller): one RemoteControlHub, one session per connected page.
 *
 * The hub owns the sockets and the protocol; who is actually driving is the InputArbiter's decision. Every
 * way a remote can go quiet ends in the same place, with the camera stopped at once rather than after the
 * machine's 250 ms stale-input window: the socket closing, the page going idle or hidden, a release, a STOP,
 * remote control being switched off, and 1000 ms of silence (the arbiter's dead-man, checked here every 100 ms).
 *
 * Protocol (JSON), client -> server: hello, claim, release, in, idle, stop, ping. Server -> client: welcome,
 * owner, denied, pong, state. See docs/ai/plans/2026-10-01-ipad-gamepad-remote.md section 2.6.
 */

/** The slice of a ws WebSocket the hub uses, so tests can drive it with a fake. */
export interface RemoteSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: 'message', listener: (data: Buffer | string) => void): unknown;
  on(event: 'close' | 'error' | 'pong', listener: (...args: any[]) => void): unknown;
}

const WS_OPEN = 1;
const PING_EVERY_MS = 1000;
const PONG_TIMEOUT_MS = 2500;
const TICK_MS = 100;
const STATE_PUSH_MS = 500; // 2 Hz while owner

interface Session {
  id: string;
  ws: RemoteSocket;
  name: string;
  hello: boolean;
  lastSeq: number;
  lastInput: NormalizedInput | null;
  bucket: TokenBucket;
  drops: WindowCounter;
  invalid: number;
  lastPongAt: number;
  pingSentAt: number;
  rttMs: number | null;
}

export interface RemoteHubDeps {
  state: AppState;
  config: Pick<AppConfig, 'speeds'> & Partial<AppConfig>;
  arbiter: InputArbiter;
  activityLog: ActivityLog | null;
  /** Stops every camera (and kills the lower third), like the controller's Back button. */
  emergencyStop: () => Promise<void> | void;
  now?: () => number;
}

export class RemoteControlHub {
  private sessions = new Map<string, Session>();
  private timers: NodeJS.Timeout[] = [];
  private now: () => number;
  private lastStatePush = 0;

  constructor(private deps: RemoteHubDeps) {
    this.now = deps.now ?? Date.now;
    deps.arbiter.onOwnerChange((e) => this.onOwnerChange(e));
    this.publish();
  }

  /** Start the dead-man and ping timers. Unref'd, so they never keep the process alive. */
  start(): void {
    if (this.timers.length) return;
    this.timers.push(setInterval(() => this.tick(), TICK_MS).unref());
    this.timers.push(setInterval(() => this.pingAll(), PING_EVERY_MS).unref());
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.deps.arbiter.revoke('disconnect');
    for (const s of this.sessions.values()) s.ws.close(1001, 'shutting down');
  }

  get enabled(): boolean { return this.deps.arbiter.enabled; }

  setEnabled(enabled: boolean): void {
    this.deps.arbiter.setEnabled(enabled);
    this.broadcastOwner(null);
    this.publish();
  }

  /** The desk takes the seat back (Take back button). */
  takeBack(): boolean {
    return this.deps.arbiter.revoke('taken-back');
  }

  /** STOP from the desk page or the HTTP endpoint: release any remote owner (the caller stops the cameras). */
  revokeForStop(): void {
    this.deps.arbiter.revoke('stop');
  }

  handleConnection(ws: RemoteSocket, _req?: IncomingMessage): void {
    const t = this.now();
    const s: Session = {
      id: crypto.randomBytes(6).toString('hex'),
      ws,
      name: '',
      hello: false,
      lastSeq: -1,
      lastInput: null,
      bucket: new TokenBucket(undefined, undefined, this.now),
      drops: new WindowCounter(DROP_WINDOW_MS, this.now),
      invalid: 0,
      lastPongAt: t,
      pingSentAt: 0,
      rttMs: null,
    };
    this.sessions.set(s.id, s);
    ws.on('message', (data) => this.onMessage(s, data));
    ws.on('pong', () => {
      s.lastPongAt = this.now();
      if (s.pingSentAt) s.rttMs = Math.round(s.lastPongAt - s.pingSentAt);
    });
    const gone = (): void => this.onGone(s);
    ws.on('close', gone);
    ws.on('error', gone);
    this.publish();
  }

  private onMessage(s: Session, data: Buffer | string): void {
    const parsed = parseClientMessage(data, s.lastSeq);
    if (!parsed.ok) {
      // A stale or reordered frame is normal on a bad network; everything else counts against the session.
      if (parsed.reason !== 'stale or bad sequence' && ++s.invalid > MAX_INVALID_MESSAGES) s.ws.close(1008, 'too many invalid messages');
      return;
    }
    const msg = parsed.msg;
    switch (msg.t) {
      case 'hello':
        s.name = msg.name;
        s.hello = true;
        this.send(s, { t: 'welcome', session: s.id, enabled: this.enabled, needsPin: false, owner: this.deps.arbiter.owner });
        break;
      case 'ping':
        this.send(s, { t: 'pong', ts: msg.ts });
        break;
      case 'in': {
        if (!s.bucket.take()) {
          if (s.drops.add() > MAX_DROPS_PER_WINDOW) s.ws.close(1008, 'flooding');
          return;
        }
        s.lastSeq = msg.s;
        const input = standardFrameToInput(msg);
        s.lastInput = input;
        // Non-owner frames are validated and remembered (as the seed for a claim) but never applied.
        this.deps.arbiter.fromRemote(s.id, input, this.labelOf(s));
        break;
      }
      case 'claim': {
        if (!s.hello) return;
        const r = this.deps.arbiter.claim(s.id, this.labelOf(s), s.lastInput);
        if (!r.ok) this.send(s, { t: 'denied', reason: r.reason });
        break;
      }
      case 'release':
        this.deps.arbiter.release(s.id, 'release');
        break;
      case 'idle':
        // Hidden or blurred page: stop at once and give the seat back; it must claim again.
        s.lastInput = null;
        this.deps.arbiter.release(s.id, 'idle');
        break;
      case 'stop':
        if (!s.hello) return;
        this.stopEverything(this.labelOf(s));
        break;
    }
  }

  /** Emergency stop from a remote: release the seat first (stops motion), then stop every camera. */
  stopEverything(who: string): void {
    this.deps.arbiter.revoke('stop');
    this.deps.activityLog?.setContext(who, 'STOP', 'Emergency Stop');
    this.deps.activityLog?.addSystemEntry('Emergency Stop', `All cameras stopped (${who})`);
    void Promise.resolve(this.deps.emergencyStop()).catch(() => undefined);
  }

  private onGone(s: Session): void {
    if (!this.sessions.delete(s.id)) return;
    this.deps.arbiter.release(s.id, 'disconnect');
    this.publish();
  }

  private labelOf(s: Session): string {
    return `iPad: ${s.name || 'unnamed'}`;
  }

  private onOwnerChange(e: OwnerChange): void {
    this.broadcastOwner(e);
    const log = this.deps.activityLog;
    if (log) {
      const who = e.owner === 'remote' ? (e.ownerName ?? 'iPad') : 'Desk';
      log.setContext(who, 'Remote control', 'Control');
      log.addSystemEntry('Control', e.owner === 'remote' ? `${who} took control` : `Control: Desk (${e.reason})`);
    }
    this.publish();
  }

  private broadcastOwner(e: OwnerChange | null): void {
    const a = this.deps.arbiter;
    for (const s of this.sessions.values()) {
      this.send(s, { t: 'owner', owner: a.owner, you: a.ownerId === s.id, ownerName: a.ownerName, reason: e?.reason ?? null, enabled: this.enabled });
    }
  }

  private send(s: Session, obj: unknown): void {
    if (s.ws.readyState !== WS_OPEN) return;
    try { s.ws.send(JSON.stringify(obj)); } catch { /* the close handler cleans up */ }
  }

  private tick(): void {
    this.deps.arbiter.tick();
    this.publish();
    const t = this.now();
    if (this.deps.arbiter.owner === 'remote' && t - this.lastStatePush >= STATE_PUSH_MS) {
      this.lastStatePush = t;
      const st = this.deps.state;
      const preset = this.deps.config.speeds.presets[st.speedPreset];
      const owner = this.sessions.get(this.deps.arbiter.ownerId ?? '');
      if (owner) {
        this.send(owner, { t: 'state', controlled: st.controlledCamera, program: st.programCamera, preview: st.previewCamera, speedName: preset?.name ?? String(st.speedPreset), precision: st.precisionMode });
      }
    }
  }

  private pingAll(): void {
    const t = this.now();
    for (const s of [...this.sessions.values()]) {
      if (t - s.lastPongAt > PONG_TIMEOUT_MS) {
        // Half-open connection (Wi-Fi gone, iPad asleep): drop it, which releases the seat.
        s.ws.terminate();
        this.onGone(s);
        continue;
      }
      s.pingSentAt = t;
      try { s.ws.ping(); } catch { /* handled by the close event */ }
    }
  }

  /** Mirror the hub's view into state.remoteControl for /api/status. */
  private publish(): void {
    const a = this.deps.arbiter;
    const owner = a.ownerId ? this.sessions.get(a.ownerId) : undefined;
    this.deps.state.remoteControl = {
      enabled: a.enabled,
      owner: a.owner,
      ownerName: a.ownerName,
      sessions: this.sessions.size,
      lastFrameAgoMs: a.lastRemoteFrameAgoMs,
      rttMs: owner?.rttMs ?? null,
    };
  }
}
