import { AtemClient, AtemInput } from './atemClient';
import { logger } from '../index';

/**
 * An ATEM that lives in memory: CAMCONTROL_FAKE_ATEM=1 (the interactive sandbox). Program / preview / keyers behave
 * like the real switcher's state so the desk and the iPad page can cut and transition with no hardware on the network.
 * ponytail: eight SDI inputs and one M/E; add more if a sandbox profile ever needs them.
 */
export class FakeAtemClient extends AtemClient {
  private program: number | undefined;
  private preview: number | undefined;

  async connect(): Promise<void> {
    this.connected = true;
    logger.warn('fake ATEM in memory (CAMCONTROL_FAKE_ATEM=1): nothing is on the network');
    this.emit('connected');
  }
  disconnect(): void { this.connected = false; }

  getProgramInput(): number | undefined { return this.program; }
  getPreviewInput(): number | undefined { return this.preview; }
  getAvailableInputs(): AtemInput[] {
    return [1, 2, 3, 4, 5, 6, 7, 8].map((id) => ({ id, longName: `SDI ${id}`, shortName: `SDI${id}` }));
  }

  async changePreviewInput(inputId: number): Promise<void> { this.preview = inputId; }
  async cut(): Promise<void> { const was = this.program; this.program = this.preview; this.preview = was; }
  async autoTransition(): Promise<void> { await this.cut(); }
  async setDownstreamKeyOnAir(): Promise<void> { /* no picture to key over */ }
  async setDownstreamKeyRate(): Promise<void> { /* no picture to key over */ }
  async autoDownstreamKey(): Promise<void> { /* no picture to key over */ }
  async setUpstreamKeyerOnAir(): Promise<void> { /* no picture to key over */ }
}
