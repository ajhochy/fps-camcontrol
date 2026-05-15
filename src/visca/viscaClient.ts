import dgram from 'dgram';
import { EventEmitter } from 'events';
import { logger } from '../index';

const BACKOFF_INITIAL = 1000;
const BACKOFF_MAX = 30000;

function viscaIpInquiryPacket(payload: number[]): Buffer {
  // Use inquiry type header (0x01, 0x10) for queries
  const header = [0x01, 0x10, 0x00, payload.length, 0x00, 0x00, 0x00, 0x01];
  return Buffer.from([...header, ...payload]);
}

export class ViscaClient extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private ip: string;
  private port: number;
  private cameraId: string;
  private backoff = BACKOFF_INITIAL;
  private reconnectTimer: NodeJS.Timeout | null = null;
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

  // Send an inquiry and wait for an inquiry response (byte 9 = 0x50 in VISCA-over-IP).
  async query(bytes: Buffer, timeoutMs = 2000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('message', handler);
        reject(new Error(`VISCA inquiry timeout (camera ${this.cameraId})`));
      }, timeoutMs);

      const handler = (msg: Buffer) => {
        // Inquiry response: byte 8 = camera address (0x90), byte 9 = 0x50
        if (msg.length > 9 && msg[9] === 0x50) {
          clearTimeout(timer);
          this.off('message', handler);
          resolve(msg);
        }
      };

      this.on('message', handler);
      this.send(bytes);
    });
  }

  async queryPanTilt(timeoutMs = 2000): Promise<{ pan: number; tilt: number }> {
    const payload = [0x81, 0x09, 0x06, 0x12, 0xFF];
    const response = await this.query(viscaIpInquiryPacket(payload), timeoutMs);
    // Response payload (after 8-byte header): y0 50 pp pp pp pp tt tt tt tt FF
    const d = Array.from(response).slice(8);
    let pan = ((d[2] & 0xF) << 12) | ((d[3] & 0xF) << 8) | ((d[4] & 0xF) << 4) | (d[5] & 0xF);
    let tilt = ((d[6] & 0xF) << 12) | ((d[7] & 0xF) << 8) | ((d[8] & 0xF) << 4) | (d[9] & 0xF);
    // VISCA positions are 16-bit signed
    if (pan > 0x7FFF) pan -= 0x10000;
    if (tilt > 0x7FFF) tilt -= 0x10000;
    return { pan, tilt };
  }

  async queryZoom(timeoutMs = 2000): Promise<number> {
    const payload = [0x81, 0x09, 0x04, 0x47, 0xFF];
    const response = await this.query(viscaIpInquiryPacket(payload), timeoutMs);
    // Response payload (after 8-byte header): y0 50 zz zz zz zz FF
    const d = Array.from(response).slice(8);
    return ((d[2] & 0xF) << 12) | ((d[3] & 0xF) << 8) | ((d[4] & 0xF) << 4) | (d[5] & 0xF);
  }

  // Sends a camera power inquiry and checks for any response within timeoutMs.
  // Returns true if the camera responds, false if it times out.
  async probe(timeoutMs = 2000): Promise<boolean> {
    try {
      const payload = [0x81, 0x09, 0x04, 0x00, 0xFF];
      await this.query(viscaIpInquiryPacket(payload), timeoutMs);
      return true;
    } catch {
      return false;
    }
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
