export interface VirtualViscaState {
  pan: number;
  tilt: number;
  zoom: number;
}

// Simulated VISCA inquiry response: 8-byte header + y0 50 00 00 00 00 00 00 00 00 FF
const INQUIRY_RESPONSE = Buffer.from([
  0x01, 0x11, 0x00, 0x0B, 0x00, 0x00, 0x00, 0x01,
  0x90, 0x50, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFF,
]);

export class VirtualVisca {
  connected = true;
  log: string[] = [];
  state: VirtualViscaState = { pan: 0, tilt: 0, zoom: 0 };

  send(buf: Buffer): void {
    const bytes = Array.from(buf);
    // Skip 8-byte VISCA-over-IP header
    const payload = bytes.slice(8);
    if (payload.length === 0) return;
    const cmd = payload.join(',');
    this.log.push(`send([${cmd}])`);
  }

  // Simulate a VISCA inquiry — returns a canned response with position zeros
  async query(_bytes: Buffer, _timeoutMs = 2000): Promise<Buffer> {
    this.log.push('query()');
    return INQUIRY_RESPONSE;
  }

  async queryPanTilt(_timeoutMs = 2000): Promise<{ pan: number; tilt: number }> {
    this.log.push('queryPanTilt()');
    return { pan: this.state.pan, tilt: this.state.tilt };
  }

  async queryZoom(_timeoutMs = 2000): Promise<number> {
    this.log.push('queryZoom()');
    return this.state.zoom;
  }

  async probe(_timeoutMs = 2000): Promise<boolean> {
    return true;
  }

  printLog(): void {
    console.log('=== VirtualVisca Log ===');
    this.log.forEach(l => console.log(' ', l));
  }

  reset(): void {
    this.log = [];
  }
}
