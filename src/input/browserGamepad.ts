import { NormalizedInput } from './normalizers';

/**
 * The browser Gamepad API "standard" mapping, turned into the same NormalizedInput the HID path produces, so the
 * control state machine can't tell an iPad's Xbox controller from the one on the desk.
 *
 * What the page sends (see remote.js): the four stick axes (standard up = -1, which matches the HID
 * normalisation: the machine computes tilt as -rightStickY), the two analog triggers (buttons[6].value and
 * buttons[7].value), and every other button packed into one 16-bit mask, bit n = standard button n.
 *
 * Bit 16 (Guide/Home) never makes it here: iPadOS owns that button, and the mask is limited to 16 bits.
 * PlayStation / Switch Pro pads also report the standard mapping, but positionally (bit 0 is the bottom face
 * button, not the one labelled A). The local profiles for those are label-based, so face buttons differ.
 */
export interface BrowserGamepadFrame {
  a: number[];   // [leftStickX, leftStickY, rightStickX, rightStickY], -1..1
  tr: number[];  // [leftTrigger, rightTrigger], 0..1
  b: number;     // button bitmask (bits 0..15 of the standard mapping)
}

/** Standard-mapping button index -> the machine's button name. Bits 6/7 are the triggers (carried by `tr`). */
export const STANDARD_BUTTON_BITS: Record<number, string> = {
  0: 'A', 1: 'B', 2: 'X', 3: 'Y',
  4: 'LB', 5: 'RB',
  8: 'back', 9: 'start',
  10: 'LS', 11: 'RS',
  12: 'dpadUp', 13: 'dpadDown', 14: 'dpadLeft', 15: 'dpadRight',
};

export const BUTTON_NAMES: string[] = Object.values(STANDARD_BUTTON_BITS);

export function standardFrameToInput(frame: BrowserGamepadFrame): NormalizedInput {
  const buttons: Record<string, boolean> = {};
  // Every key is always present (false by default) so the machine's edge state is complete.
  for (const [bit, name] of Object.entries(STANDARD_BUTTON_BITS)) {
    buttons[name] = (frame.b & (1 << Number(bit))) !== 0;
  }
  return {
    axes: {
      leftStickX: frame.a[0] ?? 0,
      leftStickY: frame.a[1] ?? 0,
      rightStickX: frame.a[2] ?? 0,
      rightStickY: frame.a[3] ?? 0,
    },
    triggers: {
      leftTrigger: frame.tr[0] ?? 0,
      rightTrigger: frame.tr[1] ?? 0,
    },
    buttons,
  };
}

/** An all-neutral input: sticks centred, nothing pressed. */
export function neutralInput(): NormalizedInput {
  return standardFrameToInput({ a: [0, 0, 0, 0], tr: [0, 0], b: 0 });
}
