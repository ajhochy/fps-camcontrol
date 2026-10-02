import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';

const PROTOCOL_VERSION = 1;

/** Methods the real Pi driver rejects outright when it has no BLE link. */
const GIMBAL_TOUCHING_METHODS = new Set(['moveVelocity', 'getPosition', 'moveToPosition', 'recenter', 'setMode', 'wake']);

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
  /** Start with a gimbal attached (default true). */
  gimbalConnected?: boolean;
  /** How often to emit `status`, matching the Pi's 500 ms loop. */
  statusIntervalMs?: number;
  /** Answer GET /info like a bridge >= 0.2.0 (default true); false acts like an older bridge. */
  info?: boolean;
  /** The Pi's host name reported by /info and hello (default "virtual-pi"). */
  hostname?: string;
  instance?: string | null;
  /** The gimbal's Bluetooth address (default derived from the port). */
  gimbalAddress?: string | null;
  /** Bluetooth gimbal selection like a bridge >= 0.6.0: `bluetooth` in /info, hello and status, GET /gimbals and
   * POST /gimbal (default true). False answers those routes like an older bridge (426). */
  gimbalSelect?: boolean;
  /** What a Bluetooth scan on this fake Pi hears (default: this gimbal, another DJI gimbal and a phone). */
  nearby?: { address: string; name: string | null; rssi: number }[];
}

