import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import HID from 'node-hid';
import { logger } from '../index';

export interface AxisDef {
  byte: number;
  type: 'int16' | 'uint8';
  range: [number, number];
}

export interface ButtonDef {
  byte: number;
  bit: number;
}

export interface ControllerProfile {
  name: string;
  vendorIds: number[];
  productIds: number[];
  axes: Record<string, AxisDef>;
  buttons: Record<string, ButtonDef>;
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
  for (const profile of profiles) {
    if (
      profile.vendorIds.includes(device.vendorId) &&
      profile.productIds.includes(device.productId)
    ) {
      logger.info({ profile: profile.name }, 'matched controller profile');
      return profile;
    }
  }
  logger.warn({ vendorId: device.vendorId, productId: device.productId }, 'no matching controller profile');
  return null;
}

export function findConnectedController(
  profiles: ControllerProfile[]
): { device: HID.Device; profile: ControllerProfile } | null {
  const HID = require('node-hid');
  const devices: HID.Device[] = HID.devices();
  for (const dev of devices) {
    for (const profile of profiles) {
      if (
        profile.vendorIds.includes(dev.vendorId) &&
        profile.productIds.includes(dev.productId)
      ) {
        return { device: dev, profile };
      }
    }
  }
  return null;
}
