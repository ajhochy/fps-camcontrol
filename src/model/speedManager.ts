import { AppState } from '../app/state';
import { AppConfig } from '../config/configLoader';
import { logger } from '../index';

export class SpeedManager {
  constructor(private state: AppState, private config: AppConfig) {}

  increment(): void {
    const max = this.config.speeds.presets.length - 1;
    if (this.state.speedPreset < max) {
      this.state.speedPreset++;
      logger.info({ preset: this.config.speeds.presets[this.state.speedPreset].name }, 'speed up');
    }
  }

  decrement(): void {
    if (this.state.speedPreset > 0) {
      this.state.speedPreset--;
      logger.info({ preset: this.config.speeds.presets[this.state.speedPreset].name }, 'speed down');
    }
  }
}
