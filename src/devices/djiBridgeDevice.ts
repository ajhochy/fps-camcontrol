import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { MotionDevice, DeviceCapabilities, DevicePosition } from './motionDevice';
import { ActivityLog } from '../app/activityLog';
import { logger } from '../index';

const PROTOCOL_VERSION = 1;
const HEARTBEAT_INTERVAL_MS = 1000;
const HEARTBEAT_TIMEOUT_MS = 3000;
const DEFAULT_BACKOFF = [1000, 2000, 5000, 15000];

// How "a gimbal is attached" is decided.
//
// The bridge deliberately stays reachable with no gimbal present, so `hello` and
// `ping` prove nothing — that conflation is issue #16. Measured against the real
// Pi, the available signals are:
//
//  - `status` frames. The Pi builds each one from a live pose poll, so a detached
//    gimbal produces NO frames rather than `gimbalConnected: false`. Good
//    positive evidence, useless as negative evidence on its own.
//  - Command acks. A gimbal-touching command answers in ~0ms with `sdk_error`
//    when the BLE link is down, and OK when it is up. Deterministic BOTH ways.
//
// So: positive evidence from telemetry and successful commands; negative evidence
// only from an actual failure. Silence never condemns a gimbal by itself — it
// merely triggers an active check — because telemetry gaps over 20s were observed
// on a perfectly healthy gimbal when several clients share the bridge and contend
// for the BLE link.

/** Telemetry quiet for this long triggers an active check (not a verdict). */
const GIMBAL_QUIET_MS = 10000;
/** How long the active check waits before giving up as INCONCLUSIVE. */
const GIMBAL_CHECK_TIMEOUT_MS = 4000;
/** Floor between active checks, so we don't add to BLE contention. */
const GIMBAL_CHECK_INTERVAL_MS = 10000;

/**
 * Methods whose successful ack proves a gimbal is on the far end.
 *
 * `ping` is excluded because it never touches the gimbal — that is the whole
 * bug. `stop` is excluded too, and less obviously: the Pi driver returns early
 * from `stop()` when it has no link, so a detached gimbal acks it happily.
 */
const GIMBAL_PROOF_METHODS = new Set(['moveVelocity', 'getPosition', 'moveToPosition', 'recenter']);

