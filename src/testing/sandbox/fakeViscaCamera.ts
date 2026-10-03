import dgram from 'dgram';

/**
 * A VISCA-over-IP camera on a UDP port, for the sandbox. It answers the inquiries
 * the app polls (health probe, pan/tilt and zoom position) and acknowledges
 * motion commands, so a rig pointed at it shows as connected. It does not
 * simulate movement: position stays at 0.
 */
export class FakeViscaCamera {
  private socket = dgram.createSocket('udp4');
  commands = 0;
  inquiries = 0;
  /** Zoom drive commands received (81 01 04 07 ..), stops included. */
  zoomCommands = 0;

  constructor(readonly port: number, readonly name: string) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
      this.socket.bind(this.port, '127.0.0.1', () => { this.socket.off('error', reject); resolve(); });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => { try { this.socket.close(() => resolve()); } catch { resolve(); } });
  }

  private reply(rinfo: dgram.RemoteInfo, seq: Buffer, payload: number[]): void {
    const header = Buffer.from([0x01, 0x11, 0x00, payload.length, seq[0], seq[1], seq[2], seq[3]]);
    this.socket.send(Buffer.concat([header, Buffer.from(payload)]), rinfo.port, rinfo.address);
  }

  private onMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    if (msg.length < 9) return;
    const seq = msg.subarray(4, 8);
    const p = Array.from(msg.subarray(8));
    const nibbles = (v: number): number[] => [(v >> 12) & 0xF, (v >> 8) & 0xF, (v >> 4) & 0xF, v & 0xF];
    if (p[1] === 0x09) { // inquiry
      this.inquiries++;
      if (p[2] === 0x06 && p[3] === 0x12) this.reply(rinfo, seq, [0x90, 0x50, ...nibbles(0), ...nibbles(0), 0xFF]); // pan/tilt
      else if (p[2] === 0x04 && p[3] === 0x47) this.reply(rinfo, seq, [0x90, 0x50, ...nibbles(0), 0xFF]); // zoom
      else this.reply(rinfo, seq, [0x90, 0x50, 0x02, 0xFF]); // health probe and anything else
    } else if (p[1] === 0x01) { // command: acknowledge, then complete
      this.commands++;
      if (p[2] === 0x04 && p[3] === 0x07) this.zoomCommands++;
      this.reply(rinfo, seq, [0x90, 0x41, 0xFF]);
      this.reply(rinfo, seq, [0x90, 0x51, 0xFF]);
    }
  }
}
