import HID from 'node-hid';
import { EventEmitter } from 'events';
import { logger } from '../index';

export class GamepadDevice extends EventEmitter {
  private device: HID.HID | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private vendorId: number;
  private productId: number;
  private path: string | undefined;
  connected = false;

  constructor(vendorId: number, productId: number, path?: string) {
    super();
    this.vendorId = vendorId;
    this.productId = productId;
    this.path = path;
  }

  open(): void {
    try {
      // macOS assigns a new IOKit service ID every time the Bluetooth controller
      // disconnects and reconnects. The path we cached at startup goes stale,
      // and reopening it fails forever. Re-enumerate each open attempt and pick
      // the gamepad-usage interface (usage 5) for this vendor/product.
      const candidates = HID.devices().filter(
        (d: HID.Device) => d.vendorId === this.vendorId && d.productId === this.productId
      );
      const preferred = candidates.find(d => d.usagePage === 1 && d.usage === 5) ?? candidates[0];
      const freshPath = preferred?.path;
      if (freshPath && freshPath !== this.path) {
        logger.info({ old: this.path, new: freshPath }, 'gamepad HID path refreshed');
        this.path = freshPath;
      }

      this.device = this.path
        ? new HID.HID(this.path)
        : new HID.HID(this.vendorId, this.productId);

      // On macOS, new HID.HID() can succeed silently even when Input Monitoring
      // permission is denied — the constructor returns but no 'data' events ever
      // fire. Defer the 'connected' state until we actually receive a packet,
      // and surface a clear warning if nothing arrives within the handshake window.
      let gotFirstPacket = false;
      const handshakeTimer = setTimeout(() => {
        if (gotFirstPacket) return;
        logger.warn(
          { vendorId: this.vendorId, productId: this.productId, path: this.path },
          'gamepad opened but no HID data within 2s — likely missing macOS Input Monitoring permission'
        );
        this.scheduleReconnect();
      }, 2000);

      this.device.on('data', (data: Buffer) => {
        if (!gotFirstPacket) {
          gotFirstPacket = true;
          clearTimeout(handshakeTimer);
          this.connected = true;
          this.emit('connected');
          logger.info({ vendorId: this.vendorId, productId: this.productId }, 'gamepad connected');
        }
        this.emit('data', data);
      });
      this.device.on('error', (err: Error) => {
        clearTimeout(handshakeTimer);
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
