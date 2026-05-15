import { EventEmitter } from 'events';
import { NormalizedInput } from '../input/normalizers';

export class VirtualController extends EventEmitter {
  private axes: Record<string, number> = {
    leftStickX: 0, leftStickY: 0,
    rightStickX: 0, rightStickY: 0,
  };
  private buttons: Record<string, boolean> = {
    A: false, B: false, X: false, Y: false,
    LB: false, RB: false, LS: false, RS: false,
    dpadUp: false, dpadDown: false, dpadLeft: false, dpadRight: false,
    back: false, start: false,
  };
  private triggers: Record<string, number> = {
    leftTrigger: 0,
    rightTrigger: 0,
  };

  getInput(): NormalizedInput {
    return {
      axes: { ...this.axes },
      buttons: { ...this.buttons },
      triggers: { ...this.triggers },
    };
  }

  setAxis(axis: string, value: number): void {
    this.axes[axis] = value;
    this.emit('input', this.getInput());
  }

  setTrigger(name: string, value: number): void {
    this.triggers[name] = value;
    this.emit('input', this.getInput());
  }

  pressButton(button: string): void {
    this.buttons[button] = true;
    this.emit('input', this.getInput());
  }

  releaseButton(button: string): void {
    this.buttons[button] = false;
    this.emit('input', this.getInput());
  }

  flickRight(): void {
    // Simulate a stick flick: move past threshold, then return to neutral
    this.setAxis('leftStickX', 0.9);
    setTimeout(() => this.setAxis('leftStickX', 0), 50);
  }

  flickLeft(): void {
    this.setAxis('leftStickX', -0.9);
    setTimeout(() => this.setAxis('leftStickX', 0), 50);
  }
}
