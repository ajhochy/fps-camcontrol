import { AxisDef, ButtonDef, ControllerProfile } from './profileDetector';

export interface NormalizedInput {
  axes: Record<string, number>;   // -1.0 to 1.0
  buttons: Record<string, boolean>;
  triggers: Record<string, number>; // 0.0 to 1.0
}

function readInt16LE(buf: Buffer, offset: number): number {
  const lo = buf[offset] ?? 0;
  const hi = buf[offset + 1] ?? 0;
  const val = (hi << 8) | lo;
  return val >= 0x8000 ? val - 0x10000 : val;
}

function readUint8(buf: Buffer, offset: number): number {
  return buf[offset] ?? 0;
}

function normalizeAxis(raw: number, def: AxisDef): number {
  const [min, max] = def.range;
  const mid = (min + max) / 2;
  const half = (max - min) / 2;
  return Math.max(-1, Math.min(1, (raw - mid) / half));
}

function normalizeTrigger(raw: number, def: AxisDef): number {
  const [min, max] = def.range;
  return Math.max(0, Math.min(1, (raw - min) / (max - min)));
}

export function normalizeHIDReport(buf: Buffer, profile: ControllerProfile): NormalizedInput {
  const axes: Record<string, number> = {};
  const buttons: Record<string, boolean> = {};
  const triggers: Record<string, number> = {};

  for (const [name, def] of Object.entries(profile.axes)) {
    let raw: number;
    if (def.type === 'int16') {
      raw = readInt16LE(buf, def.byte);
    } else {
      raw = readUint8(buf, def.byte);
    }

    if (name === 'leftTrigger' || name === 'rightTrigger') {
      triggers[name] = normalizeTrigger(raw, def);
    } else {
      axes[name] = normalizeAxis(raw, def);
    }
  }

  for (const [name, def] of Object.entries(profile.buttons)) {
    const byte = buf[def.byte] ?? 0;
    buttons[name] = Boolean(byte & (1 << def.bit));
  }

  return { axes, buttons, triggers };
}
