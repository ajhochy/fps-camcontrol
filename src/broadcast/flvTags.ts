// Minimal streaming FLV tag reader used to timestamp what a local receiver actually got.
import { createHash } from 'node:crypto';
export type FlvTag = { kind: 'video' | 'audio' | 'script'; ts: number; size: number; key: boolean; config: boolean; wall: number; md5?: string };
export class FlvTagReader {
  private buf = Buffer.alloc(0);
  private headerDone = false;
  readonly tags: FlvTag[] = [];
  headerSeen = false;
  push(chunk: Buffer, wall: number): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (!this.headerDone) {
      if (this.buf.length < 13) return;
      if (this.buf.toString('ascii', 0, 3) !== 'FLV') throw new Error('Not an FLV stream');
      this.headerDone = this.headerSeen = true; this.buf = this.buf.subarray(13);
    }
    for (;;) {
      if (this.buf.length < 11) break;
      const size = this.buf.readUIntBE(1, 3);
      if (this.buf.length < 11 + size + 4) break;
      const type = this.buf[0] & 31;
      const ts = this.buf.readUIntBE(4, 3) | (this.buf[7] << 24);
      const first = this.buf[11], second = this.buf[12];
      const kind = type === 9 ? 'video' : type === 8 ? 'audio' : 'script';
      const config = ((kind === 'video' || kind === 'audio') && second === 0) || (kind === 'video' && second === 2); // sequence header or AVC end-of-sequence
      // Video payload (after the 5-byte FLV/AVC header) is the same AVCC access unit the MP4 recorded: lets a receiver match frames to the recording.
      const md5 = kind === 'video' && !config ? createHash('md5').update(this.buf.subarray(16, 11 + size)).digest('hex') : undefined;
      this.tags.push({ kind, ts, size, wall, key: kind === 'video' && (first >> 4) === 1 && second === 1, config, md5 });
      this.buf = this.buf.subarray(11 + size + 4);
    }
  }
}
