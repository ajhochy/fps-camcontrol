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
  /**
   * The transport to this device is up. For a two-stage link this means only
   * "we can talk to the bridge" — see `gimbalAttached`.
   */
  readonly connected: boolean;

  /**
   * Whether motion hardware is actually attached at the far end of a two-stage
   * link (app → Pi bridge → gimbal over BLE).
   *
   * `undefined` means the device has no second stage: a VISCA camera *is* the
   * far end of its own socket, so `connected` already says everything and this
   * property is deliberately absent rather than false. Consumers must treat
   * `undefined` as "not applicable", never as "detached".
   */
  readonly gimbalAttached?: boolean;

  connect(): void;
  close(): void;

  setPanTilt(panSpeed: number, tiltSpeed: number): void;
  setZoom(zoomSpeed: number): void;
  stop(): void;

  getPosition(): Promise<DevicePosition>;
  moveTo(pos: DevicePosition): Promise<void>;

  probe(timeoutMs?: number): Promise<boolean>;

  /** Optional: only present on devices that advertise a recenter capability. */
  recenter?(): Promise<void>;

  on(event: string, listener: (...args: unknown[]) => void): this;
}
