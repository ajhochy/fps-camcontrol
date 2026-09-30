import dgram from 'dgram';
import { EventEmitter } from 'events';
import { logger } from '../index';

const BACKOFF_INITIAL = 1000;
const BACKOFF_MAX = 30000;

function parseNibbles4(b1: number, b2: number, b3: number, b4: number): number {
  return ((b1 & 0x0F) << 12) | ((b2 & 0x0F) << 8) | ((b3 & 0x0F) << 4) | (b4 & 0x0F);
}

function toSigned16(val: number): number {
  return val > 0x7FFF ? val - 0x10000 : val;
}

export class ViscaClient extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private ip: string;
  private port: number;
  private cameraId: string;
  private cameraType: string;
  private cameraAddress: number;
  private addressByte: number;
  label = '';
  private activityLog: import('../app/activityLog').ActivityLog | null = null;
  private backoff = BACKOFF_INITIAL;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private seqNum = 0;
  private pendingPanTilt: ((result: { pan: number; tilt: number }) => void) | null = null;
  private pendingZoom: ((result: { zoom: number }) => void) | null = null;
  private pendingProbe: ((reachable: boolean) => void) | null = null;
  connected = false;

  constructor(cameraId: string, ip: string, port: number, cameraType = 'generic', cameraAddress = 1) {
    super();
    this.cameraId = cameraId;
    this.ip = ip;
    this.port = port;
    this.cameraType = cameraType;
    this.cameraAddress = cameraAddress;
    this.addressByte = 0x80 | (cameraAddress & 0x07);
  }

  setActivityLog(log: import('../app/activityLog').ActivityLog, label: string): void {
    this.activityLog = log;
    this.label = label;
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
      this.handleMessage(msg);
      this.emit('message', msg);
    });

    sock.bind(0, () => {
      this.seqNum = 0;
      this.connected = true;
      this.backoff = BACKOFF_INITIAL;
      logger.info({ cameraId: this.cameraId, ip: this.ip, port: this.port }, 'VISCA camera connected');
      this.emit('connected');
    });
  }

  private handleMessage(msg: Buffer): void {
    if (msg.length < 10) return;
    const payload = msg.slice(8);
    // VISCA reply header: high nibble 0x9 indicates a reply from a camera.
    // Low nibble varies with the camera's address, so don't pin to 0x90.
    if ((payload[0] & 0xF0) !== 0x90 || payload[1] !== 0x50) return;

    // Check specific inquiry replies before the catch-all probe, so a PTZ inquiry
    // response can't be misinterpreted as a probe ack.
    if (payload.length >= 11 && payload[10] === 0xFF && this.pendingPanTilt) {
      const pan = parseNibbles4(payload[2], payload[3], payload[4], payload[5]);
      const tilt = toSigned16(parseNibbles4(payload[6], payload[7], payload[8], payload[9]));
      const cb = this.pendingPanTilt;
      this.pendingPanTilt = null;
      cb({ pan, tilt });
    } else if (payload.length >= 7 && payload[6] === 0xFF && this.pendingZoom) {
      const zoom = parseNibbles4(payload[2], payload[3], payload[4], payload[5]);
      const cb = this.pendingZoom;
      this.pendingZoom = null;
      cb({ zoom });
    } else if (this.pendingProbe) {
      const cb = this.pendingProbe;
      this.pendingProbe = null;
      cb(true);
    }
  }

  sendPayload(payload: number[]): void {
    // Override the address byte of the VISCA payload with this client's
    // configured camera address (default ID 1 → 0x81). Lets one codebase talk
    // to cameras with arbitrary VISCA IDs without changing the action callers.
    const addressed = payload.length > 0 ? [this.addressByte, ...payload.slice(1)] : payload;
    this.seqNum = (this.seqNum + 1) >>> 0;
    const lenHi = (addressed.length >> 8) & 0xFF;
    const lenLo = addressed.length & 0xFF;
    const seqB0 = (this.seqNum >> 24) & 0xFF;
    const seqB1 = (this.seqNum >> 16) & 0xFF;
    const seqB2 = (this.seqNum >> 8) & 0xFF;
    const seqB3 = this.seqNum & 0xFF;
    const packet = Buffer.from([0x01, 0x00, lenHi, lenLo, seqB0, seqB1, seqB2, seqB3, ...addressed]);
    if (this.activityLog) {
      const hex = addressed.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
      this.activityLog.addEntry({
        protocol: 'VISCA',
        message: hex,
        targetName: this.label || this.cameraId,
        targetIp: this.ip,
      });
    }
    this.send(packet);
  }

  queryPanTilt(): Promise<{ pan: number; tilt: number }> {
    return new Promise((resolve) => {
      this.pendingPanTilt = resolve;
      this.sendPayload([0x81, 0x09, 0x06, 0x12, 0xFF]);
    });
  }

  queryZoom(): Promise<{ zoom: number }> {
    return new Promise((resolve) => {
      this.pendingZoom = resolve;
      this.sendPayload([0x81, 0x09, 0x04, 0x47, 0xFF]);
    });
  }

  async probe(timeoutMs = 2000): Promise<boolean> {
    if (!this.connected) return false;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingProbe = null;
        resolve(false);
      }, timeoutMs);
      this.pendingProbe = (reachable) => {
        clearTimeout(timer);
        resolve(reachable);
      };
      // Tag the probe so it doesn't inherit whatever sticky controller context
      // happened to be set the last time the user moved a stick.
      this.activityLog?.setContext('Watchdog', '—', 'Health Probe');
      this.sendPayload([0x81, 0x09, 0x04, 0x00, 0xFF]);
    });
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

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX);
      logger.info({ cameraId: this.cameraId, backoff: this.backoff }, 'attempting VISCA reconnect');
      this.buildSocket();
    }, this.backoff);
  }
}
