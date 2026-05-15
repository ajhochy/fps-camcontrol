import { ControlStateMachine } from '../model/controlStateMachine';
import { logger } from '../index';

const LOOP_INTERVAL_MS = Math.floor(1000 / 60); // ~60Hz

let loopHandle: NodeJS.Timeout | null = null;

export function startControllerLoop(machine: ControlStateMachine): void {
  if (loopHandle) return;
  loopHandle = setInterval(() => {
    try {
      machine.tick();
    } catch (err) {
      logger.error({ err }, 'controller loop error');
    }
  }, LOOP_INTERVAL_MS);
}

export function stopControllerLoop(): void {
  if (loopHandle) {
    clearInterval(loopHandle);
    loopHandle = null;
  }
}
