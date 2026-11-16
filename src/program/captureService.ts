import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyCaptureLine, CaptureHealth, CaptureHelperOptions, CaptureLine, CaptureLineParser, captureHelperArgs, defaultHelperPath, initialHealth, isStale } from '../broadcast/decklinkCapture';

/**
 * The always-on program capture (issue #95, docs/ai/decisions/2026-10-13-streaming-session-architecture.md addendum).
 * One helper process (`camcontrol-capture --serve`) is the ONLY opener of the capture card for the whole app run, and
 * every consumer — the monitor encoder for previews/TVs, each recording/streaming session's encoder — attaches to it
 * through its own FIFO. The helper keeps a bounded queue per consumer, so a slow or dead consumer is dropped there and
 * never stalls capture or the others. Media bytes never pass through Node: Node only creates the FIFOs, starts the
 * consumer processes (which open them for reading), and tells the helper to attach.
 *
 * Restarts: the helper is restarted with backoff on any exit (1 s → 30 s; at once after a format change). Consumers
 * marked `restart: 'auto'` (previews) are re-attached after a helper restart or their own exit; consumers marked
 * `restart: 'never'` (output sessions, #70) end with a reason instead, so returning hardware never restarts sending.
 */
export type ConsumerRestart = 'auto' | 'never';
export interface ConsumerSpec {
  /** [A-Za-z0-9_-]{1,32}; unique per service. */
  id: string;
  restart: ConsumerRestart;
  /** Start the consumer process; it must open `inputPath` for reading (e.g. `ffmpeg -f matroska -i inputPath ...`). */
  spawn: (inputPath: string) => ChildProcess;
}
export type ConsumerEndReason = 'removed' | 'capture-lost' | 'format-changed' | 'stalled' | 'consumer-exited' | 'attach-failed' | 'service-stopped';
export interface ConsumerStatus {
  id: string; restart: ConsumerRestart; state: 'starting' | 'attached' | 'ended'; reason?: ConsumerEndReason; detail?: string; attaches: number;
  framesOut: number; droppedBackpressure: number; droppedUnits: number; queueDepth: number; maxBlockMs: number;
}
/** What is wrong, separately: the signal on the wire, the device, and the helper process (#70). */
export type SignalState = 'locked' | 'absent' | 'unknown';
export type DeviceState = 'ok' | 'disconnected' | 'busy' | 'missing' | 'unknown';
export type ProcessState = 'stopped' | 'starting' | 'running' | 'restarting' | 'failed';
export interface CaptureServiceStatus {
  enabled: boolean; process: ProcessState; signal: SignalState; device: DeviceState;
  mode?: string; width?: number; height?: number; fps: number; fpsNominal?: number; audioPresent: boolean; fillerFrames: number;
  restarts: number; consumersLost: number; lastExit?: { code: number | null; signal: string | null; reason: string; at: number };
  error?: { code: string; message: string }; nextRestartInMs?: number; consumers: ConsumerStatus[];
}
export interface CaptureServiceOptions {
  helper?: string;
  helperOptions?: CaptureHelperOptions;
  /** Per-consumer stall timeout inside the helper (ms). */
  stallMs?: number;
  /** Directory for the FIFOs (private, created and removed by the service). */
  fifoDir?: string;
  backoffMinMs?: number; backoffMaxMs?: number; stableResetMs?: number; staleMs?: number;
  /** Kill a helper that has printed no status line this long after starting (default 15 s). */
  startupMs?: number;
  /** End a consumer the helper has not attached this long after asking (default 8 s). */
  attachTimeoutMs?: number;
  /** Test seam: start the helper process. */
  spawnHelper?: (binary: string, args: string[]) => ChildProcess;
  log?: (level: 'info' | 'warn', msg: string, extra?: Record<string, unknown>) => void;
}
type HelperConsumerStats = { id: string; frames_out: number; dropped_backpressure: number; dropped_units: number; queue_depth: number; max_block_ms: number };
interface Consumer {
  spec: ConsumerSpec; status: ConsumerStatus; proc?: ChildProcess; fifo?: string; wanted: boolean; generation: number; retry?: NodeJS.Timeout;
  /** Already counted as lost for this attachment (its process exit is then expected, not a second loss). */
  lost: boolean;
  /** The helper restarted under this auto consumer: its process exit is expected and it re-attaches at once. */
  awaitingRestart: boolean;
  /** Deciding why its process exited (see onConsumerExit). */
  settle?: NodeJS.Timeout;
  /** No 'consumer-attached' reply in time: the helper never opened the FIFO, so the reader would wait forever. */
  attachTimer?: NodeJS.Timeout;
}

