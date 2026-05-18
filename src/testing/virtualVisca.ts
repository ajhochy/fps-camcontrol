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
    const bytes = Array.from(buf);
    const payload = bytes.slice(8);
    if (payload.length === 0) return;
    const cmd = payload.join(',');
    this.log.push(`send([${cmd}])`);
  }

  async queryPanTilt(): Promise<{ pan: number; tilt: number }> {
    return { pan: this.state.pan, tilt: this.state.tilt };
  }

  async queryZoom(): Promise<{ zoom: number }> {
    return { zoom: this.state.zoom };
  }

  async probe(_timeoutMs?: number): Promise<boolean> {
    return this.connected;
  }

  on(_event: string, _listener: (...args: unknown[]) => void): this {
    return this;
  }

  setActivityLog(_log: unknown, _label: string): void { /* no-op */ }
  close(): void { /* no-op */ }
  connect(): void { /* no-op */ }

  async inquire(payload: number[]): Promise<Buffer> {
    this.log.push(`inquire([${payload.join(',')}])`);
    // Pan/tilt inquiry: 81 09 06 12 FF
    if (payload[0] === 0x81 && payload[1] === 0x09 && payload[2] === 0x06 && payload[3] === 0x12) {
      const pan = this.state.pan < 0 ? this.state.pan + 0x10000 : this.state.pan;
      const tilt = this.state.tilt < 0 ? this.state.tilt + 0x10000 : this.state.tilt;
      return Buffer.from([
        0x90, 0x50,
        (pan >> 12) & 0xF, (pan >> 8) & 0xF, (pan >> 4) & 0xF, pan & 0xF,
        (tilt >> 12) & 0xF, (tilt >> 8) & 0xF, (tilt >> 4) & 0xF, tilt & 0xF,
        0xFF,
      ]);
    }
    // Zoom inquiry: 81 09 04 47 FF
    if (payload[0] === 0x81 && payload[1] === 0x09 && payload[2] === 0x04 && payload[3] === 0x47) {
      const zoom = this.state.zoom;
      return Buffer.from([
        0x90, 0x50,
        (zoom >> 12) & 0xF, (zoom >> 8) & 0xF, (zoom >> 4) & 0xF, zoom & 0xF,
        0xFF,
      ]);
    }
    throw new Error(`VirtualVisca: unknown inquiry [${payload.join(', ')}]`);
  }

  printLog(): void {
    console.log('=== VirtualVisca Log ===');
    this.log.forEach(l => console.log(' ', l));
  }

  reset(): void {
    this.log = [];
  }
}
