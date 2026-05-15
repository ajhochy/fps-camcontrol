import HID from 'node-hid';
import { EventEmitter } from 'events';
import { logger } from '../index';

export class GamepadDevice extends EventEmitter {
  private device: HID.HID | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private vendorId: number;
  private productId: number;
  connected = false;

  constructor(vendorId: number, productId: number) {
    super();
    this.vendorId = vendorId;
    this.productId = productId;
  }

  open(): void {
    try {
      this.device = new HID.HID(this.vendorId, this.productId);
      this.connected = true;
      this.emit('connected');
      logger.info({ vendorId: this.vendorId, productId: this.productId }, 'gamepad connected');
      this.device.on('data', (data: Buffer) => {
        this.emit('data', data);
      });
      this.device.on('error', (err: Error) => {
        logger.warn({ err }, 'gamepad error, scheduling reconnect');
        this.scheduleReconnect();
      });
    } catch (err) {
      logger.warn({ err }, 'gamepad open failed, scheduling reconnect');
      this.scheduleReconnect();
    }
  }

  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.device) {
      try { this.device.close(); } catch { /* ignore */ }
      this.device = null;
    }
    this.connected = false;
  }

  // Trigger haptic rumble for durationMs. Sends Xbox One USB HID output report.
  // Silently ignores errors if the controller doesn't support rumble.
  rumble(durationMs: number): void {
    if (!this.device) return;
    try {
      // Xbox One/Series USB HID output report 0x09 for vibration
      // Format: [reportId, 0x00, 0x00, enable, leftMotor, rightMotor, leftTrigger, rightTrigger, duration, loop, repeat]
      this.device.write([0x00, 0x09, 0x00, 0x00, 0x09, 0x00, 0xFF, 0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00, 0x00]);
      setTimeout(() => {
        if (!this.device) return;
        try {
          this.device.write([0x00, 0x09, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
        } catch { /* ignore */ }
      }, durationMs);
    } catch (err) {
      logger.debug({ err }, 'rumble not supported on this controller');
    }
  }

  private scheduleReconnect(): void {
    if (this.device) {
      try { this.device.close(); } catch { /* ignore */ }
      this.device = null;
    }
    this.connected = false;
    this.emit('disconnected');
    if (!this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.open();
      }, 2000);
    }
  }
}

export function listHIDDevices(): HID.Device[] {
  return HID.devices();
}
