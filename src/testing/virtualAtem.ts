import { EventEmitter } from 'events';

export interface VirtualAtemState {
  programInput: number;
  previewInput: number;
  dsk: Record<number, boolean>;
}

export class VirtualAtem extends EventEmitter {
  connected = true;
  state: VirtualAtemState = {
    programInput: 2,
    previewInput: 2,
    dsk: {},
  };
  log: string[] = [];

  async changePreviewInput(inputId: number): Promise<void> {
    this.state.previewInput = inputId;
    this.log.push(`changePreviewInput(${inputId})`);
  }

  async cut(): Promise<void> {
    this.state.programInput = this.state.previewInput;
    this.log.push(`cut() → program=${this.state.programInput}`);
    this.emit('connected');
  }

  async autoTransition(): Promise<void> {
    this.state.programInput = this.state.previewInput;
    this.log.push(`autoTransition() → program=${this.state.programInput}`);
  }

  async setDownstreamKeyOnAir(dskIndex: number, onAir: boolean): Promise<void> {
    this.state.dsk[dskIndex] = onAir;
    this.log.push(`setDownstreamKeyOnAir(${dskIndex}, ${onAir})`);
  }

  getProgramInput(): number { return this.state.programInput; }
  getPreviewInput(): number { return this.state.previewInput; }

  printLog(): void {
    console.log('=== VirtualAtem Log ===');
    this.log.forEach(l => console.log(' ', l));
  }
}