export interface BridgeConfig {
  host: string;
  port: number;
  gimbalModel?: string;
  safetyTimeoutMs: number;
  reconnectBackoffMs: number[];
  rollEnabled: boolean;
  /**
   * Override GIMBAL_QUIET_MS. Config never sets this; it exists so tests can
   * exercise the quiet-then-check path without waiting out the real window.
   */
  gimbalStatusTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

/** Distinguishes "the bridge never answered" from "the bridge answered no". */
class RequestTimeoutError extends Error {}

interface Frame {
  v: number;
  id?: number;
  type: 'cmd' | 'ack' | 'evt';
  method?: string;
  params?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export class DjiBridgeDevice extends EventEmitter implements MotionDevice {
  readonly protocol = 'dji-bridge';
  capabilities: DeviceCapabilities = {
    pan: true,
    tilt: true,
    roll: false,
    zoom: false,
    position: false,
    moveTo: false,
  };

  private ws: WebSocket | null = null;
  private bridge: BridgeConfig;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private backoffIndex = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastPongAt = 0;
  private closing = false;
  private activityLog: ActivityLog | null = null;
  private lastPan = 0;
  private lastTilt = 0;
  private lastPos: DevicePosition | null = null;
  private _connected = false;
  private _gimbalAttached = false;
  /** When we last had positive evidence of a gimbal, or 0 if never. */
  private lastGimbalProofAt = 0;
  /** When the `hello` handshake last succeeded; starts the first quiet window. */
  private connectedAt = 0;
  private gimbalCheckInFlight = false;
  private lastGimbalCheckAt = 0;
  /** In-flight command ids → method, so an ack can be attributed to a method. */
  private inFlightMethods = new Map<number, string>();

  constructor(bridge: BridgeConfig, public readonly id: string, public label: string) {
    super();
    this.bridge = {
      ...bridge,
      reconnectBackoffMs: bridge.reconnectBackoffMs?.length ? bridge.reconnectBackoffMs : DEFAULT_BACKOFF,
    };
  }

  /** The WebSocket to the Pi bridge is up. Says nothing about the gimbal. */
  get connected(): boolean {
    return this._connected;
  }

  /**
   * A gimbal is attached to the bridge and reporting telemetry. Distinct from
   * `connected`: since the bridge stays reachable with no gimbal present, a
   * reachable bridge and a movable camera are two different things, and they
   * need different remedies (fix the network/Pi vs. switch the gimbal on).
   */
  get gimbalAttached(): boolean {
    return this._gimbalAttached;
  }

  setActivityLog(log: ActivityLog, label: string): void {
    this.activityLog = log;
    this.label = label;
  }

  connect(): void {
    this.closing = false;
    this.openSocket();
  }

  close(): void {
    this.closing = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.markDisconnected();
    for (const [, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error('device closed'));
    }
    this.pending.clear();
  }

  setPanTilt(panSpeed: number, tiltSpeed: number): void {
    this.lastPan = panSpeed;
    this.lastTilt = tiltSpeed;
    this.sendCommand('moveVelocity', { pan: panSpeed, tilt: tiltSpeed });
  }

  setZoom(_zoomSpeed: number): void {
    // Zoom only honored if capability advertises it; otherwise ignored.
    if (this.capabilities.zoom) {
      this.sendCommand('setZoom', { zoom: _zoomSpeed });
    }
  }

  stop(): void {
    this.lastPan = 0;
    this.lastTilt = 0;
    this.sendCommand('stop', {});
  }

  async getPosition(): Promise<DevicePosition> {
    if (!this.capabilities.position) {
      throw new Error(`${this.id}: bridge does not advertise position capability`);
    }
    const res = await this.request('getPosition', {}, 1000);
    const r = res as { yaw: number; pitch: number; roll: number };
    const pos: DevicePosition = { kind: 'gimbal', yaw: r.yaw, pitch: r.pitch, roll: r.roll };
    this.lastPos = pos;
    return pos;
  }

  async moveTo(pos: DevicePosition): Promise<void> {
    if (!this.capabilities.moveTo) {
      throw new Error(`${this.id}: bridge does not advertise moveTo capability`);
    }
    if (pos.kind !== 'gimbal') {
      throw new Error(`${this.id}: DJI bridge requires gimbal position, got ${pos.kind}`);
    }
    await this.request('moveToPosition', { yaw: pos.yaw, pitch: pos.pitch, roll: pos.roll }, 5000);
  }

  async recenter(): Promise<void> {
    await this.request('recenter', {}, 5000);
  }

  async probe(timeoutMs = 1000): Promise<boolean> {
    if (!this._connected) return false;
    return Promise.race<boolean>([
      this.request('ping', {}, timeoutMs).then(() => true).catch(() => false),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }

  private openSocket(): void {
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
    }
    const url = `ws://${this.bridge.host}:${this.bridge.port}`;
    logger.info({ id: this.id, url }, 'DJI bridge connecting');
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.backoffIndex = 0;
      this.lastPongAt = Date.now();
      // Capability handshake first, then mark connected.
      this.request('hello', { clientId: this.id, protocolVersion: PROTOCOL_VERSION }, 3000)
        .then(res => {
          const r = res as {
            capabilities?: string[]; gimbalModel?: string; bridgeVersion?: string;
            gimbalConnected?: boolean;
          };
          this.applyCapabilities(r.capabilities ?? []);
          this._connected = true;
          this.connectedAt = Date.now();
          this.lastGimbalProofAt = 0;
          this.lastGimbalCheckAt = 0;
          logger.info({ id: this.id, capabilities: r.capabilities, gimbalModel: r.gimbalModel }, 'DJI bridge reachable');
          // `hello` succeeds whether or not a gimbal is attached, so start
          // optimistic and let telemetry or the active check settle it. Honour an
          // explicit flag if this bridge version supplies one.
          this.setGimbalAttached(
            typeof r.gimbalConnected === 'boolean' ? r.gimbalConnected : true,
            'hello'
          );
          this.emit('connected');
          this.startHeartbeat();
        })
        .catch(err => {
          logger.warn({ id: this.id, err: String(err) }, 'DJI bridge hello failed, reconnecting');
          try { ws.close(); } catch { /* ignore */ }
        });
    });

    ws.on('message', (data) => this.handleFrame(data.toString()));

    ws.on('close', () => {
      this.markDisconnected();
      if (!this.closing) this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      logger.warn({ id: this.id, err: String(err) }, 'DJI bridge socket error');
    });
  }

