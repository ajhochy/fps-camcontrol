import { Atem } from 'atem-connection';
import { EventEmitter } from 'events';
import { logger } from '../index';
import { throttledLog } from '../app/logThrottle';

const BACKOFF_INITIAL = 1000;
const BACKOFF_MAX = 30000;
// Only trust the link as "stable" — and reset the backoff — after it has
// stayed connected this long. Without this, a connect→drop→connect flap keeps
// resetting the backoff to 1s and hammers the switcher hundreds of times a
// second. With it, an unstable link backs off all the way to BACKOFF_MAX.
const STABLE_RESET_MS = 15000;
// How often to confirm a wanted-but-absent connection still has a retry queued.
const CONNECTION_WATCHDOG_MS = 15000;

export interface AtemInput {
  id: number;
  longName: string;
  shortName: string;
}

export class AtemClient extends EventEmitter {
  private atem: Atem;
  private ip: string;
  private backoff = BACKOFF_INITIAL;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private connectionWatchdog: NodeJS.Timeout | null = null;
  // wantConnected: whether we intend to hold a connection (false after a
  // deliberate disconnect()). connecting: a connect() attempt is in flight —
  // the single-flight guard that stops overlapping reconnects from stacking.
  private wantConnected = false;
  private connecting = false;
  connected = false;
  private activityLog: import('../app/activityLog').ActivityLog | null = null;

  constructor(ip: string) {
    super();
    this.ip = ip;
    // The Electron utility process already provides isolation; no unowned Node
    // subprocess may outlive it when the desktop is force-quit.
    this.atem = new Atem({ disableMultithreaded: process.env.CAMCONTROL_EMBEDDED === '1' });

    this.atem.on('connected', () => {
      this.connecting = false;
      this.connected = true;
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      logger.info({ ip: this.ip }, 'ATEM connected');
      this.emit('connected');
      // Reset the backoff only once the link proves stable for a while.
      if (this.stableTimer) clearTimeout(this.stableTimer);
      this.stableTimer = setTimeout(() => {
        this.backoff = BACKOFF_INITIAL;
        this.stableTimer = null;
      }, STABLE_RESET_MS);
    });

    this.atem.on('disconnected', () => {
      const wasUp = this.connected;
      this.connected = false;
      this.connecting = false;
      if (this.stableTimer) { clearTimeout(this.stableTimer); this.stableTimer = null; }
      if (!this.wantConnected) return; // deliberate shutdown — do not reconnect
      if (wasUp) this.emit('disconnected');
      throttledLog.warn('atem-disconnected', 5000, { ip: this.ip, nextRetryMs: this.backoff }, 'ATEM disconnected, reconnecting');
      this.scheduleReconnect();
    });

    this.atem.on('error', (err: unknown) => {
      throttledLog.error('atem-error', 5000, { err, ip: this.ip }, 'ATEM error');
    });
  }

  setActivityLog(log: import('../app/activityLog').ActivityLog): void {
    this.activityLog = log;
  }

  async connect(): Promise<void> {
    this.wantConnected = true;
    this.connecting = true;
    this.startConnectionWatchdog();
    logger.info({ ip: this.ip }, 'connecting to ATEM');
    Promise.resolve(this.atem.connect(this.ip)).catch(err => {
      this.connecting = false;
      throttledLog.warn('atem-connect-fail', 5000, { err, ip: this.ip }, 'ATEM connect attempt failed, will retry');
      this.scheduleReconnect();
    });
    // The caller may give up waiting, but we must not: clear the in-flight flag
    // and queue a retry, or the client stays wedged with connecting=true (which
    // also makes scheduleReconnect() a no-op) and never reconnects. This is what
    // made "ATEM initial connection failed, will retry in background" a lie.
    await this.waitForConnection().catch(err => {
      this.connecting = false;
      this.scheduleReconnect();
      throw err;
    });
  }

