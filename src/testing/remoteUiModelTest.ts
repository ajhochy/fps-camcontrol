import assert from 'assert';
import path from 'path';
import { parseClientMessage } from '../input/remoteFrame';
import { standardFrameToInput } from '../input/browserGamepad';

/**
 * The remote page's logic (ui/remote/remoteModel.js), including a round trip through the server's validator and
 * mapper so the two sides of the wire cannot drift apart. Run: node dist/testing/remoteUiModelTest.js
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const model = require(path.resolve(__dirname, '../../ui/remote/remoteModel.js'));
let passed = 0;
const check = (name: string, condition: boolean): void => { assert.ok(condition, `FAILED ${name}`); passed++; };

const pad = (axes: number[], pressed: number[] = [], triggers: [number, number] = [0, 0]) => ({
  id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', mapping: 'standard', connected: true, axes,
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: i === 6 ? triggers[0] : i === 7 ? triggers[1] : (pressed.includes(i) ? 1 : 0) })),
});

// ---- deadzone
check('a stick inside the deadzone is dead', model.stick(0.1, 0.05).join() === '0,0');
check('a drifting stick (0.11) is dead on both axes', model.stick(0.11, 0).join() === '0,0');
check('full push is still 1', Math.abs(model.stick(1, 0)[0] - 1) < 1e-9);
check('a push just past the deadzone starts near 0 (smooth, no jump)', model.stick(0.2, 0)[0] > 0 && model.stick(0.2, 0)[0] < 0.15);
check('the sign is kept', model.stick(-0.8, 0.8)[0] < 0 && model.stick(-0.8, 0.8)[1] > 0);
check('a diagonal never exceeds 1', (() => { const v = model.stick(1, 1); return Math.hypot(v[0], v[1]) <= 1.000001; })());
check('NaN and strings become 0', model.stick(NaN, 'x').join() === '0,0');

// ---- frames
const f = model.frameFromPad(pad([0, 0, 0.6, -0.8], [0, 5, 9, 12], [0.25, 0.75]));
check('right stick and triggers map straight through', Math.abs(f.a[2] - 0.6) < 1e-9 && Math.abs(f.a[3] + 0.8) < 1e-9 && f.tr[0] === 0.25 && f.tr[1] === 0.75);
check('the button mask has A, RB, Menu and dpad up', f.b === ((1 << 0) | (1 << 5) | (1 << 9) | (1 << 12)));
check('the Guide button (16) never enters the mask', model.frameFromPad(pad([0, 0, 0, 0], [16])).b === 0);
check('the trigger buttons (6, 7) are not in the mask', model.frameFromPad(pad([0, 0, 0, 0], [6, 7])).b === 0);
check('a neutral frame is all zeros', JSON.stringify(model.neutralFrame()) === '{"a":[0,0,0,0],"tr":[0,0],"b":0}');
check('startHeld reads the Menu bit', model.startHeld(f) && !model.startHeld(model.neutralFrame()));

// ---- round trip through the server's validator and mapper
const wire = JSON.stringify({ t: 'in', s: 1, a: f.a, tr: f.tr, b: f.b });
const parsed = parseClientMessage(wire, 0);
check('what the page sends passes the server validator', parsed.ok && parsed.msg.t === 'in');
const input = standardFrameToInput(parsed.ok && parsed.msg.t === 'in' ? parsed.msg : { a: [], tr: [], b: 0 });
check('and arrives as the same buttons the machine reads (A, RB, start, dpadUp)', ['A', 'RB', 'start', 'dpadUp'].every((n) => input.buttons[n]) && !input.buttons.B && !input.buttons.X);
check('stick up (-1) arrives as a negative rightStickY (the machine turns that into tilt up)', input.axes.rightStickY < -0.79);
check('triggers arrive as leftTrigger / rightTrigger', input.triggers.leftTrigger === 0.25 && input.triggers.rightTrigger === 0.75);
check('every bit the page can send maps to a button name', model.MASK_BITS.every((bit: number) => {
  const r = parseClientMessage(JSON.stringify({ t: 'in', s: 1, a: [0, 0, 0, 0], tr: [0, 0], b: 1 << bit }), 0);
  return r.ok && r.msg.t === 'in' && Object.values(standardFrameToInput(r.msg).buttons).filter(Boolean).length === 1;
}));

// ---- pad status
check('no pad: press any button', model.padStatus([null, null]).kind === 'none' && /Press any button/.test(model.padStatus([]).text));
check('a standard pad is ok and named', (() => { const s = model.padStatus([pad([0, 0, 0, 0])]); return s.kind === 'ok' && /Xbox Wireless Controller/.test(s.text) && !/Vendor/.test(s.text); })());
check('a pad without the standard mapping is refused and says its mapping', (() => { const p = { ...pad([0, 0, 0, 0]), mapping: '' }; const s = model.padStatus([p]); return s.kind === 'unsupported' && /not recognised/.test(s.text); })());
check('a disconnected pad is ignored', model.padStatus([{ ...pad([0, 0, 0, 0]), connected: false }]).kind === 'none');

// ---- words
check('denied reasons have plain wording', ['disabled', 'desk-active', 'other-remote', 'pin'].every((r) => model.deniedText(r).length > 5) && model.deniedText('weird').length > 5);
check('owner pill: not connected / off / you / desk / other', model.ownerPill(null, false, true).text === 'Not connected' && model.ownerPill({ owner: 'local' }, true, false).text === 'Remote control is off' && model.ownerPill({ owner: 'remote', you: true }, true, true).text === 'You have control' && model.ownerPill({ owner: 'local' }, true, true).text === 'Desk has control' && model.ownerPill({ owner: 'remote', you: false }, true, true).text === 'Another iPad has control');
check('losing control to the desk is explained, a plain release is not', /desk/.test(model.lostText('desk-override')) && model.lostText('release') === null && model.lostText('idle') === null);

const status = { controlledCamera: 'cam2', programCamera: 'cam1', previewCamera: 'cam2', speedPreset: 1, precisionMode: true, health: { rigs: { cam1: { level: 'ready', text: 'Answering' }, cam2: { level: 'down', text: 'Asleep' } } } };
const rows = model.camerasView([{ id: 'cam1', label: 'V-BOT' }, { id: 'cam2', label: 'Center' }, { id: 'cam3', label: 'Far' }], status);
check('camera rows carry controlled / program / preview badges', rows[1].controlled && rows[1].preview && !rows[1].program && rows[0].program && !rows[0].controlled);
check('camera rows carry the health verdict, and none when unknown', rows[0].healthText === 'Answering' && rows[1].healthLevel === 'down' && rows[2].healthText === '');
const rigsPayload = { rigs: [{ id: 'cam1', camera: 'sony-a' }, { id: 'cam2', camera: null }, { id: 'cam3', camera: 'sony-b' }], sonyDevices: [{ key: 'sony-a', sonyCameraId: 'AA:00:00:00:00:01' }, { key: 'sony-b', sonyCameraId: null }] };
check('the preview uses the Sony camera on the controlled rig', model.previewCameraId(rigsPayload, 'cam1') === 'AA:00:00:00:00:01');
check('no preview for a rig without a camera or one not yet bound', model.previewCameraId(rigsPayload, 'cam2') === null && model.previewCameraId(rigsPayload, 'cam3') === null && model.previewCameraId(rigsPayload, 'nope') === null);
check('speed line from status, and from the pushed state when driving', model.speedLine({ presets: [{ name: 'Slow' }, { name: 'Normal' }] }, status, null) === 'Speed: Normal · precision' && model.speedLine(null, status, { speedName: 'Fast', precision: false }) === 'Speed: Fast');

console.log(`remoteUiModel: ${passed} checks passed`);
