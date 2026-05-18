export interface DeviceCapabilities {
  pan: boolean;
  tilt: boolean;
  roll: boolean;
  zoom: boolean;
  position: boolean;
  moveTo: boolean;
}

export type DevicePosition =
  | { kind: 'visca'; pan: number; tilt: number; zoom: number }
  | { kind: 'gimbal'; yaw: number; pitch: number; roll: number; zoom?: number };

export interface MotionDevice {
  readonly id: string;
  readonly label: string;
  readonly protocol: string;
  readonly capabilities: DeviceCapabilities;
  readonly connected: boolean;

  connect(): void;
  close(): void;

  setPanTilt(panSpeed: number, tiltSpeed: number): void;
  setZoom(zoomSpeed: number): void;
  stop(): void;

  getPosition(): Promise<DevicePosition>;
  moveTo(pos: DevicePosition): Promise<void>;

  probe(timeoutMs?: number): Promise<boolean>;

  on(event: string, listener: (...args: unknown[]) => void): this;
}