  private waitForConnection(timeoutMs = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.connected) { resolve(); return; }
      const timer = setTimeout(() => reject(new Error('ATEM connection timeout')), timeoutMs);
      this.once('connected', () => { clearTimeout(timer); resolve(); });
    });
  }

  /**
   * Last-resort net: while we intend to be connected but aren't, and no attempt
   * is in flight or queued, queue one. Any future path that loses track of the
   * retry chain still recovers instead of leaving the switcher unreachable until
   * someone restarts the app mid-service.
   */
  private startConnectionWatchdog(): void {
    if (this.connectionWatchdog) return;
    this.connectionWatchdog = setInterval(() => {
      if (!this.wantConnected || this.connected) return;
      if (this.connecting || this.reconnectTimer) return;
      throttledLog.warn('atem-watchdog', 30000, { ip: this.ip }, 'ATEM still not connected — re-queuing a reconnect');
      this.scheduleReconnect();
    }, CONNECTION_WATCHDOG_MS);
    if (this.connectionWatchdog.unref) this.connectionWatchdog.unref();
  }

  private scheduleReconnect(): void {
    if (!this.wantConnected) return;
    // Single-flight: never stack a timer or overlap an in-flight attempt.
    if (this.reconnectTimer || this.connecting || this.connected) return;
    const delay = this.backoff;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.wantConnected || this.connecting || this.connected) return;
      this.connecting = true;
      // Grow the backoff for the *next* attempt; a stable connection resets it.
      this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX);
      throttledLog.info('atem-reconnect', 5000, { ip: this.ip, nextRetryMs: this.backoff }, 'attempting ATEM reconnect');
      Promise.resolve(this.atem.connect(this.ip)).catch(err => {
        this.connecting = false;
        throttledLog.warn('atem-reconnect-fail', 5000, { err, ip: this.ip, nextRetryMs: this.backoff }, 'ATEM reconnect failed, will retry');
        this.scheduleReconnect();
      });
    }, delay);
  }

  getProgramInput(meIndex = 0): number | undefined {
    return this.atem.state?.video?.mixEffects?.[meIndex]?.programInput;
  }

  getPreviewInput(meIndex = 0): number | undefined {
    return this.atem.state?.video?.mixEffects?.[meIndex]?.previewInput;
  }

  getAvailableInputs(): AtemInput[] {
    const inputs = (this.atem.state as any)?.settings?.inputs;
    if (!inputs) return [];
    return Object.entries(inputs).map(([id, info]: [string, any]) => ({
      id: Number(id),
      longName: info.longName ?? `Input ${id}`,
      shortName: info.shortName ?? String(id),
    }));
  }

  async changePreviewInput(inputId: number, meIndex = 0): Promise<void> {
    const disconnected = !this.connected;
    this.activityLog?.addEntry({
      protocol: 'ATEM',
      message: `changePreviewInput(inputId=${inputId}, me=${meIndex})${disconnected ? ' [DISCONNECTED]' : ''}`,
      targetName: 'ATEM Switcher',
      targetIp: this.ip,
    });
    if (disconnected) { logger.warn('ATEM not connected, dropping changePreviewInput'); return; }
    await this.atem.changePreviewInput(inputId, meIndex);
  }

  async cut(meIndex = 0): Promise<void> {
    const disconnected = !this.connected;
    this.activityLog?.addEntry({
      protocol: 'ATEM',
      message: `cut(me=${meIndex})${disconnected ? ' [DISCONNECTED]' : ''}`,
      targetName: 'ATEM Switcher',
      targetIp: this.ip,
    });
    if (disconnected) { logger.warn('ATEM not connected, dropping cut'); return; }
    await this.atem.cut(meIndex);
  }

  async autoTransition(meIndex = 0): Promise<void> {
    const disconnected = !this.connected;
    this.activityLog?.addEntry({
      protocol: 'ATEM',
      message: `autoTransition(me=${meIndex})${disconnected ? ' [DISCONNECTED]' : ''}`,
      targetName: 'ATEM Switcher',
      targetIp: this.ip,
    });
    if (disconnected) { logger.warn('ATEM not connected, dropping autoTransition'); return; }
    await this.atem.autoTransition(meIndex);
  }

  async setDownstreamKeyOnAir(dskIndex: number, onAir: boolean): Promise<void> {
    const disconnected = !this.connected;
    this.activityLog?.addEntry({
      protocol: 'ATEM',
      message: `setDownstreamKeyOnAir(dsk=${dskIndex}, onAir=${onAir})${disconnected ? ' [DISCONNECTED]' : ''}`,
      targetName: 'ATEM Switcher',
      targetIp: this.ip,
    });
    if (disconnected) { logger.warn('ATEM not connected, dropping setDownstreamKeyOnAir'); return; }
    await this.atem.setDownstreamKeyOnAir(onAir, dskIndex);
  }

  async setDownstreamKeyRate(dskIndex: number, rateFrames: number): Promise<void> {
    const disconnected = !this.connected;
    this.activityLog?.addEntry({
      protocol: 'ATEM',
      message: `setDownstreamKeyRate(dsk=${dskIndex}, rate=${rateFrames})${disconnected ? ' [DISCONNECTED]' : ''}`,
      targetName: 'ATEM Switcher',
      targetIp: this.ip,
    });
    if (disconnected) { logger.warn('ATEM not connected, dropping setDownstreamKeyRate'); return; }
    await this.atem.setDownstreamKeyRate(rateFrames, dskIndex);
  }

  // Fade the DSK toward on/off over its configured rate (the "Auto" DSK button),
  // rather than the instant on-air toggle.
  async autoDownstreamKey(dskIndex: number, isTowardsOnAir: boolean): Promise<void> {
    const disconnected = !this.connected;
    this.activityLog?.addEntry({
      protocol: 'ATEM',
      message: `autoDownstreamKey(dsk=${dskIndex}, onAir=${isTowardsOnAir})${disconnected ? ' [DISCONNECTED]' : ''}`,
      targetName: 'ATEM Switcher',
      targetIp: this.ip,
    });
    if (disconnected) { logger.warn('ATEM not connected, dropping autoDownstreamKey'); return; }
    await this.atem.autoDownstreamKey(dskIndex, isTowardsOnAir);
  }

  async setUpstreamKeyerOnAir(meIndex: number, keyIndex: number, onAir: boolean): Promise<void> {
    const disconnected = !this.connected;
    this.activityLog?.addEntry({
      protocol: 'ATEM',
      message: `setUpstreamKeyerOnAir(me=${meIndex}, key=${keyIndex}, onAir=${onAir})${disconnected ? ' [DISCONNECTED]' : ''}`,
      targetName: 'ATEM Switcher',
      targetIp: this.ip,
    });
    if (disconnected) { logger.warn('ATEM not connected, dropping setUpstreamKeyerOnAir'); return; }
    await (this.atem as any).setUpstreamKeyerOnAir(meIndex, keyIndex, onAir);
  }

  disconnect(): void {
    this.wantConnected = false;
    this.connecting = false;
    if (this.connectionWatchdog) { clearInterval(this.connectionWatchdog); this.connectionWatchdog = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.stableTimer) { clearTimeout(this.stableTimer); this.stableTimer = null; }
    this.atem.disconnect();
  }
}
