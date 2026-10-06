import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import { parseToTracker, TrackMessage, ToTracker } from '../tracking/protocol';
/** Disposable authenticated loopback server; contains no frames or hardware. */
export class VirtualTrackingSidecar {
  private server?: WebSocketServer;
  private silent = false;
  private peers = new Set<WebSocket>();
  private selections = new Map<string, string>();
  messages: ToTracker[] = [];
  constructor(private options: { token?: string } = {}) {}
  async start(): Promise<number> {
    this.server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 65536,
      verifyClient: (info: { req: IncomingMessage }) => !info.req.headers.origin && (!this.options.token || info.req.headers.authorization === `Bearer ${this.options.token}`) });
    this.server.on('connection', ws => {
      this.peers.add(ws); ws.on('close', () => this.peers.delete(ws)); ws.on('error', () => {});
      ws.on('message', (data, binary) => {
        if (binary) return;
        let value: unknown; try { value = JSON.parse(data.toString()); } catch { return; }
        const message = parseToTracker(value); if (!message) return; this.messages.push(message);
        if (message.type === 'hello') this.send(ws, { protocol: 1, type: 'hello', version: 'virtual-1', capabilities: ['person'], detector: 'mock', provider: 'synthetic', degradedTiming: false });
        else if (message.type === 'configure') this.selections.clear();
        else if (message.type === 'select') this.selections.set(message.sourceId, message.sessionId);
        else if (message.type === 'cancel' && this.selections.get(message.sourceId) === message.sessionId) this.selections.delete(message.sourceId);
        else if (message.type === 'ping' && !this.silent) this.send(ws, { protocol: 1, type: 'pong', nonce: message.nonce });
      });
    });
    await new Promise<void>((resolve, reject) => { this.server!.once('listening', resolve); this.server!.once('error', reject); });
    const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('Virtual sidecar did not bind'); return address.port;
  }
  private send(ws: WebSocket, value: unknown): void { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); }
  raw(value: string | Buffer): void { for (const ws of this.peers) if (ws.readyState === WebSocket.OPEN) ws.send(value); }
  emitTrack(track: TrackMessage): void { if (this.selections.get(track.sourceId) === track.sessionId && !this.silent) for (const ws of this.peers) this.send(ws, track); }
  goSilent(): void { this.silent = true; }
  drop(): void { for (const ws of this.peers) ws.terminate(); this.selections.clear(); }
  async stop(): Promise<void> { this.drop(); if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve())); this.server = undefined; }
}
