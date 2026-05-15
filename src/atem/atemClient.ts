import { Atem } from 'atem-connection';
import { EventEmitter } from 'events';
import { logger } from '../index';

const BACKOFF_INITIAL = 1000;
const BACKOFF_MAX = 30000;

export class AtemClient extends EventEmitter {
  private atem: Atem;
  private ip: string;
  private backoff = BACKOFF_INITIAL;
  private reconnectTimer: NodeJS.Timeout | null = null;
  connected = false;

  constructor(ip: string) {
    super();
    this.ip = ip;
    this.atem = new Atem();

    this.atem.on('connected', () => {
      this.connected = true;
      this.backoff = BACKOFF_INITIAL;
      logger.info({ ip: this.ip }, 'ATEM connected');
      this.emit('connected');
    });

    this.atem.on('disconnected', () => {
      this.connected = false;
      logger.warn({ ip: this.ip }, 'ATEM disconnected, reconnecting');
      this.emit('disconnected');
      this.scheduleReconnect();
    });

    this.atem.on('error', (err: unknown) => {
      logger.error({ err, ip: this.ip }, 'ATEM error');
    });
  }

  async connect(): Promise<void> {
    logger.info({ ip: this.ip }, 'connecting to ATEM');
    this.atem.connect(this.ip);
    await this.waitForConnection();
  }

  private waitForConnection(timeoutMs = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.connected) { resolve(); return; }
      const timer = setTimeout(() => reject(new Error('ATEM connection timeout')), timeoutMs);
      this.once('connected', () => { clearTimeout(timer); resolve(); });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      logger.info({ ip: this.ip, backoff: this.backoff }, 'attempting ATEM reconnect');
      this.atem.connect(this.ip);
      this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX);
    }, this.backoff);
  }

  getProgramInput(meIndex = 0): number | undefined {
    return this.atem.state?.video?.mixEffects?.[meIndex]?.programInput;
  }

  getPreviewInput(meIndex = 0): number | undefined {
    return this.atem.state?.video?.mixEffects?.[meIndex]?.previewInput;
  }

  async changePreviewInput(inputId: number, meIndex = 0): Promise<void> {
    if (!this.connected) { logger.warn('ATEM not connected, dropping changePreviewInput'); return; }
    await this.atem.changePreviewInput(inputId, meIndex);
  }

  async cut(meIndex = 0): Promise<void> {
    if (!this.connected) { logger.warn('ATEM not connected, dropping cut'); return; }
    await this.atem.cut(meIndex);
  }

  async autoTransition(meIndex = 0): Promise<void> {
    if (!this.connected) { logger.warn('ATEM not connected, dropping autoTransition'); return; }
    await this.atem.autoTransition(meIndex);
  }

  async setDownstreamKeyOnAir(dskIndex: number, onAir: boolean): Promise<void> {
    if (!this.connected) { logger.warn('ATEM not connected, dropping setDownstreamKeyOnAir'); return; }
    await this.atem.setDownstreamKeyOnAir(onAir, dskIndex);
  }

  disconnect(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.atem.disconnect();
  }
}
