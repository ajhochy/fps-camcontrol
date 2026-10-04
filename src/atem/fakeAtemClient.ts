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
  // No picture to key over, but the key's on-air state is kept and reported like the real switcher's.
  private keyOnAir = false;
  graphicsOnAir(): boolean | undefined { return this.connected ? this.keyOnAir : undefined; }
  /** Test hook: someone takes the key on or off at the ATEM panel, outside this app. */
  setKeyFromPanel(onAir: boolean): void { this.keyOnAir = onAir; this.emit('stateChanged'); }
  async setDownstreamKeyOnAir(_index: number, onAir: boolean): Promise<void> { this.setKeyFromPanel(onAir); }
  async setDownstreamKeyRate(): Promise<void> { /* no fade to time */ }
  async autoDownstreamKey(_index: number, onAir?: boolean): Promise<void> { this.setKeyFromPanel(onAir ?? !this.keyOnAir); }
  async setUpstreamKeyerOnAir(_me: number, _usk: number, onAir: boolean): Promise<void> { this.setKeyFromPanel(onAir); }
}
