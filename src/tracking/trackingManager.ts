import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { MotionDevice } from '../devices/motionDevice';
import type { TrackingConfig } from './configSchema';
import { parseFromTracker, TrackMessage } from './protocol';
import { MotionLedger } from './motionLedger';
import { TrackingController } from './trackingController';
import type { ResolvedTrackingSource, TrackingSourceStatus, TrackingState } from './types';
export type { TrackingSourceStatus } from './types';

export class TrackingError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) { super(message); }
}
export interface TrackingPeer extends EventEmitter {
  connected: boolean;
  start(): void; stop(): void;
  select(sourceId: string, sessionId: string, x: number, y: number): boolean;
  cancel(sourceId: string, sessionId: string): boolean;
}
interface Session {
  status: TrackingSourceStatus; controller: TrackingController; device?: MotionDevice;
  halted: boolean; seq: number; lostAt: number | null;
}
export interface TrackingManagerOptions {
  config: TrackingConfig; sources: ResolvedTrackingSource[]; devices: Map<string, MotionDevice>; client: TrackingPeer;
  ledger?: MotionLedger; now?: () => number; setInterval?: (fn: () => void, ms: number) => unknown; clearInterval?: (timer: unknown) => void;
  onStatus?: (status: Record<string, TrackingSourceStatus>) => void;
}
export class TrackingManager extends EventEmitter {
  private config: TrackingConfig;
  private sources: ResolvedTrackingSource[];
  private devices: Map<string, MotionDevice>;
  private readonly client: TrackingPeer;
  private readonly ledger: MotionLedger;
  private readonly now: () => number;
  private readonly interval: NonNullable<TrackingManagerOptions['setInterval']>;
  private readonly clear: NonNullable<TrackingManagerOptions['clearInterval']>;
  private readonly onStatus?: TrackingManagerOptions['onStatus'];
  private sessions = new Map<string, Session>();
  private lastSelect = new Map<string, number>();
  private timer: unknown;
  private started = false;
  private calibration?: { sourceId: string; cameraId: string; stop: () => void };
  constructor(options: TrackingManagerOptions) {
    super(); this.config = options.config; this.sources = options.sources; this.devices = options.devices; this.client = options.client;
    this.ledger = options.ledger ?? new MotionLedger(); this.now = options.now ?? Date.now;
    this.interval = options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.clear = options.clearInterval ?? (timer => clearInterval(timer as NodeJS.Timeout)); this.onStatus = options.onStatus;
    this.populate();
  }
  private populate(): void {
    for (const source of this.sources) {
      const device = source.cameraId ? this.devices.get(source.cameraId) : undefined;
      this.sessions.set(source.sourceId, { status: { ...source, sessionId: null, state: !this.config.enabled ? 'disabled' : device ? 'idle' : 'unavailable', reason: null, observation: null, pan: 0, tilt: 0 },
        controller: new TrackingController({ ...this.config, ...source }), device, halted: true, seq: -1, lostAt: null });
    }
  }
  start(): void {
    if (this.started || !this.config.enabled) return;
    this.started = true;
    this.client.on('track', this.receive); this.client.on('disconnected', this.disconnected);
    this.client.start(); this.timer = this.interval(() => this.tick(), 50);
  }
  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer !== undefined) this.clear(this.timer); this.timer = undefined;
    this.invalidateAll('shutdown');
    this.client.removeListener('track', this.receive); this.client.removeListener('disconnected', this.disconnected); this.client.stop();
  }
  private disconnected = (): void => { this.invalidateAll('sidecar_disconnected'); };
  private transition(session: Session, state: TrackingState, reason: string | null = null): void {
    if (session.status.state === state && session.status.reason === reason) return;
    session.status.state = state; session.status.reason = reason;
    this.emit('state', { ...session.status }); this.onStatus?.(this.getStatus());
  }
  private ready(session: Session): boolean {
    return !!session.device && session.device.protocol === 'dji-bridge' && session.device.connected && session.device.gimbalAttached !== false;
  }
  private get(sourceId: string): Session {
    const session = this.sessions.get(sourceId);
    if (!session) throw new TrackingError(404, 'unknown_source', 'Tracking source not found'); return session;
  }
  private halt(session: Session, force = false, stopDevices = true): void {
    if (session.device && (force || !session.halted) && stopDevices) this.ledger.stop(session.device);
    session.halted = true; session.status.pan = session.status.tilt = 0;
  }
  select(sourceId: string, x: number, y: number): void {
    const session = this.get(sourceId);
    if (this.calibration) throw new TrackingError(409, 'calibration_busy', 'Calibration is in progress');
    if (![x, y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new TrackingError(400, 'invalid_point', 'Select a point inside the preview');
    if (!this.config.enabled || !this.started) throw new TrackingError(409, 'tracking_disabled', 'Tracking is disabled');
    if (!session.device) { this.transition(session, 'unavailable', 'source_unavailable'); throw new TrackingError(409, 'source_unavailable', 'Tracking source is not assigned to an active camera'); }
    if (!this.ready(session)) throw new TrackingError(409, 'device_unavailable', 'Tracking device is unavailable');
    if (!this.client.connected) throw new TrackingError(409, 'sidecar_offline', 'Tracking sidecar is offline');
    const now = this.now(), previous = this.lastSelect.get(sourceId);
    if (previous !== undefined && now - previous < 250) throw new TrackingError(429, 'select_rate_limited', 'Wait before selecting another target');
    this.lastSelect.set(sourceId, now);
    if (session.status.sessionId) this.invalidate(session, 'reselect');
    session.status.sessionId = randomUUID(); session.status.observation = null; session.seq = -1; session.lostAt = null; session.halted = false; session.controller.reset();
    if (!this.client.select(sourceId, session.status.sessionId, x, y)) { this.invalidate(session, 'sidecar_disconnected'); throw new TrackingError(409, 'sidecar_offline', 'Tracking sidecar is offline'); }
    this.transition(session, 'locking');
  }
  cancel(sourceId: string): void {
    const session = this.get(sourceId);
    if (this.calibration?.sourceId === sourceId) this.stopCalibration();
    this.invalidate(session, 'cancelled', { forceStop: true });
  }
  resume(sourceId: string): void {
    const session = this.get(sourceId), obs = session.status.observation;
    if (session.status.state !== 'operator_override' || !session.status.sessionId || !this.client.connected || !this.ready(session) || !obs || obs.state !== 'tracking' || this.now() - obs.frameTs >= 500) {
      throw new TrackingError(409, 'resume_unavailable', 'A fresh healthy target is required to resume');
    }
    session.controller.reset(); this.transition(session, 'tracking');
  }
  operatorOverride(cameraId: string): void {
    if (this.calibration?.cameraId === cameraId) this.stopCalibration();
    for (const session of this.sessions.values()) {
      if (session.status.cameraId !== cameraId || !session.status.sessionId || session.status.state === 'operator_override') continue;
      this.halt(session, true); session.controller.reset(); this.transition(session, 'operator_override', 'manual_input');
    }
  }
  private invalidate(session: Session, reason: string, { stopDevices = true, forceStop = false } = {}): void {
    const sessionId = session.status.sessionId;
    // Clear before invoking a device or transport: a synchronous device event
    // must not re-enter tick with a still-armed target during emergency stop.
    session.status.sessionId = null; session.status.observation = null; session.seq = -1; session.lostAt = null; session.controller.reset();
    this.halt(session, forceStop || !!sessionId, stopDevices);
    if (sessionId) this.client.cancel(session.status.sourceId, sessionId);
    this.transition(session, !this.config.enabled ? 'disabled' : !session.device ? 'unavailable' : reason === 'sidecar_disconnected' ? 'sidecar_offline' : 'idle', reason);
  }
  invalidateAll(reason: string, options: { stopDevices?: boolean } = {}): void { this.stopCalibration(); for (const session of this.sessions.values()) this.invalidate(session, reason, options); }
  invalidateCamera(cameraId: string, reason: string, options: { stopDevices?: boolean } = {}): void {
    if (this.calibration?.cameraId === cameraId) this.stopCalibration();
    for (const session of this.sessions.values()) if (session.status.cameraId === cameraId) this.invalidate(session, reason, options);
  }
  emergencyStop(options: { stopDevices?: boolean } = {}): void { this.invalidateAll('emergency_stop', options); }
  acquireCalibration(sourceId: string, stop: () => void): () => void {
    const session = this.get(sourceId);
    if (!this.started || !this.config.enabled || !this.client.connected || !this.ready(session) || !session.status.cameraId) throw new TrackingError(409, 'calibration_unavailable', 'Healthy tracking and gimbal are required');
    if (this.calibration || [...this.sessions.values()].some(item => item.status.sessionId) || [...this.devices.values()].some(device => this.ledger.isMoving(device))) throw new TrackingError(409, 'calibration_busy', 'Stop tracking and manual motion before calibration');
    const owned = { sourceId, cameraId: session.status.cameraId, stop }; this.calibration = owned;
    return () => { if (this.calibration === owned) this.calibration = undefined; };
  }
  private stopCalibration(): void {
    const owned = this.calibration; this.calibration = undefined;
    try { owned?.stop(); } catch { /* Other sessions must still receive their stop. */ }
  }
  reconcile(config: TrackingConfig, sources: ResolvedTrackingSource[], devices: Map<string, MotionDevice>): void {
    this.invalidateAll('binding_changed');
    const wasStarted = this.started; this.stop();
    this.config = config; this.sources = sources; this.devices = devices; this.sessions.clear(); this.populate(); this.onStatus?.(this.getStatus());
    if (wasStarted && config.enabled) this.start();
  }
  private receive = (value: unknown): void => {
    if (!this.started) return;
    const obs = parseFromTracker(value, this.now()); if (!obs || obs.type !== 'track') return;
    const session = this.sessions.get(obs.sourceId);
    if (!session || !session.status.sessionId || session.status.sessionId !== obs.sessionId || obs.seq <= session.seq) return;
    session.seq = obs.seq; session.status.observation = { ...obs };
    if (session.status.state === 'operator_override') { this.onStatus?.(this.getStatus()); return; }
    if (obs.state !== 'tracking') {
      this.halt(session);
      if (obs.state === 'idle') this.invalidate(session, 'target_idle');
      else if (obs.state === 'lost') { session.lostAt ??= this.now(); this.transition(session, 'holding', 'target_lost'); }
      else this.transition(session, 'locking');
    } else if (this.now() - obs.frameTs < 500) {
      session.lostAt = null; this.transition(session, 'tracking');
    }
    this.onStatus?.(this.getStatus());
  };
  tick(now = this.now()): void {
    if (!this.started || !this.config.enabled) return;
    for (const session of this.sessions.values()) {
      if (!session.status.sessionId) continue;
      if (!this.ready(session)) { this.invalidate(session, 'device_lost'); continue; }
      if (!this.client.connected) { this.invalidate(session, 'sidecar_disconnected'); continue; }
      if (session.status.state === 'operator_override') continue;
      if (session.lostAt !== null) {
        if (now - session.lostAt >= this.config.lostHoldMs) this.invalidate(session, 'target_lost');
        continue;
      }
      const obs = session.status.observation;
      if (!obs || obs.state !== 'tracking') continue;
      if (now - obs.frameTs >= 500 || obs.frameTs > now + 50) { this.halt(session); this.transition(session, 'stale', 'stale_video'); continue; }
      const output = session.controller.update(obs, now);
      session.status.pan = output.pan; session.status.tilt = output.tilt;
      if (output.pan === 0 && output.tilt === 0) this.halt(session);
      else if (session.device && this.ledger.send(session.device, output.pan, output.tilt, now)) session.halted = false;
    }
  }
  getStatus(): Record<string, TrackingSourceStatus> {
    return Object.fromEntries([...this.sessions].map(([key, session]) => [key, { ...session.status, observation: session.status.observation ? { ...session.status.observation } : null }]));
  }
}
