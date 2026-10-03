import assert from 'assert';
import { standardFrameToInput, STANDARD_BUTTON_BITS, BUTTON_NAMES, neutralInput } from '../input/browserGamepad';

/** The browser Gamepad -> NormalizedInput mapping (input/browserGamepad.ts). Run: node dist/testing/browserGamepadTest.js */
let passed = 0;
const check = (name: string, condition: boolean): void => { assert.ok(condition, `FAILED ${name}`); passed++; };
const none = { a: [0, 0, 0, 0], tr: [0, 0] };

const expected: Record<number, string> = { 0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 8: 'back', 9: 'start', 10: 'LS', 11: 'RS', 12: 'dpadUp', 13: 'dpadDown', 14: 'dpadLeft', 15: 'dpadRight' };
for (const [bit, name] of Object.entries(expected)) {
  const input = standardFrameToInput({ ...none, b: 1 << Number(bit) });
  const pressed = Object.entries(input.buttons).filter(([, v]) => v).map(([k]) => k);
  check(`bit ${bit} is ${name} and nothing else`, pressed.length === 1 && pressed[0] === name);
}
check('the table matches the standard mapping', JSON.stringify(STANDARD_BUTTON_BITS) === JSON.stringify(expected));

const neutral = neutralInput();
check('all 14 button keys are always present, false by default', Object.keys(neutral.buttons).length === 14 && BUTTON_NAMES.every((n) => neutral.buttons[n] === false));
check('bits 6 and 7 (the triggers) are not buttons', Object.values(standardFrameToInput({ ...none, b: 0xc0 }).buttons).every((v) => !v));

const sticks = standardFrameToInput({ a: [-0.5, 0.25, 0.8, -1], tr: [0.3, 0.9], b: 0 });
check('axes pass straight through by name', sticks.axes.leftStickX === -0.5 && sticks.axes.leftStickY === 0.25 && sticks.axes.rightStickX === 0.8 && sticks.axes.rightStickY === -1);
check('triggers come from tr', sticks.triggers.leftTrigger === 0.3 && sticks.triggers.rightTrigger === 0.9);
check('stick up (-1) is the sign the HID path gives, so tilt = -rightY is positive', -sticks.axes.rightStickY > 0);
check('the Guide bit (16) is ignored', Object.values(standardFrameToInput({ ...none, b: 1 << 16 }).buttons).every((v) => !v));
check('missing array entries default to 0', (() => { const i = standardFrameToInput({ a: [], tr: [], b: 0 }); return i.axes.rightStickX === 0 && i.triggers.rightTrigger === 0; })());

console.log(`browserGamepad: ${passed} checks passed`);
