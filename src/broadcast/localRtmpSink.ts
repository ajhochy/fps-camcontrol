import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { MediaProcess } from './mediaProcess';
import { FlvTagReader } from './flvTags';

// Controllable LOCAL RTMP receiver for fault injection (`ffmpeg -listen 1` bound to 127.0.0.1 only).
//  - kill():   endpoint disappears (connection reset, port refuses)
//  - stall():  SIGSTOP the receiver so a connected publisher's writes back up through the kernel socket buffers
//  - up():     (re)start a receiver; every FLV tag it emits is stamped with its arrival wall clock.
export type SinkSegment = { index: number; boundAt?: number; connectedAt?: number; firstTagAt?: number; closedAt?: number; file: string; reader: FlvTagReader; bytes: number; startedAt: number };
export type SinkOptions = { recvBufferBytes?: number; autoRelisten?: boolean };
export class LocalRtmpSink {
  readonly segments: SinkSegment[] = [];
  readonly events: { at: number; event: string }[] = [];
  private listener?: MediaProcess;
  private stopped = false;
  private closed = false;
  constructor(private ffmpeg: string, private dir: string, readonly port: number, private now: () => number, private options: SinkOptions = {}) {}
  private log(event: string) { this.events.push({ at: this.now(), event }); }
  get url(): string { return `rtmp://127.0.0.1:${this.port}/live/s1`; }
  get connections(): number { return this.segments.filter(s => s.connectedAt !== undefined).length; }
  private listening(): boolean {
    try { return execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${this.port}`, '-sTCP:LISTEN', '-t'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0; } catch { return false; }
  }
  async up(): Promise<SinkSegment> {
    this.stopped = false;
    const index = this.segments.length;
    const file = `${this.dir}/received-${index}.flv`;
    const segment: SinkSegment = { index, file, reader: new FlvTagReader(), bytes: 0, startedAt: this.now() };
    this.segments.push(segment);
    const out = createWriteStream(file);
    const recv = this.options.recvBufferBytes ? ['-recv_buffer_size', String(this.options.recvBufferBytes)] : [];
    // A TCP preflight would consume the listener's single accept, so readiness is polled via lsof instead.
    const listener = new MediaProcess('/usr/bin/nice', ['-n', '15', this.ffmpeg, '-hide_banner', '-nostdin', '-v', 'debug', '-listen', '1', '-timeout', '60', ...recv,
      '-i', this.url, '-c', 'copy', '-flush_packets', '1', '-f', 'flv', 'pipe:1'], 180000, false, (chunk: Buffer) => {
      if (segment.connectedAt === undefined && chunk.toString().includes('Proto = rtmp')) { segment.connectedAt = this.now(); this.log(`publisher connected (segment ${index})`); }
    });
    this.listener = listener;
    listener.child.stdout.on('data', (chunk: Buffer) => {
      const wall = this.now(); segment.bytes += chunk.length; out.write(chunk);
      try { segment.reader.push(chunk, wall); } catch { /* garbage after kill */ }
      if (segment.firstTagAt === undefined && segment.reader.tags.length) { segment.firstTagAt = wall; this.log(`segment ${index} first tag`); }
    });
    listener.child.stdout.once('close', () => { segment.closedAt = this.now(); out.end(); });
    listener.child.stdin.end();
    for (let i = 0; i < 80 && segment.connectedAt === undefined && !this.listening(); i++) await new Promise(r => setTimeout(r, 50));
    // A listener stops listening once it accepts, so a fast publisher can connect before the poll observes LISTEN.
    segment.boundAt = segment.connectedAt ?? this.now(); this.log(`sink listening (segment ${index})`);
    if (this.options.autoRelisten) void listener.done.then(() => { if (!this.stopped && !this.closed) { this.log('receiver exited; relistening'); return this.up(); } }).catch(() => {});
    return segment;
  }
  stall(): void { if (this.listener) process.kill(this.listener.child.pid!, 'SIGSTOP'); this.log('stall (receiver SIGSTOP)'); }
  resume(): void { if (this.listener) process.kill(this.listener.child.pid!, 'SIGCONT'); this.log('resume (receiver SIGCONT)'); }
  async kill(): Promise<void> {
    this.stopped = true; this.log('sink killed');
    const listener = this.listener; if (!listener) return;
    try { process.kill(listener.child.pid!, 'SIGCONT'); } catch { /* gone */ }
    listener.kill(); await listener.done.catch(() => {});
  }
  async close(): Promise<void> { this.closed = true; await this.kill(); }
}
