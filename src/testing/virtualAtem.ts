import { EventEmitter } from 'events';
import { AtemInput } from '../atem/atemClient';

export interface VirtualAtemState {
  programInput: number;
  previewInput: number;
  dsk: Record<number, boolean>;
  usk: Record<string, boolean>;
}

export class VirtualAtem extends EventEmitter {
  connected = true;
  state: VirtualAtemState = {
    programInput: 2,
    previewInput: 2,
    dsk: {},
    usk: {},
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

  async setUpstreamKeyerOnAir(meIndex: number, keyIndex: number, onAir: boolean): Promise<void> {
    const key = `${meIndex}:${keyIndex}`;
    this.state.usk[key] = onAir;
    this.log.push(`setUpstreamKeyerOnAir(${meIndex}, ${keyIndex}, ${onAir})`);
  }

  getAvailableInputs(): AtemInput[] {
    return [
      { id: 1, longName: 'SDI 1', shortName: 'SDI1' },
      { id: 2, longName: 'SDI 2', shortName: 'SDI2' },
      { id: 3, longName: 'SDI 3', shortName: 'SDI3' },
      { id: 4, longName: 'SDI 4', shortName: 'SDI4' },
      { id: 1000, longName: 'Color Bars', shortName: 'Bars' },
    ];
  }

  getProgramInput(): number { return this.state.programInput; }
  getPreviewInput(): number { return this.state.previewInput; }

  printLog(): void {
    console.log('=== VirtualAtem Log ===');
    this.log.forEach(l => console.log(' ', l));
  }
}
