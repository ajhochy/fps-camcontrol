import type { AppState } from './state';
import type { TrackingManager } from '../tracking/trackingManager';
import type { MotionLedger } from '../tracking/motionLedger';

export interface TrackingHooks {
  manager: TrackingManager;
  ledger: MotionLedger;
  client?: { connected: boolean };
  refreshSources?: () => void;
}
// Runtime capabilities are never serialized into AppState or exposed over HTTP.
const active = new WeakMap<AppState, TrackingHooks>();
export function registerTracking(state: AppState, hooks: TrackingHooks): void { active.set(state, hooks); }
export function trackingFor(state: AppState): TrackingHooks | undefined { return active.get(state); }
export function unregisterTracking(state: AppState): void { active.delete(state); }
