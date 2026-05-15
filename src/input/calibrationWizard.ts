import { EventEmitter } from 'events';

export interface CalibrationStep {
  instruction: string;
  axis?: string;
  button?: string;
}

export class CalibrationWizard extends EventEmitter {
  private steps: CalibrationStep[] = [
    { instruction: 'Move left stick all the way right and release', axis: 'leftStickX' },
    { instruction: 'Move left stick all the way up and release', axis: 'leftStickY' },
    { instruction: 'Move right stick all the way right and release', axis: 'rightStickX' },
    { instruction: 'Move right stick all the way up and release', axis: 'rightStickY' },
    { instruction: 'Press A button', button: 'A' },
    { instruction: 'Press B button', button: 'B' },
    { instruction: 'Press X button', button: 'X' },
    { instruction: 'Press Y button', button: 'Y' },
  ];
  private currentStep = 0;
  active = false;

  start(): void {
    this.active = true;
    this.currentStep = 0;
    this.emit('step', this.steps[0]);
  }

  advance(): void {
    this.currentStep++;
    if (this.currentStep >= this.steps.length) {
      this.active = false;
      this.emit('complete');
    } else {
      this.emit('step', this.steps[this.currentStep]);
    }
  }

  getCurrentStep(): CalibrationStep | null {
    return this.steps[this.currentStep] ?? null;
  }
}