  private markDisconnected(): void {
    // The bridge being unreachable subsumes the gimbal question: reset the
    // gimbal state first so a consumer reacting to `disconnected` cannot read a
    // stale "attached" off a device it has just been told is gone.
    this.lastGimbalProofAt = 0;
    this.connectedAt = 0;
    this.inFlightMethods.clear();
    this.setGimbalAttached(false, 'bridge unreachable');
    if (this._connected) {
      this._connected = false;
      this.emit('disconnected');
    }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  /**
   * Single writer for the gimbal-attached flag, so every transition is logged
   * once and consumers get exactly one event per real change.
   */
  private setGimbalAttached(attached: boolean, reason: string): void {
    if (this._gimbalAttached === attached) return;
    this._gimbalAttached = attached;
    if (attached) {
      logger.info({ id: this.id, reason }, 'DJI gimbal attached');
    } else {
      logger.warn({ id: this.id, reason }, 'DJI gimbal not attached — camera cannot move');
    }
    this.emit(attached ? 'gimbalAttached' : 'gimbalDetached');
  }

  private applyCapabilities(caps: string[]): void {
    const set = new Set(caps);
    this.capabilities = {
      pan: set.has('velocity') || set.has('pan'),
      tilt: set.has('velocity') || set.has('tilt'),
      roll: set.has('roll') && this.bridge.rollEnabled,
      zoom: set.has('zoom'),
      position: set.has('position'),
      moveTo: set.has('moveTo'),
    };
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.sendFrame({ v: PROTOCOL_VERSION, type: 'cmd', id: this.nextId++, method: 'ping', params: {} });
      if (Date.now() - this.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        logger.warn({ id: this.id }, 'DJI bridge heartbeat timeout, reconnecting');
        try { this.ws?.close(); } catch { /* ignore */ }
        return;
      }
      // Pings keep acking with no gimbal on the far end, so the heartbeat cannot
      // notice a detached gimbal by itself. When telemetry has gone quiet, ask
      // the gimbal something directly instead of guessing from the silence.
      const quietSince = Math.max(this.lastGimbalProofAt, this.connectedAt);
      const quietWindow = this.bridge.gimbalStatusTimeoutMs ?? GIMBAL_QUIET_MS;
      if (quietSince > 0 && Date.now() - quietSince > quietWindow) {
        this.checkGimbalAttached();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Ask the gimbal directly whether it is there.
   *
   * Only a real failure answer counts as "detached". A check that simply does
   * not come back is INCONCLUSIVE and leaves the previous verdict alone: on a
   * shared bridge a healthy gimbal's pose poll was measured taking 13s, so
   * treating slowness as absence would condemn working cameras. A detached
   * gimbal, by contrast, is rejected by the bridge in about 0ms.
   */
  private checkGimbalAttached(): void {
    if (this.gimbalCheckInFlight || !this._connected) return;
    if (Date.now() - this.lastGimbalCheckAt < GIMBAL_CHECK_INTERVAL_MS) return;
    // Nothing safe to ask without a position capability: every other method
    // moves the camera. Keep the last verdict rather than invent one.
    if (!this.capabilities.position) return;

    this.gimbalCheckInFlight = true;
    this.lastGimbalCheckAt = Date.now();
    this.request('getPosition', {}, GIMBAL_CHECK_TIMEOUT_MS)
      .catch((err: Error) => {
        if (err instanceof RequestTimeoutError) {
          logger.debug({ id: this.id }, 'gimbal check inconclusive (no reply) — keeping previous state');
        }
        // A non-timeout rejection is the bridge saying no; handleFrame has
        // already recorded that from the ack itself.
      })
      .finally(() => { this.gimbalCheckInFlight = false; });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closing) return;
    const delay = this.bridge.reconnectBackoffMs[Math.min(this.backoffIndex, this.bridge.reconnectBackoffMs.length - 1)];
    this.backoffIndex++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private handleFrame(raw: string): void {
    let frame: Frame;
    try { frame = JSON.parse(raw); } catch {
      logger.warn({ id: this.id, raw }, 'DJI bridge bad frame');
      return;
    }
    if (frame.type === 'ack' && typeof frame.id === 'number') {
      // Read the gimbal verdict out of the ack BEFORE the pending lookup can
      // bail out. Fire-and-forget commands (moveVelocity, stop) register no
      // pending request, and their failures are exactly the "commands to it were
      // failing" symptom from issue #16 — the most direct evidence there is, and
      // it arrives the instant the operator tries to move a dead gimbal.
      const method = this.inFlightMethods.get(frame.id);
      this.inFlightMethods.delete(frame.id);
      if (frame.error) {
        // `sdk_error` is the bridge's bucket for "the call to the gimbal failed",
        // which is what a missing BLE link produces. `not_supported` is a
        // protocol mismatch and says nothing about the hardware.
        if (frame.error.code === 'sdk_error') {
          this.setGimbalAttached(false, `${method ?? 'command'} failed: ${frame.error.message}`);
        }
      } else if (method !== undefined && GIMBAL_PROOF_METHODS.has(method)) {
        this.lastGimbalProofAt = Date.now();
        this.setGimbalAttached(true, `${method} acked`);
      }

      const req = this.pending.get(frame.id);
      if (!req) return;
      this.pending.delete(frame.id);
      clearTimeout(req.timer);
      if (frame.error) req.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
      else req.resolve(frame.params ?? {});
      return;
    }
    if (frame.type === 'evt') {
      if (frame.method === 'pong') this.lastPongAt = Date.now();
      if (frame.method === 'status') {
        const p = frame.params as {
          position?: { yaw: number; pitch: number; roll: number };
          gimbalConnected?: boolean;
        } | undefined;
        if (p?.position) {
          this.lastPos = { kind: 'gimbal', yaw: p.position.yaw, pitch: p.position.pitch, roll: p.position.roll };
        }
        // Prefer the bridge's own verdict; otherwise pose telemetry can only
        // have come from a gimbal that is powered and linked, so infer from it.
        if (typeof p?.gimbalConnected === 'boolean') {
          if (p.gimbalConnected) this.lastGimbalProofAt = Date.now();
          this.setGimbalAttached(p.gimbalConnected, 'status.gimbalConnected');
        } else if (p?.position) {
          this.lastGimbalProofAt = Date.now();
          this.setGimbalAttached(true, 'status.position');
        }
        this.emit('status', frame.params);
      }
      if (frame.method === 'safetyStop') {
        logger.warn({ id: this.id, reason: frame.params }, 'DJI bridge safety stop');
        this.emit('safetyStop', frame.params);
      }
    }
  }

  private sendFrame(frame: Frame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const json = JSON.stringify(frame);
    this.ws.send(json);
    if (this.activityLog && frame.type === 'cmd' && frame.method !== 'ping') {
      this.activityLog.addEntry({
        protocol: 'DJI-BRIDGE',
        message: `${frame.method} ${JSON.stringify(frame.params ?? {})}`,
        targetName: this.label || this.id,
        targetIp: `${this.bridge.host}:${this.bridge.port}`,
      });
    }
  }

  /**
   * Remember which method an id belongs to, so its ack can be read as evidence
   * about the gimbal. `ping` is skipped deliberately: it is answered by the
   * bridge without touching the gimbal, so it must never count either way.
   */
  private trackMethod(id: number, method: string): void {
    if (method === 'ping' || method === 'hello') return;
    // Every cmd gets an ack and the entry is deleted then; this bound only
    // guards against a pathological backlog leaking memory.
    if (this.inFlightMethods.size > 256) this.inFlightMethods.clear();
    this.inFlightMethods.set(id, method);
  }

  private sendCommand(method: string, params: Record<string, unknown>): void {
    const id = this.nextId++;
    this.trackMethod(id, method);
    this.sendFrame({ v: PROTOCOL_VERSION, type: 'cmd', id, method, params });
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`${this.id}: bridge not connected`));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.inFlightMethods.delete(id);
        reject(new RequestTimeoutError(`${this.id}: ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.trackMethod(id, method);
      this.sendFrame({ v: PROTOCOL_VERSION, type: 'cmd', id, method, params });
    });
  }
}