/**
 * In-process WS server that emulates the Pi bridge contract. Used by the
 * smoke test so the DjiBridgeDevice path can be exercised without a Pi.
 *
 * Integrates pan/tilt velocity into yaw/pitch over real time at 30 deg/s
 * full-scale, which is enough to verify the command path and round-trip
 * preset save/recall.
 *
 * It also runs the `status` telemetry loop, and models the Pi's real behaviour
 * when no gimbal is attached: `hello` and `ping` keep working (the bridge stays
 * reachable on purpose) but the status stream goes SILENT rather than reporting
 * `gimbalConnected: false`, because the Pi builds each frame from a live pose
 * poll that raises when the gimbal is gone. Verified against a real RS3 Pro with
 * its BLE link down. `setGimbalConnected` flips between the two.
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
  private statusTimer: NodeJS.Timeout | null = null;
  private connections = new Set<WebSocket>();
  private gimbalConnected: boolean;
  private statusIntervalMs: number;
  /** Emit `gimbalConnected: false` instead of going silent (a future bridge). */
  explicitDetachedStatus = false;
  /** See goSilent(): attached but unresponsive, neither acking nor nacking. */
  private silent = false;
  log: string[] = [];
  /** Linked and reporting its pose, but ignoring every move (asleep, motors off). */
  asleep = false;
  /** Send the gimbal's sleep report (asleep: this.asleep) with each status, like a bridge >= 0.4.0. */
  reportSleep = false;
  /** Wake commands received (bridge 0.5.0+ "wake"). */
  wakes = 0;
  /** When false the bridge acks a wake but the gimbal stays asleep (e.g. motor protection on an RS3 Pro). */
  wakeWorks = true;
  /** Bluetooth link figures sent with every status (like a bridge >= 0.3.0); null sends none. */
  link: { drops10m: number; framesLastMin: number; corruptLastMin: number; linkedForS: number | null } | null = { drops10m: 0, framesLastMin: 60, corruptLastMin: 0, linkedForS: 100 };
  /** GET /info requests answered (they open no session). */
  infoRequests = 0;
  /** WebSocket sessions ever opened (a probe that says hello opens one). */
  sessionsOpened = 0;
  private identity: { hostname: string; instance: string | null; gimbalAddress: string | null };
  private gimbalSelect: boolean;
  /** What a scan hears; the linked gimbal is left out of scan results (a linked DJI gimbal stops advertising). */
  nearby: { address: string; name: string | null; rssi: number }[];
  /** How the current gimbal was chosen, as the bridge reports it. */
  chosenBy = 'config';
  /** GET /gimbals requests, and how many of them scanned. */
  gimbalListRequests = 0;
  scans = 0;
  /** Gimbal switches carried out (POST /gimbal), in order. */
  switches: string[] = [];
  /** How long a switch leaves the gimbal unlinked before the new one connects. */
  switchReconnectMs = 150;

  constructor(opts: VirtualDjiBridgeOptions = {}) {
    this.port = opts.port ?? 0;
    this.capabilities = opts.capabilities ?? ['velocity', 'position', 'moveTo', 'wake'];
    this.gimbalModel = opts.gimbalModel ?? 'mock-RS4Pro';
    this.safetyTimeoutMs = opts.safetyTimeoutMs ?? 250;
    this.gimbalConnected = opts.gimbalConnected ?? true;
    this.statusIntervalMs = opts.statusIntervalMs ?? 200;

    const info = opts.info ?? true;
    this.identity = {
      hostname: opts.hostname ?? 'virtual-pi',
      instance: opts.instance ?? null,
      gimbalAddress: opts.gimbalAddress === undefined ? `AA:BB:CC:00:${String(Math.floor(this.port / 256) % 100).padStart(2, '0')}:${String(this.port % 100).padStart(2, '0')}` : opts.gimbalAddress,
    };
    this.gimbalSelect = opts.gimbalSelect ?? true;
    const own = this.identity.gimbalAddress;
    this.nearby = opts.nearby ?? [
      ...(own ? [{ address: own, name: 'DJI RS3 PRO-VIRTUAL', rssi: -50 }] : []),
      { address: 'AA:BB:CC:99:99:01', name: 'DJI RS3-NEIGHBOUR', rssi: -72 },
      { address: 'AA:BB:CC:99:99:02', name: 'Someone’s phone', rssi: -35 },
    ];
    this.server = http.createServer((req, res) => {
      const [path, query = ''] = (req.url ?? '').split('?');
      if (info && req.method === 'GET' && path === '/info') {
        this.infoRequests++;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(this.info()));
        return;
      }
      if (this.gimbalSelect && (path === '/gimbals' || path === '/gimbal')) {
        const [status, body] = this.gimbalRoute(req.method ?? 'GET', path, new URLSearchParams(query));
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('Upgrade Required');
    });
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  async start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(this.port, '127.0.0.1', () => {
        const addr = this.server.address();
        if (addr && typeof addr === 'object') this.port = addr.port;
        this.startStatusLoop();
        resolve(this.port);
      });
    });
  }

  /**
   * Power the gimbal on or off without touching the WebSocket, reproducing the
   * one state this bug was about: bridge reachable, gimbal absent.
   */
  setGimbalConnected(connected: boolean): void {
    this.gimbalConnected = connected;
  }

  /**
   * Model a gimbal that is attached but too busy to answer: telemetry stops and
   * gimbal calls never come back — no reply, no rejection. Measured on real
   * hardware at 13.6s for a healthy gimbal on a shared bridge, so this state
   * must NOT be read as a detached gimbal. `ping` keeps working.
   */
  goSilent(): void {
    this.silent = true;
  }

  private startStatusLoop(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = setInterval(() => {
      if (this.silent) return;
      if (!this.gimbalConnected && !this.explicitDetachedStatus) return; // silence, like the Pi
      this.integrate();
      const params: Record<string, unknown> = {
        gimbalConnected: this.gimbalConnected,
        sdkConnected: this.gimbalConnected,
        ...(this.link ? { link: this.link } : {}),
        ...(this.reportSleep ? { asleep: this.asleep } : {}),
        ...(this.gimbalSelect ? { bluetooth: this.bluetooth() } : {}),
        mode: 'follow',
      };
      if (this.gimbalConnected) {
        params.position = { yaw: this.yaw, pitch: this.pitch, roll: this.roll };
      }
      for (const ws of this.connections) {
        this.send(ws, { v: PROTOCOL_VERSION, type: 'evt', method: 'status', params });
      }
    }, this.statusIntervalMs);
  }

  async stop(): Promise<void> {
    for (const ws of this.connections) {
      try { ws.close(); } catch { /* ignore */ }
    }
    this.connections.clear();
    if (this.statusTimer) { clearInterval(this.statusTimer); this.statusTimer = null; }
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

  /** What a bridge >= 0.2.0 says about itself on GET /info (with `bluetooth` like 0.6.0 when gimbalSelect is on). */
  info(): Record<string, unknown> {
    return { bridgeVersion: this.gimbalSelect ? '0.6.0' : '0.2.0', ...this.identity, port: this.port, gimbalModel: this.gimbalModel, gimbalConnected: this.gimbalConnected, clients: this.connections.size, ...(this.gimbalSelect ? { bluetooth: this.bluetooth() } : {}) };
  }

  /** The bridge's `bluetooth` block: which gimbal it drives. */
  bluetooth(): Record<string, unknown> {
    const address = this.identity.gimbalAddress;
    const seen = this.nearby.find((g) => g.address === address);
    return { mode: address ? 'fixed' : 'auto', address, name: seen?.name ?? null, rssi: seen?.rssi ?? null, chosenBy: address ? this.chosenBy : null, chosenAt: null, saved: true, connected: this.gimbalConnected, switching: false, canScan: true, error: null };
  }

  /** GET /gimbals[?scan=1] and POST /gimbal?address=..., like dji_bridge.py's http_route. */
  private gimbalRoute(method: string, path: string, query: URLSearchParams): [number, Record<string, unknown>] {
    if (path === '/gimbals') {
      if (method !== 'GET') return [405, { ok: false, error: 'use GET /gimbals' }];
      this.gimbalListRequests++;
      const scanned = query.get('scan') === '1' || !this.gimbalConnected;
      if (scanned) this.scans++;
      const own = this.identity.gimbalAddress;
      const heard = scanned ? this.nearby.filter((g) => /^DJI RS/i.test(g.name ?? '') && !(this.gimbalConnected && g.address === own)) : [];
      const rows: Record<string, unknown>[] = heard.map((g) => ({ ...g, advertising: true }));
      if (own && !rows.some((r) => r.address === own)) {
        const seen = this.nearby.find((g) => g.address === own);
        rows.unshift({ address: own, name: seen?.name ?? null, rssi: seen?.rssi ?? null, advertising: false });
      }
      const withRssi = rows.filter((r) => typeof r.rssi === 'number').sort((a, b) => (b.rssi as number) - (a.rssi as number));
      for (const r of rows) {
        r.selected = r.address === own;
        r.connected = r.selected && this.gimbalConnected;
        r.strongest = withRssi[0] === r;
      }
      return [200, { scanned, scannedAt: scanned ? Date.now() / 1000 : null, note: scanned ? 'Scanned just now.' : 'Not scanned: a gimbal is linked. Ask with ?scan=1.', error: null, selected: this.bluetooth(), gimbals: rows }];
    }
    if (method !== 'POST') return [405, { ok: false, error: 'use POST /gimbal?address=<address|auto> to switch gimbals' }];
    const raw = (query.get('address') ?? '').trim();
    let target = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i.test(raw) ? raw.toUpperCase() : null;
    if (raw.toLowerCase() === 'auto') {
      const best = this.nearby.filter((g) => /^DJI RS/i.test(g.name ?? '')).sort((a, b) => b.rssi - a.rssi)[0];
      if (!best) return [404, { ok: false, error: 'no DJI gimbal is advertising; kept the previous gimbal', selected: this.bluetooth() }];
      target = best.address;
    }
    if (!target) return [400, { ok: false, error: 'address must be a Bluetooth address like 48:1C:B9:54:C6:BC, or "auto"', selected: this.bluetooth() }];
    // Like the Pi: stop, drop the link (a DJI gimbal takes one connection), point at the new one, reconnect.
    this.integrate();
    this.velPan = 0;
    this.velTilt = 0;
    this.switches.push(target);
    this.identity.gimbalAddress = target;
    this.chosenBy = raw.toLowerCase() === 'auto' ? 'auto-strongest' : 'operator';
    this.gimbalConnected = false;
    setTimeout(() => { this.gimbalConnected = true; }, this.switchReconnectMs);
    return [200, { ok: true, selected: this.bluetooth() }];
  }

  private onConnection(ws: WebSocket): void {
    this.sessionsOpened++;
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

    // With no gimbal on the far end the real Pi still serves `hello` and `ping`
    // (that is the point of staying reachable) but every call that actually
    // touches the gimbal is rejected immediately — measured at ~0ms, because the
    // BLE write fails before it is attempted. `stop` is the odd one out: the real
    // driver returns early when it has no link, so it acks happily and is
    // therefore worthless as proof of a gimbal.
    if (!this.gimbalConnected && GIMBAL_TOUCHING_METHODS.has(frame.method ?? '')) {
      this.nack(ws, frame.id, 'sdk_error', "BleakError('Service Discovery has not been performed yet')");
      return;
    }
    // Attached but swamped: swallow gimbal calls entirely. Only `ping` answers.
    if (this.silent && GIMBAL_TOUCHING_METHODS.has(frame.method ?? '')) return;

    switch (frame.method) {
      case 'hello':
        this.ack(ws, frame.id, {
          bridgeVersion: 'virtual-0.1',
          gimbalModel: this.gimbalModel,
          capabilities: this.gimbalSelect ? [...this.capabilities, 'gimbalSelect'] : this.capabilities,
          ...this.identity,
          port: this.port,
          ...(this.gimbalSelect ? { bluetooth: this.bluetooth() } : {}),
        });
        return;
      case 'ping':
        this.ack(ws, frame.id, {});
        this.send(ws, { v: PROTOCOL_VERSION, type: 'evt', method: 'pong', params: { ts: Date.now() } });
        return;
      case 'moveVelocity': {
        this.integrate();
        const p = frame.params as { pan?: number; tilt?: number };
        // An asleep gimbal acks moves and keeps reporting its pose, but does not move (like an unbalanced RS3 Pro).
        this.velPan = this.asleep ? 0 : p?.pan ?? 0;
        this.velTilt = this.asleep ? 0 : p?.tilt ?? 0;
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
      case 'wake': {
        if (!this.capabilities.includes('wake')) { this.nack(ws, frame.id, 'not_supported', 'unknown method wake'); return; }
        this.wakes++;
        if (this.wakeWorks) this.asleep = false;
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
