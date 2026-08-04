import { ViscaClient } from '../visca/viscaClient';
import { ActivityLog } from '../app/activityLog';
import {
  panTilt as viscaPanTilt,
  zoom as viscaZoom,
  stopPTZ,
  gotoAbsolutePosition,
  queryPosition,
} from '../visca/ptzActions';
import { MotionDevice, DeviceCapabilities, DevicePosition } from './motionDevice';

export class ViscaDevice implements MotionDevice {
  readonly protocol = 'visca';
  readonly capabilities: DeviceCapabilities = {
    pan: true,
    tilt: true,
    roll: false,
    zoom: true,
    position: true,
    moveTo: true,
  };

  constructor(
    public readonly client: ViscaClient,
    public readonly id: string,
    public label: string,
  ) {}

  get connected(): boolean {
    return this.client.connected;
  }

  connect(): void {
    this.client.connect();
  }

  close(): void {
    this.client.close();
  }

  setPanTilt(panSpeed: number, tiltSpeed: number): void {
    viscaPanTilt(this.client, panSpeed, tiltSpeed);
  }

  setZoom(zoomSpeed: number): void {
    viscaZoom(this.client, zoomSpeed);
  }

  stop(): void {
    stopPTZ(this.client);
  }

  async getPosition(): Promise<DevicePosition> {
    const p = await queryPosition(this.client);
    return { kind: 'visca', pan: p.pan, tilt: p.tilt, zoom: p.zoom };
  }

  async moveTo(pos: DevicePosition): Promise<void> {
    if (pos.kind !== 'visca') {
      throw new Error(`ViscaDevice requires visca position, got ${pos.kind}`);
    }
    gotoAbsolutePosition(this.client, { pan: pos.pan, tilt: pos.tilt, zoom: pos.zoom });
  }

  probe(timeoutMs?: number): Promise<boolean> {
    return this.client.probe(timeoutMs);
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    this.client.on(event, listener);
    return this;
  }

  setActivityLog(log: ActivityLog, label: string): void {
    this.label = label;
    this.client.setActivityLog(log, label);
  }
}
