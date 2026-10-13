import assert from 'assert';
import path from 'path';
import pino from 'pino';

/**
 * Choosing which Bluetooth gimbal a rig's Pi bridge drives (bridge 0.6.0: GET /gimbals, POST /gimbal, and the
 * `bluetooth` block in hello/status/info). One Pi per gimbal, but every Pi hears every DJI gimbal in the room and a
 * gimbal takes one connection, so: the app proxies (the browser never talks to a Pi), never sends a body (the
 * bridge's websockets parser refuses one), names an older bridge as such, and the Rigs screen shows which gimbal is
 * in use, marks the strongest, and asks before a switch. Run: node dist/testing/bluetoothGimbalTest.js
 */
// Stand in for ../index (which would start the whole app) so only the device and a virtual bridge run.
const indexPath = require.resolve('../index');
require.cache[indexPath] = { id: indexPath, filename: indexPath, loaded: true, exports: { logger: pino({ level: 'silent' }) } } as any;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { VirtualDjiBridge } = require('./virtualDjiBridge');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DjiBridgeDevice } = require('../devices/djiBridgeDevice');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createInitialState, trackDeviceLinkState } = require('../app/state');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fetchBluetoothGimbals, selectBluetoothGimbal, parseBluetoothGimbal, normalizeBluetoothAddress } = require('../devices/gimbalScan');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildRigs } = require('../config/rigs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveProfile } = require('../config/configLoader');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const model = require(path.resolve(__dirname, '../../ui/rigs/rigsModel.js'));

let passed = 0;
const check = (name: string, condition: boolean): void => { assert.ok(condition, `FAILED ${name}`); passed++; };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const TRIPOD = '48:1C:B9:54:C6:BC';
const FAR_RIGHT = '34:D2:62:15:A5:47';
const room = [
  { address: TRIPOD, name: 'DJI RS3 PRO-0614BW', rssi: -48 },
  { address: FAR_RIGHT, name: 'DJI RS3-06UH13', rssi: -79 },
  { address: '11:22:33:44:55:66', name: 'iPhone', rssi: -30 },
];

async function main(): Promise<void> {
  // ---- parsing
  check('addresses are normalised; junk is refused', normalizeBluetoothAddress(' 48-1c-b9-54-c6-bc ') === TRIPOD && normalizeBluetoothAddress('auto') === null && normalizeBluetoothAddress(7) === null);
  check('a missing bluetooth block (bridge < 0.6.0) parses to null', parseBluetoothGimbal(undefined) === null && parseBluetoothGimbal([]) === null);
  const parsed = parseBluetoothGimbal({ address: TRIPOD.toLowerCase(), name: 'DJI RS3 PRO-0614BW', rssi: -48, mode: 'fixed', chosenBy: 'operator', saved: true, connected: true, switching: 'yes', error: 5 });
  check('a bluetooth block is read defensively', parsed.address === TRIPOD && parsed.rssi === -48 && parsed.mode === 'fixed' && parsed.switching === false && parsed.error === null);

  // ---- the proxy helpers against a fake 0.6.0 bridge
  const bridge = new VirtualDjiBridge({ port: 0, gimbalAddress: FAR_RIGHT, nearby: room, statusIntervalMs: 100 });
  const old = new VirtualDjiBridge({ port: 0, gimbalSelect: false });
  const port = await bridge.start();
  const oldPort = await old.start();
  try {
    const quiet = await fetchBluetoothGimbals('127.0.0.1', port, false);
    check('GET /gimbals without scan leaves a linked gimbal alone', quiet.ok && quiet.body.scanned === false && bridge.scans === 0);
    check('the linked gimbal is listed even though it does not advertise', quiet.ok && quiet.body.gimbals.length === 1 && quiet.body.gimbals[0].address === FAR_RIGHT && quiet.body.gimbals[0].connected === true && quiet.body.gimbals[0].advertising === false);
    const scanned = await fetchBluetoothGimbals('127.0.0.1', port, true);
    check('GET /gimbals?scan=1 lists the DJI gimbals heard, never the phone', scanned.ok && scanned.body.scanned && scanned.body.gimbals.map((g: any) => g.address).sort().join() === [FAR_RIGHT, TRIPOD].sort().join());
    check('the strongest is marked', scanned.ok && scanned.body.gimbals.find((g: any) => g.strongest)?.address === TRIPOD);
    check('listing opens no control session (a session end makes the bridge stop its gimbal)', bridge.sessionsOpened === 0);

    const switched = await selectBluetoothGimbal('127.0.0.1', port, TRIPOD);
    check('POST /gimbal switches the bridge and reports the new gimbal', switched.ok && switched.body.selected?.address === TRIPOD && bridge.switches.join() === TRIPOD);
    const bad = await selectBluetoothGimbal('127.0.0.1', port, 'nonsense');
    check('a bad address comes back as the bridge’s own 400', !bad.ok && bad.status === 400 && /Bluetooth address/.test(bad.error));
    const auto = await selectBluetoothGimbal('127.0.0.1', port, 'auto');
    check('"auto" takes the strongest DJI gimbal', auto.ok && auto.body.selected?.address === TRIPOD && auto.body.selected?.chosenBy === 'auto-strongest');

    const oldList = await fetchBluetoothGimbals('127.0.0.1', oldPort, false);
    check('an older bridge is named as needing an update, not as broken', !oldList.ok && oldList.status === 501 && /0\.6\.0/.test(oldList.error));
    const oldSelect = await selectBluetoothGimbal('127.0.0.1', oldPort, TRIPOD);
    check('an older bridge cannot be switched and says why', !oldSelect.ok && oldSelect.status === 501);
    const closed = await fetchBluetoothGimbals('127.0.0.1', 1, false, 1000);
    check('an unreachable bridge is a 504 with a reason', !closed.ok && closed.status === 504);
  } finally {
    await bridge.stop();
    await old.stop();
  }

  // ---- device -> state -> rig view
  const live = new VirtualDjiBridge({ port: 0, gimbalAddress: TRIPOD, nearby: room, statusIntervalMs: 100 });
  const livePort = await live.start();
  const device = new DjiBridgeDevice({ host: '127.0.0.1', port: livePort, safetyTimeoutMs: 250, reconnectBackoffMs: [100], rollEnabled: false }, 'cam3', 'Tripod');
  const state = createInitialState({} as never);
  trackDeviceLinkState(state, 'cam3', device);
  device.connect();
  try {
    await wait(500);
    check('the device reads which Bluetooth gimbal its bridge drives', device.bluetoothGimbal?.address === TRIPOD && device.bluetoothGimbal?.name === 'DJI RS3 PRO-0614BW');
    check('it lands in the app state', state.cameraGimbalBluetooth?.cam3?.address === TRIPOD);
    check('the device knows its bridge address for the proxy', device.bridgeAddress.port === livePort);
    await selectBluetoothGimbal('127.0.0.1', livePort, FAR_RIGHT);
    await wait(500);
    check('a switch shows up through status without reconnecting the app', state.cameraGimbalBluetooth?.cam3?.address === FAR_RIGHT && state.cameraGimbalBluetooth?.cam3?.chosenBy === 'operator');
    await selectBluetoothGimbal('127.0.0.1', livePort, TRIPOD);
    await wait(500);
    check('and a switch back shows up too', state.cameraGimbalBluetooth?.cam3?.address === TRIPOD);
    // Gimbal battery (passive 0x0d/0x02 report, passed on in status).
    check('no battery is shown before the gimbal reports one', device.battery === null && !state.cameraGimbalBattery?.cam3);
    live.battery = 23;
    await wait(400);
    check('the gimbal battery lands in the app state', device.battery?.percent === 23 && state.cameraGimbalBattery?.cam3?.percent === 23);
    live.battery = 250;
    await wait(400);
    check('a battery value outside 0..100 is dropped, not shown', device.battery === null && !state.cameraGimbalBattery?.cam3);
    live.battery = 23;
    await wait(400);
    await selectBluetoothGimbal('127.0.0.1', livePort, FAR_RIGHT);
    await wait(500);

    const devices = {
      tripod: { label: 'Tripod', protocol: 'dji-bridge', cameraType: 'generic', viscaPort: 52381, cameraAddress: 1, speedScale: 1, bridge: { host: '127.0.0.1', port: livePort, gimbalModel: 'RS3', safetyTimeoutMs: 250, reconnectBackoffMs: [1000], rollEnabled: false } },
    };
    const profiles = { production: { label: 'Production', slots: [{ device: 'tripod', inputId: 3 }] } };
    const cfg = { atem: { ip: '1.2.3.4', defaultTransition: 'cut', meIndex: 0 }, cameras: resolveProfile(devices, profiles.production), graphics: { type: 'dsk', dskIndex: 0, uskIndex: 0, meIndex: 0, fadeFrames: 15 }, speeds: {}, mappings: { selectCam1: 'X' }, devices, profiles, activeProfile: 'production' };
    const camId = cfg.cameras[0].id;
    state.cameraGimbalBluetooth[camId] = state.cameraGimbalBluetooth.cam3;
    state.cameraBridgeReachable[camId] = true;
    const data = { ...buildRigs(cfg, state, 'v1', []), atemConnected: false, sony: null };
    const rig = data.rigs[0];
    check('the rig view carries the bluetooth gimbal', rig.live.bluetooth?.address === FAR_RIGHT);
    state.cameraGimbalBattery[camId] = { percent: 23, ageS: 0 };
    const withBattery = { ...buildRigs(cfg, state, 'v1', []), atemConnected: false, sony: null };
    const batteryLine = model.statusFor(withBattery, 'rig:tripod').lines.find((l: any) => l.label === 'Gimbal battery');
    check('Device Config shows "Gimbal battery 23%" as a warning (20-39%)', withBattery.rigs[0].live.battery?.percent === 23 && batteryLine?.value === '23%' && batteryLine?.tone === 'warn');
    state.cameraGimbalBattery[camId] = { percent: 64, ageS: 0 };
    check('64% is ok', model.statusFor({ ...buildRigs(cfg, state, 'v1', []), atemConnected: false, sony: null }, 'rig:tripod').lines.find((l: any) => l.label === 'Gimbal battery')?.tone === 'ok');
    state.cameraGimbalBattery[camId] = { percent: 12, ageS: 0 };
    const low = model.statusFor({ ...buildRigs(cfg, state, 'v1', []), atemConnected: false, sony: null }, 'rig:tripod').lines.find((l: any) => l.label === 'Gimbal battery');
    check('12% is an error with what to do', low?.tone === 'bad' && /charge or swap/.test(low?.value));
    const status = model.statusFor(data, 'rig:tripod');
    const line = status.lines.find((l: any) => l.label === 'Bluetooth gimbal on this bridge');
    check('status names the gimbal on this bridge: name (address)', !!line && line.value.indexOf('DJI RS3-06UH13 (' + FAR_RIGHT + ')') === 0 && /chosen here/.test(line.value));
    const chooser = status.actions.find((a: any) => a.kind === 'bluetooth-chooser');
    check('a gimbal rig offers "Choose gimbal…" through the app, never the Pi directly', !!chooser && chooser.label === 'Choose gimbal…' && chooser.url === '/api/rigs/tripod/bluetooth-gimbals' && chooser.selectUrl === '/api/rigs/tripod/bluetooth-gimbal');
  } finally {
    device.close();
    await live.stop();
  }

  // ---- the Rigs screen's pure logic
  const rigOf = (bluetooth: unknown, bridgeReachable = true) => ({ gimbal: { host: 'x', port: 7878 }, live: { connected: true, bridgeReachable, bluetooth } });
  check('an older bridge says so', /older than 0\.6\.0/.test(model.bluetoothLine(rigOf(undefined)).value));
  check('an unreachable bridge is unknown, not wrong', /not reachable/.test(model.bluetoothLine(rigOf(undefined, false)).value));
  check('nothing chosen yet says the bridge will take the strongest', /strongest/.test(model.bluetoothLine(rigOf({ address: null, mode: 'auto' })).value) && model.bluetoothLine(rigOf({ address: null, mode: 'auto' })).tone === 'warn');
  const notLinked = model.bluetoothLine(rigOf({ address: TRIPOD, name: 'DJI RS3 PRO-0614BW', rssi: -60, chosenBy: 'auto-strongest', saved: false, connected: false, error: 'not advertising' }));
  check('a chosen but unlinked gimbal warns, with the signal, the reason and that it is not saved', notLinked.tone === 'warn' && /signal -60 dBm/.test(notLinked.value) && /not linked: not advertising/.test(notLinked.value) && /not saved/.test(notLinked.value));
  const choices = model.bluetoothChoices({
    scanned: true, note: 'Scanned just now.', gimbals: [
      { address: FAR_RIGHT, name: 'DJI RS3-06UH13', rssi: -79, advertising: true, selected: false, connected: false, strongest: false },
      { address: '48:1C:B9:56:31:95', name: null, rssi: null, advertising: false, selected: true, connected: true, strongest: false },
      { address: TRIPOD, name: 'DJI RS3 PRO-0614BW', rssi: -48, advertising: true, selected: false, connected: false, strongest: true },
    ],
  });
  check('the gimbal in use is listed first, then strongest signal first', choices.rows.map((r: any) => r.address).join() === ['48:1C:B9:56:31:95', TRIPOD, FAR_RIGHT].join());
  check('the gimbal in use cannot be chosen again', choices.rows[0].choosable === false && choices.rows[0].actionLabel === 'In use');
  check('the strongest is marked "strongest", with its RSSI', choices.rows[1].chips.some((c: any) => c.text === 'strongest') && /-48 dBm/.test(choices.rows[1].detail));
  check('the list reminds that strongest is not always right', choices.notes.some((n: string) => /not always/.test(n)));
  const linkedElsewhere = model.bluetoothChoices({ scanned: false, gimbals: [{ address: TRIPOD, name: 'x', rssi: null, advertising: false, selected: false, connected: false, strongest: false }] });
  check('a gimbal that is not advertising is flagged as probably linked to another Pi', linkedElsewhere.rows[0].chips.some((c: any) => /another Pi/.test(c.text)));
  const question = model.bluetoothSwitchQuestion('Tripod', rigOf({ address: '48:1C:B9:56:31:95', name: 'DJI RS3 PRO-0613YW' }), choices.rows[1]);
  check('the switch question names both gimbals and says the camera stops and the link is cut', /from DJI RS3 PRO-0613YW \(48:1C:B9:56:31:95\) to DJI RS3 PRO-0614BW \(48:1C:B9:54:C6:BC\)/.test(question) && /stops/.test(question) && /cut/.test(question));
  check('"use the strongest" is asked about too', /strongest DJI gimbal/.test(model.bluetoothSwitchQuestion('Tripod', rigOf(null), 'auto')));

  console.log(`bluetooth gimbal: ${passed} checks passed`);
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
