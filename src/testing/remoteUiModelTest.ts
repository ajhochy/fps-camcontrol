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

// ---- multiview
const mvStatus = { controlledCamera: 'cam2', programCamera: 'cam1', previewCamera: 'cam2', health: { rigs: { cam1: { level: 'ready', text: 'Answering' }, cam2: { level: 'ready', text: 'Answering' }, cam3: { level: 'down', text: 'Asleep' }, cam4: { level: 'ready', text: 'Answering' } }, cameras: { cam1: { level: 'ready', text: 'Connected' }, cam4: { level: 'down', text: 'Off or Asleep' } } } };
const mvCams = ['cam1', 'cam2', 'cam3', 'cam4'].map((id) => ({ id, label: id.toUpperCase() }));
const mvRigs = { rigs: [{ id: 'cam1', camera: 'a' }, { id: 'cam2', camera: 'a2' }, { id: 'cam3', camera: null }, { id: 'cam4', camera: 'd' }], sonyDevices: [{ key: 'a', sonyCameraId: 'AA:01' }, { key: 'a2', sonyCameraId: 'AA:02' }, { key: 'd', sonyCameraId: 'AA:04' }] };
const plan = model.multiviewPlan(mvCams, mvStatus, mvRigs);
check('PVW pane is the preview camera, PGM pane the program camera', plan.pvw.rigId === 'cam2' && plan.pgm.rigId === 'cam1');
check('small panes are the rigs in rig order', plan.small.map((p: any) => p.rigId).join() === 'cam1,cam2,cam3,cam4');
check('tags: PGM, PVW and CTL land on the right panes', plan.small[0].tags.join() === 'PGM' && plan.small[1].tags.join() === 'PVW,CTL' && plan.small[2].tags.length === 0);
check('tags for a camera that is all three', model.tagsFor('c', { programCamera: 'c', previewCamera: 'c', controlledCamera: 'c' }).join() === 'PGM,PVW,CTL' && model.tagsFor(null, mvStatus).length === 0);
check('a rig without a Sony camera shows its health text, no picture', !plan.small[2].wantsPicture && plan.small[2].healthText === 'Asleep');
check('a Sony camera the tracker calls down shows that text, no picture', !plan.small[3].wantsPicture && plan.small[3].healthText === 'Off or Asleep' && plan.small[3].sonyId === 'AA:04');
check('a healthy rig with a camera wants a picture', plan.small[0].wantsPicture && plan.small[0].sonyId === 'AA:01' && plan.small[1].wantsPicture);
check('a ready rig with no camera says so', model.paneView('x', 'cam2', mvCams, { health: { rigs: { cam2: { level: 'ready', text: 'Answering' } } } }, { rigs: [{ id: 'cam2', camera: null }], sonyDevices: [] }).healthText === 'No camera on this rig');
const noPvw = model.multiviewPlan(mvCams, { ...mvStatus, previewCamera: null }, mvRigs);
check('no preview camera gives an empty pane, not a crash', noPvw.pvw.rigId === null && !noPvw.pvw.wantsPicture);
check('an unknown camera id gives an empty pane that says so', model.paneView('pvw', 'zzz', mvCams, mvStatus, mvRigs).healthText === 'Unknown camera');
const fp = model.framePlan(plan);
check('one frame loop per Sony camera, shared by the big and small pane', fp.ids.slice().sort().join() === 'AA:01,AA:02' && fp.users['AA:01'].join() === 'pgm,cam1' && fp.users['AA:02'].join() === 'pvw,cam2');
check('no loop for panes without a wanted picture', !fp.ids.includes('AA:04'));
const same = model.framePlan(model.multiviewPlan(mvCams, { ...mvStatus, previewCamera: 'cam1' }, mvRigs));
check('PVW and PGM on the same camera still fetch it once', same.ids.filter((i: string) => i === 'AA:01').length === 1 && same.users['AA:01'].length === 3);
check('layout: iPad landscape and phone on its side are wide, phone upright is tall', model.layoutFor(1180, 820) === 'wide' && model.layoutFor(812, 375) === 'wide' && model.layoutFor(375, 812) === 'tall' && model.layoutFor(820, 1180) === 'tall');
check('frame delay: doubles on errors up to 4 s, resets after a good frame', model.nextFrameDelay(200, false) === 400 && model.nextFrameDelay(3000, false) === 4000 && model.nextFrameDelay(4000, true) === 200);

