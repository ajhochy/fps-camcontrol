import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import HID from 'node-hid';
import { logger } from '../index';

export interface AxisDef {
  byte: number;
  type: 'int16' | 'int16le' | 'uint8' | 'uint16le';
  range: [number, number];
}

export interface ButtonDef {
  byte: number;
  bit: number;
  activeLow?: boolean;
}

export interface ControllerProfile {
  name: string;
  vendorIds: number[];
  productIds: number[];
  connectionType?: 'usb' | 'bluetooth' | 'any'; // default 'any' if absent
  axes: Record<string, AxisDef>;
  buttons: Record<string, ButtonDef>;
}

export function detectConnectionType(device: HID.Device): 'usb' | 'bluetooth' {
  // On macOS, Bluetooth HID device paths typically contain 'Bluetooth'
  const p = (device.path ?? '').toLowerCase();
  if (p.includes('bluetooth')) return 'bluetooth';
  // Fallback: check vendor/product against known Bluetooth-only product IDs
  const bluetoothProductIds: Record<number, number[]> = {
    0x045E: [0x02E0, 0x0B20], // Xbox One BT (0x02E0), Xbox Series BT (0x0B20)
  };
  const btIds = bluetoothProductIds[device.vendorId] ?? [];
  if (btIds.includes(device.productId)) return 'bluetooth';
  return 'usb';
}

export function loadProfiles(profilesDir: string): ControllerProfile[] {
  const profiles: ControllerProfile[] = [];
  for (const file of fs.readdirSync(profilesDir)) {
    if (!file.endsWith('.yaml')) continue;
    const raw = fs.readFileSync(path.join(profilesDir, file), 'utf8');
    profiles.push(yaml.load(raw) as ControllerProfile);
  }
  return profiles;
}

export function detectProfile(
  device: HID.Device,
  profiles: ControllerProfile[]
): ControllerProfile | null {
  const deviceConnType = detectConnectionType(device);
  for (const profile of profiles) {
    const profileConnType = profile.connectionType ?? 'any';
    if (
      profile.vendorIds.includes(device.vendorId) &&
      profile.productIds.includes(device.productId) &&
      (profileConnType === 'any' || profileConnType === deviceConnType)
    ) {
      logger.info({ profile: profile.name, connectionType: deviceConnType }, 'matched controller profile');
      return profile;
    }
  }
  logger.warn({ vendorId: device.vendorId, productId: device.productId }, 'no matching controller profile');
  return null;
}

export function findConnectedController(
  profiles: ControllerProfile[]
): { device: HID.Device; profile: ControllerProfile; connectionType: 'usb' | 'bluetooth' } | null {
  const HID = require('node-hid');
  const devices: HID.Device[] = HID.devices();
  for (const dev of devices) {
    const connType = detectConnectionType(dev);
    for (const profile of profiles) {
      const profileConnType = profile.connectionType ?? 'any';
      if (
        profile.vendorIds.includes(dev.vendorId) &&
        profile.productIds.includes(dev.productId) &&
        (profileConnType === 'any' || profileConnType === connType)
      ) {
        return { device: dev, profile, connectionType: connType };
      }
    }
  }
  return null;
}
