import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { syntheticEncodeArgs, remuxArgs, SyntheticFormat } from './ffmpegArgs';
import { TsRelay } from './tsRelay';

export type MediaResult = { pid: number; code: number | null; signal: string | null; stderr: string; stdout: Buffer; elapsedMs: number };
const owned = new Set<MediaProcess>();
export class MediaProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly done: Promise<MediaResult>;
  stderr = Buffer.alloc(0);
  private timer: NodeJS.Timeout;
  constructor(binary: string, args: string[], deadlineMs: number, capture = false, onStderr?: (chunk: Buffer) => void) {
    const started = Date.now();
    this.child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CAMCONTROL_NO_CONTROLLER: '1' } });
    owned.add(this);
    this.child.stdin.on('error', () => {});
    this.child.stderr.on('data', (chunk: Buffer) => { this.stderr = Buffer.concat([this.stderr, chunk]).subarray(-8192); onStderr?.(chunk); });
    const chunks: Buffer[] = []; let bytes = 0;
    if (capture) this.child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) this.kill(); else chunks.push(chunk);
    });
    this.timer = setTimeout(() => this.kill(), deadlineMs);
    this.done = new Promise((resolve, reject) => {
      this.child.once('error', reject);
      this.child.once('close', (code, signal) => {
        clearTimeout(this.timer); owned.delete(this);
        resolve({ pid: this.child.pid!, code, signal, stderr: this.stderr.toString(), stdout: Buffer.concat(chunks), elapsedMs: Date.now() - started });
      });
    });
  }
  kill(): void { if (owned.has(this)) this.child.kill('SIGKILL'); }
  async stop(): Promise<MediaResult> {
    this.child.stdin.end();
    const timer = setTimeout(() => this.kill(), 3000);
    try { return await this.done; } finally { clearTimeout(timer); }
  }
}
export async function stopOwned(): Promise<void> {
  const children = [...owned]; children.forEach(child => child.kill());
  await Promise.allSettled(children.map(child => child.done));
}
export function ownedPids(): number[] { return [...owned].map(child => child.child.pid!).filter(Boolean); }
export async function runMedia(binary: string, args: string[], deadlineMs = 30000, onStderr?: (chunk: Buffer) => void): Promise<MediaResult> {
  const child = new MediaProcess(binary, args, deadlineMs, true, onStderr);
  child.child.stdin.end();
  const result = await child.done;
  if (result.code !== 0) throw new Error(`BLOCKED: media PID ${result.pid} exit ${result.code}/${result.signal}: ${result.stderr}`);
  return result;
}

export function syntheticPipeline(binary: string, format: SyntheticFormat) {
  const relay = new TsRelay();
  const encoder = new MediaProcess(binary, syntheticEncodeArgs(format), (format.seconds + 20) * 1000);
  encoder.child.stdout.on('data', (chunk: Buffer) => {
    try { relay.push(chunk); } catch (error) { encoder.kill(); relay.end(); }
  });
  encoder.child.stdout.once('end', () => relay.end());
  const attach = (target: string, kind: 'mp4' | 'flv') => {
    const output = new MediaProcess(binary, remuxArgs(target, kind), (format.seconds + 30) * 1000);
    output.child.stdin.once('error', () => output.kill());
    relay.subscribe(output.child.stdin);
    return output;
  };
  return { encoder, relay, attach };
}
