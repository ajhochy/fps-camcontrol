import type { TrackMessage } from './protocol';
export interface ResolvedTrackingSource {
  sourceId: string; sonyCameraId: string; device: string; cameraId: string | null; invertPan: boolean; invertTilt: boolean;
}
export type TrackingState = 'disabled'|'unavailable'|'idle'|'locking'|'tracking'|'holding'|'lost'|'stale'|'sidecar_offline'|'operator_override';
export interface TrackingSourceStatus extends ResolvedTrackingSource {
  sessionId: string | null; state: TrackingState; reason: string | null; observation: TrackMessage | null; pan: number; tilt: number;
}
export interface TrackingControlConfig {
  maxSpeed: number; deadzone: number; lostHoldMs: number; kp: number; kd: number; pipelineDelayMs: number;
  invertPan?: boolean; invertTilt?: boolean;
}
