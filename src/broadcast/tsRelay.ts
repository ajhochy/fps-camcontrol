import { Writable } from 'node:stream';

export const MAX_SUBSCRIBER_BYTES = 16 * 1024 * 1024;
type Subscriber = { stream: Writable; waiting: boolean };
export class TsRelay {
  private subscribers = new Set<Subscriber>();
  private pending = Buffer.alloc(0);
  private pat?: Buffer;
  private pmt?: Buffer;
  private pmtPid = -1;
  private videoPid = -1;
  get bufferedBytes(): number { return [...this.subscribers].reduce((sum, s) => sum + s.stream.writableLength, this.pending.length); }
  subscribe(stream: Writable): void {
    const subscriber = { stream, waiting: true };
    this.subscribers.add(subscriber);
    stream.on('error', () => this.subscribers.delete(subscriber));
    stream.once('close', () => this.subscribers.delete(subscriber));
  }
  push(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk]);
    let offset = 0;
    for (; offset + 188 <= this.pending.length; offset += 188) {
      const packet = this.pending.subarray(offset, offset + 188);
      if (packet[0] !== 0x47 || packet[1] & 0x80) throw new Error('Invalid MPEG-TS packet');
      const pid = ((packet[1] & 31) << 8) | packet[2];
      const start = !!(packet[1] & 64);
      const adaptation = !!(packet[3] & 32);
      const payload = 4 + (adaptation ? packet[4] + 1 : 0);
      if (start && (packet[3] & 16) && payload < 187) {
        const section = payload + 1 + packet[payload];
        if (pid === 0 && packet[section] === 0 && section + 11 < 188) {
          this.pat = Buffer.from(packet); this.pmtPid = ((packet[section + 10] & 31) << 8) | packet[section + 11];
        }
        if (pid === this.pmtPid && packet[section] === 2 && section + 12 < 188) {
          this.pmt = Buffer.from(packet);
          const length = ((packet[section + 1] & 15) << 8) | packet[section + 2];
          let entry = section + 12 + (((packet[section + 10] & 15) << 8) | packet[section + 11]);
          while (entry + 5 <= Math.min(188, section + 3 + length - 4)) {
            if (packet[entry] === 0x1b) this.videoPid = ((packet[entry + 1] & 31) << 8) | packet[entry + 2];
            entry += 5 + (((packet[entry + 3] & 15) << 8) | packet[entry + 4]);
          }
        }
      }
      const join = pid === this.videoPid && start && adaptation && packet[4] > 0 && !!(packet[5] & 64) && this.pat && this.pmt;
      for (const subscriber of this.subscribers) {
        if (subscriber.stream.destroyed) { this.subscribers.delete(subscriber); continue; }
        if (subscriber.waiting) {
          if (!join) continue;
          subscriber.waiting = false;
          this.write(subscriber, this.pat!); this.write(subscriber, this.pmt!);
        }
        this.write(subscriber, packet);
      }
    }
    this.pending = Buffer.from(this.pending.subarray(offset));
  }
  private write(subscriber: Subscriber, packet: Buffer): void {
    // No application backlog: Node's writable queue is the one measured/capped queue.
    if (subscriber.stream.writableLength + packet.length > MAX_SUBSCRIBER_BYTES) {
      this.subscribers.delete(subscriber);
      subscriber.stream.destroy(new Error('TS subscriber exceeded 16MiB')); return;
    }
    if (!subscriber.stream.destroyed) subscriber.stream.write(packet);
  }
  end(): void { for (const subscriber of this.subscribers) subscriber.stream.end(); this.subscribers.clear(); this.pending = Buffer.alloc(0); }
}
