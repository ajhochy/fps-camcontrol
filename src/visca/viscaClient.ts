import dgram from 'dgram';
import { EventEmitter } from 'events';
import { logger } from '../index';

const BACKOFF_INITIAL = 1000;
const BACKOFF_MAX = 30000;

/**
 * One UDP socket shared by every VISCA camera, bound to the standard VISCA port (52381) when it is free.
 *
 * Some cameras (the V-BOT among them) send every reply to port 52381 on the asking machine, whatever port the
 * question came from. With a socket per camera on a random port those replies never arrived, so the app could
 * not tell a working camera from a dead one, and position inquiries (preset save) never got an answer. Cameras
 * that reply to the asking port work either way. Replies are routed to the camera they came from (ip:port).
 *
 * The bind is exclusive, so a second copy of the app (the sandbox, a test) can never steal the live app's
 * replies: it falls back to a random port and says so. VISCA_LOCAL_PORT overrides the port (0 = random).
 */
type ViscaRoute = (msg: Buffer) => void;
class ViscaTransport {
  private socket: dgram.Socket | null = null;
  private ready = false;
  private routes = new Map<string, ViscaRoute>();
  private waiting: (() => void)[] = [];
  /** The local port replies arrive on; null until bound. */
  localPort: number | null = null;
  /** True when bound to the standard port, so cameras that reply to 52381 are heard. */
  onStandardPort = false;

  register(key: string, route: ViscaRoute, onReady: () => void): void {
    this.routes.set(key, route);
    if (this.ready) { onReady(); return; }
    this.waiting.push(onReady);
    if (!this.socket) this.open();
  }

  unregister(key: string): void {
    this.routes.delete(key);
    if (this.routes.size === 0 && this.socket) {
      try { this.socket.close(); } catch { /* ignore */ }
      this.socket = null; this.ready = false; this.localPort = null; this.onStandardPort = false;
    }
  }

  get isReady(): boolean { return this.ready; }

  send(bytes: Buffer, port: number, ip: string, done: (err: Error | null) => void): void {
    if (!this.socket || !this.ready) { done(new Error('VISCA transport not ready')); return; }
    this.socket.send(bytes, 0, bytes.length, port, ip, (err) => done(err ?? null));
  }

  private open(): void {
    const wanted = process.env.VISCA_LOCAL_PORT !== undefined ? Number(process.env.VISCA_LOCAL_PORT) : 52381;
    const bindOn = (port: number, fallback: boolean): void => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      this.socket = sock;
      sock.once('error', (err: NodeJS.ErrnoException) => {
        if (this.ready) return;
        try { sock.close(); } catch { /* ignore */ }
        if (!fallback && port !== 0) {
          logger.warn({ port, err: err.code ?? String(err) }, 'VISCA port in use — using a random port; cameras that reply only to port 52381 (e.g. V-BOT) will not be heard');
          bindOn(0, true);
        } else {
          logger.error({ err }, 'VISCA socket could not be opened');
          this.socket = null;
        }
      });
      sock.on('message', (msg, rinfo) => {
        const route = this.routes.get(`${rinfo.address}:${rinfo.port}`)
          ?? [...this.routes.entries()].filter(([key]) => key.startsWith(`${rinfo.address}:`)).map(([, r]) => r).find((_, __, all) => all.length === 1);
        if (route) route(msg);
      });
      sock.bind(port, () => {
        this.ready = true;
        this.localPort = sock.address().port;
        this.onStandardPort = this.localPort === 52381;
        sock.on('error', (err) => logger.warn({ err }, 'VISCA socket error'));
        logger.info({ localPort: this.localPort }, 'VISCA listening for camera replies');
        const waiting = this.waiting; this.waiting = [];
        for (const cb of waiting) cb();
      });
    };
    bindOn(Number.isFinite(wanted) ? wanted : 52381, false);
  }
}
const transport = new ViscaTransport();
/** Where VISCA replies are heard (for status): the local port and whether it is the standard one. */
export function viscaTransportInfo(): { localPort: number | null; onStandardPort: boolean } {
  return { localPort: transport.localPort, onStandardPort: transport.onStandardPort };
}

function parseNibbles4(b1: number, b2: number, b3: number, b4: number): number {
  return ((b1 & 0x0F) << 12) | ((b2 & 0x0F) << 8) | ((b3 & 0x0F) << 4) | (b4 & 0x0F);
}

function toSigned16(val: number): number {
  return val > 0x7FFF ? val - 0x10000 : val;
}

export class ViscaClient extends EventEmitter {
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
  private registered = false;
  connected = false;
  /** When this camera last sent any VISCA reply (ack, completion, error or inquiry answer); null if never. */
  lastReplyAt: number | null = null;

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
    if (this.registered) return;
    this.registered = true;
    transport.register(`${this.ip}:${this.port}`, (msg) => {
      this.handleMessage(msg);
      this.emit('message', msg);
    }, () => {
      if (!this.registered) return;
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
    if ((payload[0] & 0xF0) !== 0x90) return;
    // Any reply (ack 0x4y, completion 0x5y, error 0x6y) proves the camera is alive and answering.
    this.lastReplyAt = Date.now();
    if (payload[1] !== 0x50) return;

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

  /**
   * Is the camera answering? Any reply counts. Asks the power status first and, for cameras that do not answer
   * that one (the V-BOT), the pan/tilt position. Inquiries only read; nothing moves.
   */
  async probe(timeoutMs = 2000): Promise<boolean> {
    if (!this.connected) return false;
    const askedAt = Date.now();
    const answered = (ms: number) => new Promise<boolean>((resolve) => {
      const until = Date.now() + ms;
      const tick = () => {
        if (this.lastReplyAt !== null && this.lastReplyAt >= askedAt) { resolve(true); return; }
        if (Date.now() >= until) { resolve(false); return; }
        setTimeout(tick, 50);
      };
      tick();
    });
    // Tag the probe so it doesn't inherit whatever sticky controller context
    // happened to be set the last time the user moved a stick.
    this.activityLog?.setContext('Watchdog', '—', 'Health Probe');
    this.sendPayload([0x81, 0x09, 0x04, 0x00, 0xFF]);
    if (await answered(timeoutMs / 2)) return true;
    this.activityLog?.setContext('Watchdog', '—', 'Health Probe');
    this.sendPayload([0x81, 0x09, 0x06, 0x12, 0xFF]);
    return answered(timeoutMs / 2);
  }

  send(bytes: Buffer): void {
    if (!this.connected) {
      logger.warn({ cameraId: this.cameraId }, 'VISCA not connected, dropping command');
      return;
    }
    transport.send(bytes, this.port, this.ip, (err) => {
      if (err) logger.warn({ err, cameraId: this.cameraId }, 'VISCA send error');
    });
  }

  close(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.registered) { this.registered = false; transport.unregister(`${this.ip}:${this.port}`); }
    this.connected = false;
  }
}
