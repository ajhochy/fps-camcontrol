import dgram from 'dgram';
import { EventEmitter } from 'events';
import { logger } from '../index';

const BACKOFF_INITIAL = 1000;
const BACKOFF_MAX = 30000;

// VISCA IF_CLEAR: reset camera command buffer (safe no-op for most cameras)
const IF_CLEAR = Buffer.from([0x81, 0x01, 0x00, 0x01, 0xff]);

export class ViscaClient extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private ip: string;
  private port: number;
  private cameraId: string;
  private cameraType: string;
  private backoff = BACKOFF_INITIAL;
  private reconnectTimer: NodeJS.Timeout | null = null;
  connected = false;

  constructor(cameraId: string, ip: string, port: number, cameraType = 'generic') {
    super();
    this.cameraId = cameraId;
    this.ip = ip;
    this.port = port;
    this.cameraType = cameraType;
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
      this.emit('disconnected');
      this.scheduleReconnect();
    });

    sock.on('message', (msg) => {
      this.emit('message', msg);
    });

    sock.bind(0, () => {
      this.connected = true;
      this.backoff = BACKOFF_INITIAL;
      logger.info({ cameraId: this.cameraId, ip: this.ip, port: this.port }, 'VISCA camera connected');
      this.emit('connected');
      if (this.cameraType === 'vbot') {
        this.sendIfClear();
      }
    });
  }

  private sendIfClear(): void {
    if (!this.socket) return;
    this.socket.send(IF_CLEAR, 0, IF_CLEAR.length, this.port, this.ip, (err) => {
      if (err) logger.warn({ err, cameraId: this.cameraId }, 'IF_CLEAR send error');
      else logger.info({ cameraId: this.cameraId }, 'sent VISCA IF_CLEAR');
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

  close(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.socket) {
      try { this.socket.close(); } catch { /* ignore */ }
      this.socket = null;
    }
    this.connected = false;
  }
}
