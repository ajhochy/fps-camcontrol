import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { MotionDevice, DeviceCapabilities, DevicePosition } from './motionDevice';
import { ActivityLog } from '../app/activityLog';
import { logger } from '../index';

const PROTOCOL_VERSION = 1;
const HEARTBEAT_INTERVAL_MS = 1000;
const HEARTBEAT_TIMEOUT_MS = 3000;
const DEFAULT_BACKOFF = [1000, 2000, 5000, 15000];

export interface BridgeConfig {
  host: string;
  port: number;
  gimbalModel?: string;
  safetyTimeoutMs: number;
  reconnectBackoffMs: number[];
  rollEnabled: boolean;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

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

  constructor(bridge: BridgeConfig, public readonly id: string, public label: string) {
    super();
    this.bridge = {
      ...bridge,
      reconnectBackoffMs: bridge.reconnectBackoffMs?.length ? bridge.reconnectBackoffMs : DEFAULT_BACKOFF,
    };
  }

  get connected(): boolean {
    return this._connected;
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
          const r = res as { capabilities?: string[]; gimbalModel?: string; bridgeVersion?: string };
          this.applyCapabilities(r.capabilities ?? []);
          this._connected = true;
          logger.info({ id: this.id, capabilities: r.capabilities, gimbalModel: r.gimbalModel }, 'DJI bridge connected');
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
    if (this._connected) {
      this._connected = false;
      this.emit('disconnected');
    }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
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
      }
    }, HEARTBEAT_INTERVAL_MS);
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
        const p = frame.params as { position?: { yaw: number; pitch: number; roll: number } } | undefined;
        if (p?.position) {
          this.lastPos = { kind: 'gimbal', yaw: p.position.yaw, pitch: p.position.pitch, roll: p.position.roll };
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

  private sendCommand(method: string, params: Record<string, unknown>): void {
    this.sendFrame({ v: PROTOCOL_VERSION, type: 'cmd', id: this.nextId++, method, params });
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
        reject(new Error(`${this.id}: ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sendFrame({ v: PROTOCOL_VERSION, type: 'cmd', id, method, params });
    });
  }
}
