import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { MAX_MESSAGE_BYTES, parseFromTracker, parseToTracker, safeFrameUrl, ToTracker, TrackerSource } from './protocol';

export interface TrackingClientOptions {
  enabled: boolean; url: string; token?: string; backendOrigin?: string; allowRemote?: boolean; packaged?: boolean;
  now?: () => number; random?: () => number;
  timers?: Pick<typeof globalThis, 'setTimeout'|'clearTimeout'|'setInterval'|'clearInterval'>;
}
export class TrackingClient extends EventEmitter {
  connected = false;
  invalidMessages = 0;
  private ws?: WebSocket;
  private running = false;
  private sources: TrackerSource[] = [];
  private sessions = new Map<string, { id: string; seq: number }>();
  private retries = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private connectedAt = 0;
  private ping?: { nonce: string; at: number };
  private readonly now: () => number;
  private readonly timers: NonNullable<TrackingClientOptions['timers']>;
  private options: TrackingClientOptions;
  constructor(options: TrackingClientOptions) {
    super(); this.options = options; this.now = options.now ?? Date.now; this.timers = options.timers ?? globalThis;
    this.validateUrl(options.url);
  }
  private validateUrl(value: string): void {
    const url = new URL(value);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('Invalid tracking sidecar URL');
    if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) && (this.options.packaged || !this.options.allowRemote)) throw new Error('Tracking sidecar must use loopback');
  }
  /** Point a stopped client at a restarted owned helper (new port and private token). */
  retarget(url: string, token?: string): void {
    this.validateUrl(url); this.stop(); this.options = { ...this.options, url, token }; this.retries = 0;
  }
  configure(sources: TrackerSource[]): void {
    const message = parseToTracker({ protocol: 1, type: 'configure', sources });
    if (!message || sources.some(source => !safeFrameUrl(source.frameUrl, this.options.backendOrigin))) throw new Error('Invalid tracking frame source');
    this.sources = sources.map(source => ({ ...source })); this.sessions.clear();
    if (this.connected) this.send(message);
  }
  start(): void { if (this.running || !this.options.enabled) return; this.running = true; this.connect(); }
  stop(): void {
    this.running = false;
    if (this.retryTimer) this.timers.clearTimeout(this.retryTimer); this.retryTimer = undefined;
    const ws = this.ws; this.drop(ws); ws?.terminate();
  }
  private connect(): void {
    if (!this.running || this.ws) return;
    const headers = this.options.token ? { Authorization: `Bearer ${this.options.token}` } : undefined;
    const ws = new WebSocket(this.options.url, { headers, maxPayload: MAX_MESSAGE_BYTES, handshakeTimeout: 3000, perMessageDeflate: false });
    this.ws = ws; this.connectedAt = this.now();
    ws.on('open', () => { if (this.ws === ws) this.send({ protocol: 1, type: 'hello' }); });
    ws.on('message', (data, binary) => {
      if (this.ws !== ws) return;
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (binary || bytes.length > MAX_MESSAGE_BYTES) { this.invalidMessages++; return; }
      let value: unknown;
      try { value = JSON.parse(bytes.toString()); } catch { this.invalidMessages++; return; }
      const message = parseFromTracker(value, this.now());
      if (!message) { this.invalidMessages++; return; }
      if (message.type === 'hello') {
        if (this.connected) { this.invalidMessages++; return; }
        this.connected = true; this.retries = 0; this.connectedAt = this.now();
        this.send({ protocol: 1, type: 'configure', sources: this.sources }); this.emit('connected', message); return;
      }
      if (!this.connected) { this.invalidMessages++; return; }
      if (message.type === 'pong') { if (this.ping?.nonce === message.nonce) this.ping = undefined; return; }
      if ('sourceId' in message && message.sourceId && !this.sources.some(source => source.sourceId === message.sourceId)) return;
      if (message.type === 'track') {
        const session = this.sessions.get(message.sourceId);
        if (!session || message.sessionId !== session.id || message.seq <= session.seq) return;
        session.seq = message.seq; this.emit('track', message);
      } else if (message.type === 'status') this.emit('status', message);
      else if (message.type === 'error') {
        // Curated machine code only; never forward a helper's raw message.
        this.emit('protocolError', { code: /^[a-z_]{1,64}$/.test(message.code) ? message.code : 'sidecar_error', sourceId: message.sourceId });
      }
    });
    ws.on('error', () => { if (this.ws === ws) { this.invalidMessages++; this.drop(ws); ws.terminate(); } });
    ws.on('close', () => this.drop(ws));
    this.heartbeat = this.timers.setInterval(() => {
      if (this.ws !== ws) return;
      const now = this.now();
      if ((!this.connected && now - this.connectedAt >= 3000) || (this.ping && now - this.ping.at >= 3000)) { this.drop(ws); ws.terminate(); return; }
      if (this.connected && !this.ping) { this.ping = { nonce: randomUUID(), at: now }; this.send({ protocol: 1, type: 'ping', nonce: this.ping.nonce }); }
    }, 1000);
  }
  private drop(ws?: WebSocket): void {
    if (ws !== this.ws) return;
    const wasConnected = this.connected; this.connected = false; this.ws = undefined; this.sessions.clear(); this.ping = undefined;
    if (this.heartbeat) this.timers.clearInterval(this.heartbeat); this.heartbeat = undefined;
    if (wasConnected) this.emit('disconnected');
    if (this.running && !this.retryTimer) {
      const delays = [250, 500, 1000, 2000, 4000, 5000];
      const delay = Math.min(5000, Math.round(delays[Math.min(this.retries++, delays.length - 1)] * (.8 + .4 * (this.options.random?.() ?? Math.random()))));
      this.retryTimer = this.timers.setTimeout(() => { this.retryTimer = undefined; this.connect(); }, delay);
    }
  }
  private send(message: ToTracker): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    try { this.ws.send(JSON.stringify(message)); return true; } catch { return false; }
  }
  select(sourceId: string, sessionId: string, x: number, y: number): boolean {
    const message = parseToTracker({ protocol: 1, type: 'select', sourceId, sessionId, x, y });
    if (!this.connected || !message || !this.sources.some(source => source.sourceId === sourceId)) return false;
    this.sessions.set(sourceId, { id: sessionId, seq: -1 });
    if (!this.send(message)) { this.sessions.delete(sourceId); return false; } return true;
  }
  cancel(sourceId: string, sessionId: string): boolean {
    if (this.sessions.get(sourceId)?.id === sessionId) this.sessions.delete(sourceId);
    const message = parseToTracker({ protocol: 1, type: 'cancel', sourceId, sessionId });
    return !!message && this.connected && this.send(message);
  }
}