// ---- touch point in a letterboxed picture
const box = { left: 100, top: 50, width: 800, height: 400 }; // 2:1 box
check('a 16:9 picture in a 2:1 box is pillarboxed: the left bar is outside', model.containedPoint(box, 1600, 900, 110, 250) === null);
const mid = model.containedPoint(box, 1600, 900, 500, 250);
check('the centre of the box is the centre of the picture', mid && Math.abs(mid.x - 0.5) < 1e-9 && Math.abs(mid.y - 0.5) < 1e-9 && mid.px === 400 && mid.py === 200);
const tallBox = { left: 0, top: 0, width: 400, height: 800 };
const tall = model.containedPoint(tallBox, 1600, 900, 0, 400);
check('a wide picture in a tall box is letterboxed: left edge is x=0, vertically centred, bars are outside', tall && tall.x === 0 && Math.abs(tall.y - 0.5) < 1e-9 && model.containedPoint(tallBox, 1600, 900, 200, 10) === null);
check('no image yet or an empty box gives null', model.containedPoint(box, 0, 0, 500, 250) === null && model.containedPoint({ left: 0, top: 0, width: 0, height: 0 }, 10, 10, 0, 0) === null);

// ---- gates
check('touch focus and settings need remote control on, not the seat', model.sonyWriteBlock(true) === null && /off/.test(model.sonyWriteBlock(false)) && model.sonyWriteBlock(null) !== null);
check('selecting a camera needs the seat: "Take control first"', model.selectBlock(true, { owner: 'remote', you: true }) === null && model.selectBlock(true, { owner: 'local' }) === 'Take control first' && model.selectBlock(true, { owner: 'remote', you: false }) === 'Take control first' && /off/.test(model.selectBlock(false, null)));

// ---- settings
check('sonyReported reads hex strings, numbers and decimal strings', model.sonyReported({ data: { value: '0x1F' } }) === 31 && model.sonyReported({ current_value: 7 }) === 7 && model.sonyReported({ value: '12' }) === 12 && model.sonyReported({ value: 'f/2.8' }) === null && model.sonyReported(null) === null);
const prop = { current_value: 5, current_formatted: 'f/2.8', writable: true, available_values: [{ value: 5, hex_value: '0x5', formatted: 'f/2.8' }, { value: 6, hex_value: '0x6', formatted: 'f/4' }] };
const pv = model.propertyView('aperture', prop, undefined);
check('a writable setting is a select with the hex to send, current selected', pv.kind === 'select' && pv.selected === 5 && model.sendValue(pv.options[1]) === '0x6' && pv.label === 'Aperture');
check('a pending choice wins over the camera value until it is reported', model.propertyView('aperture', prop, 6).selected === 6);
check('a setting with nothing to pick is read-only and shows its value', (() => { const r = model.propertyView('aperture', { current_formatted: 'f/1.8', available_values: [] }, undefined); return r.kind === 'readonly' && r.text === 'f/1.8 (read-only)'; })());
check('a setting the camera does not report is unavailable; writable:false is read-only too', model.propertyView('iso', null, undefined).kind === 'unavailable' && model.propertyView('iso', { ...prop, writable: false }, undefined).kind === 'readonly');
check('without a hex value the plain value is sent', model.sendValue({ value: 9, hex: null }) === 9);
check('battery and overheat wording', model.batteryInfo({ battery: { percent: 82 } }).text === 'Battery 82%' && model.batteryInfo({ battery: { percent: 15 }, overheat: { state: 'pre' } }).text === 'Battery 15% · Getting hot' && model.batteryInfo({ battery: { percent: 90 }, overheat: { state: 'over' } }).level === 'down' && model.batteryInfo({}).text === 'Battery unknown' && model.batteryInfo({ battery: { percent: 50, stale: true } }).level === 'idle');
check('Sony status entries match case-insensitively', model.sonyCameraEntry({ cameras: [{ id: 'aa:01', x: 1 }] }, 'AA:01')?.x === 1 && model.sonyCameraEntry(null, 'AA:01') === null);

console.log(`remoteUiModel: ${passed} checks passed`);
