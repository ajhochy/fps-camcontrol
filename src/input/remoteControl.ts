import crypto from 'crypto';
import { IncomingMessage } from 'http';
import { AppState } from '../app/state';
import { ActivityLog } from '../app/activityLog';
import { AppConfig } from '../config/configLoader';
import { InputArbiter, OwnerChange } from './inputArbiter';
import { NormalizedInput } from './normalizers';
import { standardFrameToInput } from './browserGamepad';
import {
  parseClientMessage, TokenBucket, WindowCounter, cleanLabel,
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
 * Protocol (JSON), client -> server: hello, claim, release, in, idle, stop, select, preview, transition, ping. Server -> client: welcome,
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
const PIN_MAX_BAD = 5;
const PIN_LOCKOUT_MS = 60000;
/** A second TRANSITION inside this window is ignored (a double tap must not take, then take back). */
export const TRANSITION_MIN_GAP_MS = 1500;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** The slice of an http request the hub looks at (so tests can pass a plain object). */
export interface RemoteRequest {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}
const header = (req: RemoteRequest | undefined, name: string): string => {
  const v = req?.headers?.[name];
  return (Array.isArray(v) ? v[0] : v) ?? '';
};

/**
 * Cross-site WebSocket hijacking guard: a browser always sends Origin on a WebSocket, and a page on some other
 * site (any page the operator happens to open on the LAN or tailnet) must not be able to drive the cameras.
 * Origin's host has to be the host the socket was opened to. No Origin = not a browser, which can already
 * send whatever it likes, so that is allowed.
 */
export function originAllowed(req: RemoteRequest | undefined): boolean {
  const origin = header(req, 'origin');
  if (!origin) return true;
  try { return new URL(origin).host.toLowerCase() === header(req, 'host').toLowerCase(); } catch { return false; }
}

const sha = (v: string): Buffer => crypto.createHash('sha256').update(v).digest();
/** Constant-time PIN comparison (hashed first so the lengths match). */
export function pinMatches(given: string | null, expected: string): boolean {
  return given !== null && crypto.timingSafeEqual(sha(given), sha(expected));
}

interface Session {
  id: string;
  ws: RemoteSocket;
  name: string;
  /** Who asked, for the PIN lockout: the Tailscale login when behind `tailscale serve`, else the IP. */
  peer: string;
  /** Tailscale login (label only, never auth), when the socket came through `tailscale serve` on this Mac. */
  login: string;
  hello: boolean;
  authed: boolean;
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
  /** Select the controlled camera by rig id (like the desk's face buttons); false when no such camera. */
  selectCamera?: (id: string, who: string, movePreview: boolean) => boolean;
  /** Set the ATEM preview to a camera by rig id (the bottom-row tap); a refusal reason, or 'ok'. */
  setPreview?: (id: string, who: string) => 'ok' | 'no-camera' | 'no-input' | 'atem-offline';
  /** The TRANSITION button: auto-transition what is in preview to program; a refusal reason, or 'ok'. */
  transition?: (who: string) => 'ok' | 'nothing-to-take' | 'no-input' | 'atem-offline';
  /** The LOWER THIRD button: toggle the DSK (the desk's D-pad left/right); a refusal reason, or 'ok'. */
  lowerThirds?: (who: string) => 'ok' | 'atem-offline';
  /** 4-8 digit PIN a page must give before it may claim control; absent = none. */
  pin?: string | null;
  now?: () => number;
}

export class RemoteControlHub {
  private sessions = new Map<string, Session>();
  private timers: NodeJS.Timeout[] = [];
  private now: () => number;
  private lastStatePush = 0;
  private badPins = new Map<string, WindowCounter>();
  private lastTransitionAt = -Infinity;

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

  handleConnection(ws: RemoteSocket, req?: RemoteRequest | IncomingMessage): void {
    const request = req as RemoteRequest | undefined;
    if (!originAllowed(request)) { ws.close(1008, 'origin not allowed'); return; }
    const t = this.now();
    const address = request?.socket?.remoteAddress ?? '';
    // `tailscale serve` terminates TLS on this Mac and sets these headers (stripping any a client sent); they
    // are only believed when the connection really is from this Mac.
    const login = LOOPBACK.has(address) ? cleanLabel(header(request, 'tailscale-user-login'), 60) : '';
    const s: Session = {
      id: crypto.randomBytes(6).toString('hex'),
      ws,
      name: '',
      peer: login || address || 'unknown',
      login,
      hello: false,
      authed: !this.deps.pin,
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
        if (this.deps.pin && !s.authed) this.checkPin(s, msg.pin);
        this.send(s, { t: 'welcome', session: s.id, enabled: this.enabled, needsPin: !s.authed, owner: this.deps.arbiter.owner });
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
        if (!s.authed) { this.send(s, { t: 'denied', reason: 'pin' }); return; }
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
      case 'select': {
        const refusal = this.ownerRefusal(s);
        if (refusal) { if (refusal !== 'silent') this.send(s, { t: 'denied', reason: refusal }); break; }
        if (!this.deps.selectCamera?.(msg.camera, this.labelOf(s), msg.movePreview)) this.send(s, { t: 'denied', reason: 'no-camera' });
        break;
      }
      case 'preview': {
        const refusal = this.ownerRefusal(s);
        if (refusal) { if (refusal !== 'silent') this.send(s, { t: 'denied', reason: refusal }); break; }
        const r = this.deps.setPreview ? this.deps.setPreview(msg.camera, this.labelOf(s)) : 'no-camera';
        if (r !== 'ok') this.refuse(s, 'Preview', r);
        break;
      }
      case 'transition': {
        const refusal = this.ownerRefusal(s);
        if (refusal) { if (refusal !== 'silent') this.send(s, { t: 'denied', reason: refusal }); break; }
        const t = this.now();
        if (t - this.lastTransitionAt < TRANSITION_MIN_GAP_MS) { this.send(s, { t: 'denied', reason: 'too-soon' }); break; }
        const r = this.deps.transition ? this.deps.transition(this.labelOf(s)) : 'atem-offline';
        if (r === 'ok') this.lastTransitionAt = t;
        else this.refuse(s, 'Transition', r);
        break;
      }
      case 'lowerThirds': {
        const refusal = this.ownerRefusal(s);
        if (refusal) { if (refusal !== 'silent') this.send(s, { t: 'denied', reason: refusal }); break; }
        const r = this.deps.lowerThirds ? this.deps.lowerThirds(this.labelOf(s)) : 'atem-offline';
        if (r !== 'ok') this.refuse(s, 'Lower third', r);
        break;
      }
      case 'stop':
        if (!s.hello) return;
        this.stopEverything(this.labelOf(s));
        break;
    }
  }

  /** Why this session may not drive (select/preview/transition are owner-only), or null; 'silent' = not hello'd yet. */
  private ownerRefusal(s: Session): string | null {
    if (!s.hello) return 'silent';
    if (!s.authed) return 'pin';
    if (!this.enabled) return 'disabled';
    if (this.deps.arbiter.owner !== 'remote' || this.deps.arbiter.ownerId !== s.id) return 'not-owner';
    return null;
  }

  /** Tell the page why a preview/transition was refused, and leave a line in the activity log. */
  private refuse(s: Session, what: string, reason: string): void {
    this.deps.activityLog?.setContext(this.labelOf(s), what, 'Refused');
    this.deps.activityLog?.addSystemEntry(`${what} refused`, `${what} refused: ${reason}`);
    this.send(s, { t: 'denied', reason });
  }

  /** Check a PIN from a hello. Five wrong ones from one peer lock it out for a minute (right ones included). */
  private checkPin(s: Session, given: string | null): void {
    if (given === null) return; // no PIN offered yet: the welcome says one is needed
    let bad = this.badPins.get(s.peer);
    if (!bad) { bad = new WindowCounter(PIN_LOCKOUT_MS, this.now); this.badPins.set(s.peer, bad); }
    if (bad.count() >= PIN_MAX_BAD) { this.send(s, { t: 'denied', reason: 'pin', locked: true }); return; }
    if (pinMatches(given, this.deps.pin as string)) { s.authed = true; bad.clear(); return; }
    bad.add();
    this.send(s, { t: 'denied', reason: 'pin', locked: bad.count() >= PIN_MAX_BAD });
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
    return `iPad: ${s.name || 'unnamed'}${s.login ? ` (${s.login})` : ''}`;
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

  /** Dead-man check and state push (the 100 ms timer; public so tests can drive it with a fake clock). */
  tick(): void {
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

  /** Ping every session and drop those that stopped answering (the 1 s timer; public for tests). */
  pingAll(): void {
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
