import dgram from 'dgram';
import { EventEmitter } from 'events';
import { logger } from '../index';

const BACKOFF_INITIAL = 1000;
const BACKOFF_MAX = 30000;

interface PendingInquiry {
  resolve: (buf: Buffer) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class ViscaClient extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private ip: string;
  private port: number;
  private cameraId: string;
  private backoff = BACKOFF_INITIAL;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pendingInquiry: PendingInquiry | null = null;
  private seqNum = 2;
  connected = false;

  constructor(cameraId: string, ip: string, port: number) {
    super();
    this.cameraId = cameraId;
    this.ip = ip;
    this.port = port;
  }

  connect(): void {
    this.buildSocket();
  }

  private buildSocket(): void {
    if (this.socket) {
      try { this.socket.close(); } catch { /* ignore */ }
    }
    const sock = dgram.createSocket('udp4');
    this.socket = sock;

    sock.on('error', (err) => {
      logger.warn({ err, cameraId: this.cameraId }, 'VISCA socket error, reconnecting');
      this.connected = false;
      if (this.pendingInquiry) {
        clearTimeout(this.pendingInquiry.timer);
        this.pendingInquiry.reject(new Error('VISCA socket error during inquiry'));
        this.pendingInquiry = null;
      }
      this.emit('disconnected');
      this.scheduleReconnect();
    });

    sock.on('message', (msg) => {
      this.emit('message', msg);
      // Inquiry response: VISCA-over-IP reply type bytes 0=0x01, 1=0x11; payload starts at byte 8
      if (msg[0] === 0x01 && msg[1] === 0x11 && this.pendingInquiry) {
        const payload = msg.slice(8);
        if (payload[0] === 0x90 && payload[1] === 0x50) {
          clearTimeout(this.pendingInquiry.timer);
          const resolve = this.pendingInquiry.resolve;
          this.pendingInquiry = null;
          resolve(payload);
        }
      }
    });

    sock.bind(0, () => {
      this.connected = true;
      this.backoff = BACKOFF_INITIAL;
      logger.info({ cameraId: this.cameraId, ip: this.ip, port: this.port }, 'VISCA camera connected');
      this.emit('connected');
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX);
      logger.info({ cameraId: this.cameraId, backoff: this.backoff }, 'attempting VISCA reconnect');
      this.buildSocket();
    }, this.backoff);
  }

  send(bytes: Buffer): void {
    if (!this.connected || !this.socket) {
      logger.warn({ cameraId: this.cameraId }, 'VISCA not connected, dropping command');
      return;
    }
    this.socket.send(bytes, 0, bytes.length, this.port, this.ip, (err) => {
      if (err) logger.warn({ err, cameraId: this.cameraId }, 'VISCA send error');
    });
  }

  async inquire(payload: number[], timeoutMs = 2000): Promise<Buffer> {
    if (!this.connected || !this.socket) {
      throw new Error(`VISCA camera ${this.cameraId} not connected`);
    }
    if (this.pendingInquiry) {
      throw new Error(`VISCA camera ${this.cameraId} inquiry already in progress`);
    }
    return new Promise((resolve, reject) => {
      const seq = this.seqNum++;
      const timer = setTimeout(() => {
        this.pendingInquiry = null;
        reject(new Error(`VISCA inquiry timeout for ${this.cameraId}`));
      }, timeoutMs);
      this.pendingInquiry = { resolve, reject, timer };
      const seqBytes = [(seq >> 24) & 0xFF, (seq >> 16) & 0xFF, (seq >> 8) & 0xFF, seq & 0xFF];
      const header = [0x01, 0x00, 0x00, payload.length, ...seqBytes];
      const packet = Buffer.from([...header, ...payload]);
      this.socket!.send(packet, 0, packet.length, this.port, this.ip, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingInquiry = null;
          reject(err);
        }
      });
    });
  }

  close(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.pendingInquiry) {
      clearTimeout(this.pendingInquiry.timer);
      this.pendingInquiry.reject(new Error('VISCA client closed'));
      this.pendingInquiry = null;
    }
    if (this.socket) {
      try { this.socket.close(); } catch { /* ignore */ }
      this.socket = null;
    }
    this.connected = false;
  }
}
