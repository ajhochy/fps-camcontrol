import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';

const PROTOCOL_VERSION = 1;

interface Frame {
  v: number;
  id?: number;
  type: 'cmd' | 'ack' | 'evt';
  method?: string;
  params?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface VirtualDjiBridgeOptions {
  port?: number;
  capabilities?: string[];
  gimbalModel?: string;
  safetyTimeoutMs?: number;
}

/**
 * In-process WS server that emulates the Pi bridge contract. Used by the
 * smoke test so the DjiBridgeDevice path can be exercised without a Pi.
 *
 * Integrates pan/tilt velocity into yaw/pitch over real time at 30 deg/s
 * full-scale, which is enough to verify the command path and round-trip
 * preset save/recall.
 */
export class VirtualDjiBridge {
  private server: http.Server;
  private wss: WebSocketServer;
  port: number;
  private capabilities: string[];
  private gimbalModel: string;
  private safetyTimeoutMs: number;

  yaw = 0;
  pitch = 0;
  roll = 0;
  velPan = 0;
  velTilt = 0;
  private lastTickAt = Date.now();
  private safetyTimer: NodeJS.Timeout | null = null;
  private connections = new Set<WebSocket>();
  log: string[] = [];

  constructor(opts: VirtualDjiBridgeOptions = {}) {
    this.port = opts.port ?? 0;
    this.capabilities = opts.capabilities ?? ['velocity', 'position', 'moveTo'];
    this.gimbalModel = opts.gimbalModel ?? 'mock-RS4Pro';
    this.safetyTimeoutMs = opts.safetyTimeoutMs ?? 250;

    this.server = http.createServer();
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  async start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(this.port, '127.0.0.1', () => {
        const addr = this.server.address();
        if (addr && typeof addr === 'object') this.port = addr.port;
        resolve(this.port);
      });
    });
  }

  async stop(): Promise<void> {
    for (const ws of this.connections) {
      try { ws.close(); } catch { /* ignore */ }
    }
    this.connections.clear();
    if (this.safetyTimer) { clearTimeout(this.safetyTimer); this.safetyTimer = null; }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  reset(): void {
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.velPan = 0;
    this.velTilt = 0;
    this.log = [];
  }

  private onConnection(ws: WebSocket): void {
    this.connections.add(ws);
    ws.on('message', (data) => this.onFrame(ws, data.toString()));
    ws.on('close', () => this.connections.delete(ws));
  }

  private integrate(): void {
    const now = Date.now();
    const dt = (now - this.lastTickAt) / 1000;
    this.lastTickAt = now;
    const fullScaleDegPerSec = 30;
    this.yaw += this.velPan * fullScaleDegPerSec * dt;
    this.pitch += this.velTilt * fullScaleDegPerSec * dt;
  }

  private send(ws: WebSocket, frame: Frame): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(frame));
  }

  private ack(ws: WebSocket, id: number, params: Record<string, unknown> = {}): void {
    this.send(ws, { v: PROTOCOL_VERSION, type: 'ack', id, params });
  }

  private nack(ws: WebSocket, id: number, code: string, message: string): void {
    this.send(ws, { v: PROTOCOL_VERSION, type: 'ack', id, error: { code, message } });
  }

  private armSafety(ws: WebSocket): void {
    if (this.safetyTimer) clearTimeout(this.safetyTimer);
    this.safetyTimer = setTimeout(() => {
      this.integrate();
      this.velPan = 0;
      this.velTilt = 0;
      this.log.push('safety-stop');
      this.send(ws, { v: PROTOCOL_VERSION, type: 'evt', method: 'safetyStop', params: { reason: 'app_timeout' } });
    }, this.safetyTimeoutMs);
  }

  private onFrame(ws: WebSocket, raw: string): void {
    let frame: Frame;
    try { frame = JSON.parse(raw); } catch { return; }
    if (frame.type !== 'cmd' || typeof frame.id !== 'number') return;
    this.log.push(`${frame.method} ${JSON.stringify(frame.params ?? {})}`);

    switch (frame.method) {
      case 'hello':
        this.ack(ws, frame.id, {
          bridgeVersion: 'virtual-0.1',
          gimbalModel: this.gimbalModel,
          capabilities: this.capabilities,
        });
        return;
      case 'ping':
        this.ack(ws, frame.id, {});
        this.send(ws, { v: PROTOCOL_VERSION, type: 'evt', method: 'pong', params: { ts: Date.now() } });
        return;
      case 'moveVelocity': {
        this.integrate();
        const p = frame.params as { pan?: number; tilt?: number };
        this.velPan = p?.pan ?? 0;
        this.velTilt = p?.tilt ?? 0;
        this.armSafety(ws);
        this.ack(ws, frame.id, {});
        return;
      }
      case 'stop': {
        this.integrate();
        this.velPan = 0;
        this.velTilt = 0;
        if (this.safetyTimer) { clearTimeout(this.safetyTimer); this.safetyTimer = null; }
        this.ack(ws, frame.id, {});
        return;
      }
      case 'getPosition': {
        this.integrate();
        this.ack(ws, frame.id, { yaw: this.yaw, pitch: this.pitch, roll: this.roll, ts: Date.now() });
        return;
      }
      case 'recenter': {
        this.yaw = 0;
        this.pitch = 0;
        this.roll = 0;
        this.velPan = 0;
        this.velTilt = 0;
        this.ack(ws, frame.id, {});
        return;
      }
      case 'moveToPosition': {
        const p = frame.params as { yaw?: number; pitch?: number; roll?: number };
        this.yaw = p?.yaw ?? this.yaw;
        this.pitch = p?.pitch ?? this.pitch;
        this.roll = p?.roll ?? this.roll;
        this.ack(ws, frame.id, { ok: true });
        return;
      }
      default:
        this.nack(ws, frame.id, 'not_supported', `unknown method ${frame.method}`);
    }
  }
}