const ID = /^[A-Za-z0-9_-]{1,32}$/;
const EXIT_REASON: Record<number, string> = { 0: 'clean', 2: 'usage', 3: 'no-device', 4: 'device-busy', 5: 'format-changed', 6: 'write-failed' };

export class CaptureService extends EventEmitter {
  private helper?: ChildProcess;
  private health: CaptureHealth = initialHealth();
  private consumers = new Map<string, Consumer>();
  private running = false;
  private processState: ProcessState = 'stopped';
  private restarts = 0; private backoff: number; private restartTimer?: NodeJS.Timeout; private restartAt?: number;
  private startedAt = 0; private staleTimer?: NodeJS.Timeout; private consumersLost = 0;
  private lastExit?: CaptureServiceStatus['lastExit'];
  private device: DeviceState = 'unknown';
  private fifoDir?: string; private ownsFifoDir = false;
  private generation = 0;
  private stopping?: Promise<void>;
  /** Bumped by every explicit stop()/restart(): a restart that an explicit stop overtook does not start again. */
  private lifecycle = 0;

  constructor(private options: CaptureServiceOptions = {}) {
    super();
    this.backoff = options.backoffMinMs ?? 1000;
  }

  get enabled(): boolean { return this.running; }

  start(): void {
    if (this.running) return;
    this.running = true; this.stopping = undefined;
    if (this.options.fifoDir) { fs.mkdirSync(this.options.fifoDir, { recursive: true, mode: 0o700 }); this.fifoDir = this.options.fifoDir; }
    else { this.fifoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camcontrol-capture-')); this.ownsFifoDir = true; }
    fs.chmodSync(this.fifoDir, 0o700);
    this.staleTimer = setInterval(() => this.checkStale(), 1000);
    this.spawnHelper();
  }

  /** Stop (consumers end), take new options, start again. */
  async restart(options: Partial<CaptureServiceOptions> = {}): Promise<void> {
    const epoch = ++this.lifecycle;
    await this.shutdown();
    if (epoch !== this.lifecycle) return;
    this.options = { ...this.options, ...options };
    this.backoff = this.options.backoffMinMs ?? 1000;
    this.start();
  }

  /** Register a consumer; it attaches as soon as the helper is up (immediately when it already is). */
  addConsumer(spec: ConsumerSpec): ConsumerStatus {
    if (!ID.test(spec.id)) throw new Error('consumer id must be 1-32 of A-Z a-z 0-9 _ -');
    const existing = this.consumers.get(spec.id);
    if (existing && existing.wanted) throw new Error(`consumer ${spec.id} is already attached`);
    if (existing?.proc) throw new Error(`consumer ${spec.id} is still shutting down`);
    const c: Consumer = { spec, wanted: true, generation: 0, lost: false, awaitingRestart: false, status: { id: spec.id, restart: spec.restart, state: 'starting', attaches: 0, framesOut: 0, droppedBackpressure: 0, droppedUnits: 0, queueDepth: 0, maxBlockMs: 0 } };
    this.consumers.set(spec.id, c);
    if (this.helperUp()) this.attach(c);
    this.changed();
    return { ...c.status };
  }

  /** Detach and wait for the consumer process to finish (it sees end of stream and finalizes its output). */
  async removeConsumer(id: string, graceMs = 5000): Promise<void> {
    const c = this.consumers.get(id); if (!c) return;
    c.wanted = false; clearTimeout(c.retry);
    if (c.status.state !== 'ended') this.end(c, 'removed');
    if (this.helperUp()) this.command(`detach ${id}`);
    await this.waitConsumer(c, graceMs);
    if (this.consumers.get(id) === c) this.consumers.delete(id);
    this.changed();
  }

  consumer(id: string): ConsumerStatus | undefined { const c = this.consumers.get(id); return c ? { ...c.status } : undefined; }

  status(): CaptureServiceStatus {
    const h = this.health;
    const signal: SignalState = this.processState !== 'running' || h.state === 'starting' ? 'unknown' : h.state === 'running' && h.signalLocked ? 'locked' : h.state === 'signal-lost' || h.state === 'waiting-signal' ? 'absent' : 'unknown';
    const device: DeviceState = this.processState === 'running' && h.deviceOk === false ? 'disconnected' : this.device;
    return {
      enabled: this.running, process: this.processState, signal, device,
      mode: h.mode, width: h.width, height: h.height, fps: h.fps, fpsNominal: h.fpsNominal, audioPresent: h.audioPresent, fillerFrames: h.fillerFrames,
      restarts: this.restarts, consumersLost: this.consumersLost, lastExit: this.lastExit,
      error: h.error ? { code: h.error.code, message: h.error.message } : undefined,
      nextRestartInMs: this.restartAt ? Math.max(0, this.restartAt - Date.now()) : undefined,
      consumers: [...this.consumers.values()].map(c => ({ ...c.status })),
    };
  }

  /** End every consumer (outputs finalize), then close the helper's control channel; SIGTERM/SIGKILL if it lingers. */
  stop(graceMs = 5000): Promise<void> { this.lifecycle++; return this.shutdown(graceMs); }

  private shutdown(graceMs = 5000): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      this.running = false;
      clearTimeout(this.restartTimer); this.restartTimer = undefined; this.restartAt = undefined;
      clearInterval(this.staleTimer);
      const all = [...this.consumers.values()];
      for (const c of all) { c.wanted = false; clearTimeout(c.retry); clearTimeout(c.settle); clearTimeout(c.attachTimer); if (c.status.state !== 'ended') this.end(c, 'service-stopped'); }
      const helper = this.helper;
      if (helper && helper.exitCode === null && helper.signalCode === null) {
        const gone = new Promise<void>(resolve => helper.once('close', () => resolve()));
        helper.stdin?.end();
        const term = setTimeout(() => helper.kill('SIGTERM'), graceMs);
        const kill = setTimeout(() => helper.kill('SIGKILL'), graceMs * 2);
        await gone; clearTimeout(term); clearTimeout(kill);
      }
      await Promise.all(all.map(c => this.waitConsumer(c, graceMs)));
      this.consumers.clear();
      this.processState = 'stopped';
      if (this.ownsFifoDir && this.fifoDir) fs.rmSync(this.fifoDir, { recursive: true, force: true });
      this.changed();
    })();
    return this.stopping;
  }

  // ---- helper lifecycle

  private helperUp(): boolean { return !!this.helper && this.processState === 'running' && this.helper.exitCode === null; }

  private spawnHelper(): void {
    const o = this.options;
    const binary = o.helper ?? defaultHelperPath();
    const args = ['--serve', ...captureHelperArgs(o.helperOptions), ...(o.stallMs !== undefined ? ['--stall-ms', String(o.stallMs)] : [])];
    this.health = initialHealth(); this.processState = 'starting'; this.restartAt = undefined;
    const gen = ++this.generation;
    let child: ChildProcess;
    try {
      child = o.spawnHelper ? o.spawnHelper(binary, args) : spawn('/usr/bin/nice', ['-n', '5', binary, ...args], { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (error) { this.onHelperExit(gen, -1, null, `spawn failed: ${String(error)}`); return; }
    this.helper = child; this.startedAt = Date.now();
    child.stdin?.on('error', () => { /* helper gone; 'close' handles it */ });
    const parser = new CaptureLineParser();
    child.stderr?.on('data', (chunk: Buffer) => { for (const line of parser.push(chunk)) if (gen === this.generation) this.onLine(line); });
    child.once('error', err => this.onHelperExit(gen, -1, null, `spawn failed: ${err.message}`));
    child.once('close', (code, signal) => this.onHelperExit(gen, code, signal));
    this.processState = 'running';
    for (const c of this.consumers.values()) if (c.wanted && c.status.state !== 'ended') this.attach(c);
    this.changed();
  }

  private onLine(line: CaptureLine): void {
    this.health = applyCaptureLine(this.health, line);
    if (line.type === 'status') {
      this.device = line.device_ok === false ? 'disconnected' : 'ok';
      if (Date.now() - this.startedAt > (this.options.stableResetMs ?? 60_000)) this.backoff = this.options.backoffMinMs ?? 1000;
      const stats = (line as { consumers?: HelperConsumerStats[] }).consumers;
      if (Array.isArray(stats)) for (const s of stats) {
        const c = this.consumers.get(s.id); if (!c) continue;
        Object.assign(c.status, { framesOut: s.frames_out, droppedBackpressure: s.dropped_backpressure, droppedUnits: s.dropped_units, queueDepth: s.queue_depth, maxBlockMs: s.max_block_ms });
      }
    } else if (line.type === 'event') {
      const id = typeof line.id === 'string' ? line.id : undefined;
      const c = id ? this.consumers.get(id) : undefined;
      if (line.event === 'consumer-attached' && c && c.wanted && c.status.state !== 'ended') { clearTimeout(c.attachTimer); c.status.state = 'attached'; c.status.attaches++; }
      if (line.event === 'consumer-attach-failed' && c) this.lose(c, 'attach-failed', String(line.reason ?? ''));
      if (line.event === 'consumer-detached' && c && c.status.state !== 'ended') {
        const why = String(line.reason ?? '');
        if (why === 'stalled') this.lose(c, 'stalled', 'the consumer stopped reading and was dropped');
        else if (why !== 'detached' && why !== 'stopped') this.lose(c, 'consumer-exited', why);
      }
    } else if (line.type === 'error') {
      if (line.code === 'device-busy') this.device = 'busy';
      else if (line.code === 'no-device' || line.code === 'no-driver') this.device = 'missing';
    }
    this.changed();
  }

  private onHelperExit(gen: number, code: number | null, signal: string | null, detail?: string): void {
    if (gen !== this.generation || this.helper === undefined && this.processState !== 'starting') return;
    this.helper = undefined;
    const reason = detail ?? (code !== null ? EXIT_REASON[code] ?? `exit ${code}` : `signal ${signal}`);
    this.lastExit = { code, signal, reason, at: Date.now() };
    if (code === 3) this.device = 'missing'; else if (code === 4) this.device = 'busy';
    if (!this.running) { this.processState = 'stopped'; this.changed(); return; }
    const formatChange = code === 5;
    // Sessions never survive a capture restart (#70); previews come back when the helper does.
    for (const c of this.consumers.values()) {
      clearTimeout(c.settle); c.settle = undefined; clearTimeout(c.attachTimer);
      // A reader still waiting in open() for a writer will never get one from the dead helper: end it.
      if (c.status.state !== 'attached') this.killProc(c.proc);
      if (!c.wanted || c.status.state === 'ended') continue;
      if (c.spec.restart === 'never') { this.end(c, formatChange ? 'format-changed' : 'capture-lost', reason); c.wanted = false; }
      else { c.status.state = 'starting'; c.awaitingRestart = true; }
    }
    this.restarts++;
    this.processState = 'restarting';
    const delay = formatChange ? 0 : this.backoff;
    if (!formatChange) this.backoff = Math.min(this.backoff * 2, this.options.backoffMaxMs ?? 30_000);
    this.log('warn', 'program capture helper exited; restarting', { code, signal, reason, delayMs: delay });
    this.restartAt = Date.now() + delay;
    this.restartTimer = setTimeout(() => { this.restartTimer = undefined; if (this.running) this.spawnHelper(); }, delay);
    this.changed();
  }

  private checkStale(): void {
    // No status line yet (wedged opening the device) counts too, measured from the spawn.
    const silentSinceStart = this.health.lastStatusAt === undefined && Date.now() - this.startedAt > (this.options.startupMs ?? 15_000);
    if (this.helper && this.processState === 'running' && (silentSinceStart || isStale(this.health, Date.now(), this.options.staleMs ?? 5000))) {
      this.log('warn', 'program capture helper stopped reporting; killing it');
      this.health = { ...this.health, lastStatusAt: undefined };
      this.startedAt = Date.now();
      this.helper.kill('SIGKILL');
    }
  }

  private command(text: string): void { try { this.helper?.stdin?.write(text + '\n'); } catch { /* helper gone */ } }

  // ---- consumers

  private attach(c: Consumer): void {
    if (c.proc) return;   // still running from the last attach; its exit re-attaches
    const gen = ++c.generation;
    const fifo = path.join(this.fifoDir!, `${c.spec.id}-${gen}.mkv`);
    fs.rmSync(fifo, { force: true });
    const made = spawnSync('/usr/bin/mkfifo', ['-m', '600', fifo]);
    if (made.status !== 0) { this.lose(c, 'attach-failed', 'could not create the consumer pipe'); return; }
    c.lost = false; c.awaitingRestart = false;
    let proc: ChildProcess;
    try { proc = c.spec.spawn(fifo); } catch (error) { fs.rmSync(fifo, { force: true }); this.lose(c, 'attach-failed', String(error)); return; }
    c.proc = proc; c.fifo = fifo; c.status.state = 'starting';
    proc.once('error', () => { /* 'close' follows */ });
    proc.once('close', (code, signal) => this.onConsumerExit(c, proc, code, signal));
    this.command(`attach ${c.spec.id} ${fifo}`);
    clearTimeout(c.attachTimer);
    c.attachTimer = setTimeout(() => { if (c.proc === proc && c.status.state === 'starting') this.lose(c, 'attach-failed', 'the capture did not attach this consumer in time'); }, this.options.attachTimeoutMs ?? 8000);
  }

  private onConsumerExit(c: Consumer, proc: ChildProcess, code: number | null, signal: string | null): void {
    if (c.proc !== proc) return;
    c.proc = undefined;
    if (c.fifo) { fs.rmSync(c.fifo, { force: true }); c.fifo = undefined; }
    this.emit('consumer-exit', c.spec.id, code, signal);
    const settle = (): void => {
      c.settle = undefined;
      const expected = c.lost || c.awaitingRestart;
      if (c.wanted && c.status.state !== 'ended' && !expected) {
        if (this.helperUp()) this.command(`detach ${c.spec.id}`);   // in case the helper has not noticed yet
        this.lose(c, 'consumer-exited', code !== null ? `exit ${code}` : `signal ${signal}`);
      }
      if (c.wanted && c.spec.restart === 'auto' && this.helperUp()) {
        clearTimeout(c.retry);
        const delay = c.awaitingRestart ? 0 : 1000;
        c.retry = setTimeout(() => { if (c.wanted && this.helperUp()) { c.status.state = 'starting'; this.attach(c); this.changed(); } }, delay);
      }
      this.changed();
    };
    // When the helper dies, its consumers see end of stream and often exit before the helper's own exit is seen:
    // wait briefly so that case is reported as capture-lost / format-changed, not as the consumer's fault.
    if (c.lost || c.awaitingRestart || !c.wanted) settle(); else c.settle = setTimeout(settle, 300);
  }

  /** A consumer stopped receiving: auto consumers retry, never consumers end for good. */
  private lose(c: Consumer, reason: ConsumerEndReason, detail?: string): void {
    if (c.lost) return;
    c.lost = true; this.consumersLost++;
    if (c.spec.restart === 'never') { this.end(c, reason, detail); c.wanted = false; }
    else { c.status.state = 'starting'; c.status.reason = reason; c.status.detail = detail; }
    // A wedged reader, or one still blocked opening a pipe nobody will write, will not exit on its own.
    if (reason === 'stalled' || reason === 'attach-failed') this.killProc(c.proc);
    // Nothing running to exit and trigger the retry (mkfifo/spawn failed): retry from here.
    if (!c.proc && c.wanted && c.spec.restart === 'auto') {
      clearTimeout(c.retry);
      c.retry = setTimeout(() => { if (c.wanted && this.helperUp() && !c.proc) { c.status.state = 'starting'; this.attach(c); this.changed(); } }, 1000);
    }
    this.log('warn', 'program capture consumer lost', { id: c.spec.id, reason, detail });
  }
  private killProc(proc: ChildProcess | undefined): void {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    proc.kill('SIGTERM');
    setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); }, 3000).unref();
  }
  private end(c: Consumer, reason: ConsumerEndReason, detail?: string): void {
    c.status.state = 'ended'; c.status.reason = reason; c.status.detail = detail;
    this.emit('consumer-ended', c.spec.id, reason, detail);
  }
  private async waitConsumer(c: Consumer, graceMs: number): Promise<void> {
    const proc = c.proc; if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    const gone = new Promise<void>(resolve => proc.once('close', () => resolve()));
    const term = setTimeout(() => proc.kill('SIGTERM'), graceMs);
    const kill = setTimeout(() => proc.kill('SIGKILL'), graceMs + 3000);
    await gone; clearTimeout(term); clearTimeout(kill);
  }

  private changed(): void { this.emit('status', this.status()); }
  private log(level: 'info' | 'warn', msg: string, extra?: Record<string, unknown>): void { this.options.log?.(level, msg, extra); }
}
