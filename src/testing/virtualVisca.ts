export interface VirtualViscaState {
  pan: number;
  tilt: number;
  zoom: number;
}

export class VirtualVisca {
  connected = true;
  log: string[] = [];
  state: VirtualViscaState = { pan: 0, tilt: 0, zoom: 0 };

  sendPayload(payload: number[]): void {
    if (payload.length === 0) return;
    this.log.push(`send([${payload.join(',')}])`);
  }

  send(buf: Buffer): void {
    // Parse a small subset of VISCA commands for smoke testing
    const bytes = Array.from(buf);
    // Skip 8-byte VISCA-over-IP header
    const payload = bytes.slice(8);
    if (payload.length === 0) return;
    const cmd = payload.join(',');
    this.log.push(`send([${cmd}])`);
  }

  printLog(): void {
    console.log('=== VirtualVisca Log ===');
    this.log.forEach(l => console.log(' ', l));
  }

  reset(): void {
    this.log = [];
  }
}
