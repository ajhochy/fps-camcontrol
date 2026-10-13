import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getResourcePath } from '../config/paths';

const MODEL_SHA256 = 'c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063';
export interface SidecarProcessOptions {
  enabled: boolean;
  paused?: boolean;
  backendOrigin: string;
  frameToken: string;
  resourcesRoot?: string;
  /** Explicit mock mode is reserved for isolated tests; production uses live. */
  source?: 'live' | 'mock';
  /** Explicit fixtures only; never populate these from operator config or env. */
  pythonPath?: string;
  scriptPath?: string;
  modelPath?: string;
  startupTimeoutMs?: number;
  reacquireMs?: number;
  lostHoldMs?: number;
}
export interface SidecarConnection { url: string; token: string }

/** Own one helper. No inherited user Python environment, secret argv, or restart. */
export class SidecarProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending: Promise<SidecarConnection> | null = null;
  private connection: SidecarConnection | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private stopping: Promise<void> | null = null;
  private rejectStartup: ((error: Error) => void) | null = null;

  constructor(private readonly options: SidecarProcessOptions) { super(); }

  start(): Promise<SidecarConnection> {
    if (!this.options.enabled || this.options.paused) return Promise.reject(new Error('Tracking helper is disabled or paused.'));
    if (this.stopping) return Promise.reject(new Error('Tracking helper is stopping.'));
    if (this.connection) return Promise.resolve(this.connection);
    if (this.pending) return this.pending;
    this.pending = this.launch().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async launch(): Promise<SidecarConnection> {
    const origin = new URL(this.options.backendOrigin);
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
      throw new Error('Tracking helper requires the private local backend origin.');
    }
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(this.options.frameToken)) throw new Error('Tracking helper frame credential is unavailable.');
    const reacquireMs = this.options.reacquireMs ?? 1000, lostHoldMs = this.options.lostHoldMs ?? 3000;
    if (!Number.isInteger(reacquireMs) || reacquireMs < 100 || reacquireMs > 5000 || !Number.isInteger(lostHoldMs) || lostHoldMs < 0 || lostHoldMs > 30000) throw new Error('Invalid tracking helper timing settings.');
    const resources = this.options.resourcesRoot || path.resolve(getResourcePath('..'));
    const python = this.options.pythonPath || path.join(resources, 'python/bin/python3');
    const script = this.options.scriptPath || path.join(resources, 'tracker-sidecar/main.py');
    const model = this.options.modelPath || path.join(resources, 'models/object_detection_yolox_2022nov.onnx');
    try {
      if (![python, script, model].every(file => path.isAbsolute(file) && fs.statSync(file).isFile())) throw new Error('missing');
      if (createHash('sha256').update(fs.readFileSync(model)).digest('hex') !== MODEL_SHA256) throw new Error('checksum');
    } catch { throw new Error('Tracking runtime or verified model is unavailable.'); }
    const token = randomBytes(32).toString('base64url');
    const child = spawn(python, ['-I', '-B', script, '--source', this.options.source || 'live', '--port', '0', '--model', model,
      '--reacquire-ms', String(reacquireMs), '--lost-hold-ms', String(lostHoldMs)], {
      cwd: path.dirname(script), stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
        TRACKER_WS_TOKEN: token, TRACKER_FRAME_TOKEN: this.options.frameToken, TRACKER_BACKEND_ORIGIN: origin.origin },
    });
    this.child = child;
    child.stdin.on('error', () => {});
    let exited = false;
    child.once('exit', () => {
      exited = true;
      if (this.child === child) {
        this.child = null;
        this.connection = null;
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = null;
        this.rejectStartup?.(new Error('Tracking helper stopped before becoming ready.'));
        this.emit('exit');
      }
    });
    this.heartbeat = setInterval(() => {
      if (!exited && child.stdin.writable) child.stdin.write('heartbeat\n');
    }, 500);
    this.heartbeat.unref();
    // Bound diagnostics without relaying raw Python tracebacks/URLs/credentials.
    let stderrBytes = 0;
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 65536) void this.stop();
    });
    try {
      const result = await new Promise<SidecarConnection>((resolve, reject) => {
        this.rejectStartup = reject;
        let timer: NodeJS.Timeout | undefined;
        let buffer = '', readinessBytes = 0, settled = false;
        const finish = (error?: Error, connection?: SidecarConnection) => {
          if (settled) return;
          settled = true; clearTimeout(timer); this.rejectStartup = null;
          if (error) reject(error); else resolve(connection!);
        };
        timer = setTimeout(() => finish(new Error('Tracking helper startup timed out.')), this.options.startupTimeoutMs ?? 30000);
        this.rejectStartup = error => finish(error);
        child.once('error', () => {
          if (!child.pid && this.child === child) {
            this.child = null;
            if (this.heartbeat) clearInterval(this.heartbeat);
            this.heartbeat = null;
          }
          finish(new Error('Tracking helper could not start.'));
        });
        child.stdout.on('data', (chunk: Buffer) => {
          if (settled) return;
          readinessBytes += chunk.length;
          buffer += chunk.toString('utf8');
          if (readinessBytes > 4096) return finish(new Error('Tracking helper readiness was invalid.'));
          const newline = buffer.indexOf('\n');
          if (newline < 0) return;
          try {
            const ready = JSON.parse(buffer.slice(0, newline));
            if (Object.keys(ready).sort().join(',') !== 'pid,port,protocol,type' || ready.type !== 'ready' || ready.protocol !== 1 || ready.pid !== child.pid || !Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535) throw new Error('invalid');
            finish(undefined, { url: `ws://127.0.0.1:${ready.port}`, token });
          } catch { finish(new Error('Tracking helper readiness was invalid.')); }
        });
      });
      if (exited || this.child !== child) throw new Error('Tracking helper stopped before becoming ready.');
      this.connection = result;
      return result;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopOwned().finally(() => { this.stopping = null; });
    return this.stopping;
  }

  private async stopOwned(): Promise<void> {
    const child = this.child;
    this.connection = null;
    this.rejectStartup?.(new Error('Tracking helper startup was cancelled.'));
    this.rejectStartup = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (!child) return;
    const wait = (milliseconds: number) => new Promise<boolean>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
      const onExit = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => { child.off('exit', onExit); resolve(false); }, milliseconds);
      child.once('exit', onExit);
    });
    child.stdin.end(); // EOF independently terminates Python's parent watchdog.
    if (!await wait(1500)) {
      child.kill('SIGTERM');
      if (!await wait(1000)) { child.kill('SIGKILL'); if (!await wait(1000)) throw new Error('Tracking helper did not exit within its shutdown bound.'); }
    }
    if (this.child === child) this.child = null;
  }
}
