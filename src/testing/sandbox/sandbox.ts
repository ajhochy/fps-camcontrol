import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { FakeSonySidecar } from './fakeSonySidecar';
import { FakeViscaCamera } from './fakeViscaCamera';
import { VirtualDjiBridge } from '../virtualDjiBridge';

/**
 * Sandbox: a second, isolated copy of CamControl wired to fakes.
 *
 *   pnpm sandbox            run it (Ctrl+C stops everything)       -> http://127.0.0.1:8090
 *   pnpm sandbox:check      start it, exercise Sony connect / pairing / power-off, stop, exit 0 or 1
 *   pnpm test:smoke:isolated  the full smoke suite against sandbox config, without touching the live app
 *
 * Nothing here touches the live app, config/, the real ATEM, cameras, gimbals or controller:
 * the config is a throwaway copy in sandbox/.run/, every address is a fake on 127.0.0.1, the
 * controller is never opened (CAMCONTROL_NO_CONTROLLER=1), and all ports differ from the live ones.
 */

const root = path.resolve(__dirname, '../../..');
const runDir = path.join(root, 'sandbox', '.run');
const APP_PORT = Number(process.env.SANDBOX_PORT ?? 8090);
const SONY_PORT = 8191;
const VISCA_PORTS = [52391, 52392, 52393];
const DJI_PORTS = [17878, 17879, 17880];

const CAMERAS = [
  { id: 'AA:00:00:00:00:01', model: 'ILCE-7SM3', powered: true },
  // Like the real FX3A over Wi-Fi: refuses to connect until pairing mode is opened, aperture set by the lens.
  { id: 'AA:00:00:00:00:02', model: 'ILME-FX3A', powered: true, needsPairing: true, readOnlyAperture: true },
  { id: 'AA:00:00:00:00:03', model: 'ILCE-7SM3', powered: false },
  { id: 'AA:00:00:00:00:04', model: 'ILCE-7M4', powered: false },
];

function prepareRunDir(): void {
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });
  for (const name of ['devices.yaml', 'mappings.yaml', 'speeds.json', 'presets.json']) {
    fs.copyFileSync(path.join(root, 'sandbox', 'config', name), path.join(runDir, name));
  }
}

function sandboxEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DEVICES_CONFIG: path.join(runDir, 'devices.yaml'),
    MAPPINGS_FILE: path.join(runDir, 'mappings.yaml'),
    SPEEDS_FILE: path.join(runDir, 'speeds.json'),
    PRESETS_FILE: path.join(runDir, 'presets.json'),
    SONY_STATE_FILE: path.join(runDir, 'sony-cameras.json'),
    SONY_API_URL: `http://127.0.0.1:${SONY_PORT}`,
    STATUS_PORT: String(APP_PORT),
    CAMCONTROL_NO_CONTROLLER: '1',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
    ...extra,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function startFakes(scanDelayMs: number): Promise<{ sony: FakeSonySidecar; stop: () => Promise<void> }> {
  const visca = VISCA_PORTS.map((port, i) => new FakeViscaCamera(port, `visca-${i + 1}`));
  await Promise.all(visca.map((camera) => camera.start()));
  const bridges = DJI_PORTS.map((port) => new VirtualDjiBridge({ port, statusIntervalMs: 500, safetyTimeoutMs: 250 }));
  await Promise.all(bridges.map((bridge) => bridge.start()));
  const sony = new FakeSonySidecar(CAMERAS, { scanDelayMs });
  await sony.start(SONY_PORT);
  return {
    sony,
    stop: async () => {
      await sony.stop();
      await Promise.all(bridges.map((bridge) => bridge.stop()));
      await Promise.all(visca.map((camera) => camera.stop()));
    },
  };
}

function startApp(): ChildProcess {
  const logFile = fs.openSync(path.join(runDir, 'app.log'), 'a');
  return spawn(process.execPath, [path.join(root, 'dist', 'index.js')], {
    cwd: root, env: sandboxEnv(), stdio: ['ignore', logFile, logFile],
  });
}

async function waitFor<T>(label: string, read: () => Promise<T | undefined | false | null>, timeoutMs = 30000, intervalMs = 400): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { const value = await read(); if (value) return value; } catch { /* keep polling */ }
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await sleep(intervalMs);
  }
}

// ------------------------------------------------------------------ self test

async function selfTest(): Promise<number> {
  prepareRunDir();
  const fakes = await startFakes(0);
  const app = startApp();
  const base = `http://127.0.0.1:${APP_PORT}`;
  const control = `http://127.0.0.1:${SONY_PORT}/__sandbox`;
  const results: { name: string; ok: boolean; detail?: string }[] = [];
  const check = (name: string, ok: boolean, detail?: string): void => {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? '✓' : '✗ FAIL:'} ${name}${!ok && detail ? ` (${detail})` : ''}`);
  };
  const api = async (p: string, init?: RequestInit): Promise<{ status: number; body: any; type: string }> => {
    const response = await fetch(base + p, init);
    const type = response.headers.get('content-type') ?? '';
    const text = await response.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body, type };
  };
  const post = (p: string, body?: unknown) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const patch = (p: string, body: unknown) => api(p, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const del = (p: string) => api(p, { method: 'DELETE' });
  const delWith = (p: string, body: unknown) => api(p, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const put = (p: string, body: unknown) => api(p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const ctl = async (p: string, body: unknown): Promise<void> => { await fetch(control + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); };
  const cameraState = async (id: string): Promise<string | undefined> => (await api('/api/sony/status')).body.cameras?.find((c: any) => c.id === id)?.state;
  const A = 'AA:00:00:00:00:01';
  const B = 'AA:00:00:00:00:02';
  const D = 'AA:00:00:00:00:04';

  console.log('Sandbox self-test');
  try {
    await waitFor('the app to answer', async () => (await api('/api/status')).status === 200, 40000);
    check('the sandbox app starts and answers', true);

    const sidecar = await waitFor('the Sony service to be healthy', async () => { const s = (await api('/api/sony/status')).body.sidecar; return s?.state === 'healthy' && s; });
    check('the fake Sony service is adopted as healthy and external', sidecar.mode === 'external');

    await waitFor('two cameras discovered', async () => { const c = (await api('/api/sony/status')).body.cameras ?? []; return c.length >= 2; });
    const status = (await api('/api/sony/status')).body;
    check('both powered-on cameras are discovered, not yet approved', status.cameras.length === 2 && status.cameras.every((c: any) => c.state === 'discovered_unapproved'));
    check('a bound Sony device gives the camera its name', status.cameras.find((c: any) => c.id === A)?.name === 'a7S III — stage left');

    const rigs = (await api('/api/rigs')).body;
    const pageHtml = await (await fetch(`${base}/`)).text();
    check('the Rigs tab and its script files are on the page', pageHtml.includes('id="tab-btn-rigs"') && pageHtml.includes('/ui/rigs/rigs.js'));
    check('the rigs screen files are served', (await fetch(`${base}/ui/rigs/rigs.js`)).status === 200 && (await fetch(`${base}/ui/rigs/rigsModel.js`)).status === 200 && (await fetch(`${base}/ui/rigs/rigs.css`)).status === 200);
    check('GET /api/rigs reports the ATEM as not connected (none in the sandbox)', (await api('/api/rigs')).body.atemConnected === false);
    check('GET /api/rigs lists the four rigs of the production profile', rigs.rigs?.length === 4 && rigs.activeProfile === 'production');
    check('the V-BOT rig has its Sony camera assigned', rigs.rigs?.[0]?.camera === 'sony-stage-left' && rigs.rigs?.[0]?.cameraLabel === 'a7S III — stage left');
    check('BirdDog rigs report a built-in camera', rigs.rigs?.[1]?.builtInCamera === true && rigs.rigs?.[1]?.camera === null);
    check('the unbound Sony device is listed as not bound', rigs.sonyDevices?.find((d: any) => d.key === 'sony-unbound')?.sonyCameraId === null);

    const allLinked = await waitFor('every rig reports its controller connected', async () => {
      const r = (await api('/api/rigs')).body.rigs ?? [];
      return r.length === 4 && r.every((rig: any) => rig.live.connected === true) && r;
    }, 30000).catch(() => undefined);
    check('VISCA and gimbal rigs connect to their fakes', !!allLinked);


    // --- rig edits: hardware records save immediately, are validated, keep the file documented
    const yamlFile = path.join(runDir, 'devices.yaml');
    const commentCount = (): number => fs.readFileSync(yamlFile, 'utf8').split('\n').filter((line) => line.includes('#')).length;
    const commentsBefore = commentCount();
    const version0 = (await api('/api/rigs')).body.version;
    const renamed = await patch('/api/rigs/vbot', { label: 'V-BOT main', speedScale: 3 });
    check('PATCH /api/rigs/:key renames a rig and answers with the new rig view', renamed.status === 200 && renamed.body.ok === true && renamed.body.rigs?.[0]?.label === 'V-BOT main');
    const liveConfig = (await api('/api/config')).body;
    check('the edit is applied to the running app at once', liveConfig.cameras?.[0]?.label === 'V-BOT main' && liveConfig.cameras?.[0]?.speedScale === 3);
    check('the edit is on disk and every comment is still there', fs.readFileSync(yamlFile, 'utf8').includes('V-BOT main') && commentCount() === commentsBefore);
    check('the edit keeps the gimbal a gimbal and the file free of a stray cameras: list', !/^cameras:/m.test(fs.readFileSync(yamlFile, 'utf8')) && /protocol: "?dji-bridge"?/.test(fs.readFileSync(yamlFile, 'utf8')));
    check('a rig edit answers 400 for a protocol change', (await patch('/api/rigs/rs3', { protocol: 'visca' })).status === 400);
    check('a rig edit answers 404 for an unknown device', (await patch('/api/rigs/ghost', { label: 'x' })).status === 404);
    check('a rig edit refuses an ATEM input another rig uses', (await patch('/api/rigs/birddog1', { inputId: 6 })).status === 400);
    check('a rig edit refuses a Sony camera on a BirdDog rig', (await patch('/api/rigs/birddog1', { camera: 'sony-spare' })).status === 400);
    check('a rig edit refuses wiring for a device outside the active profile', (await patch('/api/rigs/rs3pro-a', { inputId: 3 })).status === 400);
    check('a refused edit changes nothing on disk', commentCount() === commentsBefore && !fs.readFileSync(yamlFile, 'utf8').includes('inputId: 3\n      - { device: rs3pro-a'));
    const stale = await patch('/api/rigs/vbot', { label: 'too late', expectedVersion: version0 });
    check('an edit based on an old file version answers 409 conflict', stale.status === 409 && stale.body.conflict === true);
    const fresh = (await api('/api/rigs')).body.version;
    check('an edit with the current version goes through', (await patch('/api/rigs/vbot', { label: 'V-BOT', expectedVersion: fresh })).status === 200);

    // --- the ATEM: connection and graphics settings
    const atemBefore = (await api('/api/rigs')).body.atem;
    const atemEdit = await patch('/api/atem', { defaultTransition: 'auto', graphics: { fadeFrames: 25 } });
    check('PATCH /api/atem changes the default transition and graphics and answers with the new view', atemEdit.status === 200 && atemEdit.body.atem?.defaultTransition === 'auto' && atemEdit.body.graphics?.fadeFrames === 25);
    check('the ATEM edit is applied to the running app and saved with the file still documented', (await api('/api/config')).body.atem?.defaultTransition === 'auto' && /defaultTransition: auto/.test(fs.readFileSync(yamlFile, 'utf8')) && commentCount() === commentsBefore);
    check('an ATEM mix/effect index outside 0-3 is refused (400)', (await patch('/api/atem', { meIndex: 9 })).status === 400);
    check('an unknown ATEM field is refused (400)', (await patch('/api/atem', { firmware: '9' })).status === 400);
    check('an ATEM edit based on an old file version answers 409', (await patch('/api/atem', { meIndex: 1, expectedVersion: version0 })).status === 409);
    check('the ATEM settings can be put back', (await patch('/api/atem', { defaultTransition: atemBefore.defaultTransition, graphics: { fadeFrames: 15 } })).status === 200);

    // --- Sony camera devices: create, name, bind, delete
    const madeSony = await post('/api/sony-devices', { label: 'Backup FX3' });
    check('POST /api/sony-devices creates a named Sony device (201) with a key made from the name', madeSony.status === 201 && madeSony.body.key === 'sony-backup-fx3');
    check('the new device is listed and not bound to a camera yet', madeSony.body.sonyDevices?.find((d: any) => d.key === 'sony-backup-fx3')?.sonyCameraId === null);
    check('a Sony device in use cannot be deleted (409)', (await del('/api/sony-devices/sony-stage-left')).status === 409);
    check('a Sony device can be renamed', (await patch('/api/sony-devices/sony-backup-fx3', { label: 'Backup FX3 (truck)' })).body.sonyDevices?.find((d: any) => d.key === 'sony-backup-fx3')?.label === 'Backup FX3 (truck)');
    check('giving a camera id another device has is refused (400)', (await patch('/api/sony-devices/sony-backup-fx3', { sonyCameraId: 'aa:00:00:00:00:01' })).status === 400);

    // --- connect the a7S III through the app
    check('connecting the a7S III through the app succeeds', (await post(`/api/sony/cameras/${A}/connect`)).status === 200);
    check('the a7S III shows connected', (await cameraState(A)) === 'connected');
    const props = await api(`/api/sony/cameras/${A}/properties`);
    const aperture = props.body?.data?.properties?.aperture;
    check('the a7S III reports a writable aperture with 23 options', aperture?.writable === true && aperture?.available_values?.length === 23);
    check('a setting can be changed with the hex value the dashboard sends', (await put(`/api/sony/cameras/${A}/properties/aperture`, { value: '0x190' })).status === 200);
    const after = (await api(`/api/sony/cameras/${A}/properties`)).body?.data?.properties?.aperture;
    check('the camera now reports F4', after?.current_formatted === 'F4');
    check('a raw number is refused, as the real service does', (await put(`/api/sony/cameras/${A}/properties/aperture`, { value: 250 })).status === 400);
    const frame = await api(`/api/sony/cameras/${A}/live-view/frame`);
    check('a live-view frame comes back as an image', frame.status === 200 && frame.type.startsWith('image/'));

    // --- the FX3A needs pairing
    const refused = await post(`/api/sony/cameras/${B}/connect`);
    check('the FX3A refuses to connect until pairing mode is opened', refused.status !== 200);
    check('the FX3A shows a connection error', (await cameraState(B)) === 'error');
    await ctl(`/cameras/${B}/pairing`, { open: true });
    await post(`/api/sony/cameras/${B}/retry`);
    await waitFor('the FX3A to connect after pairing', async () => (await cameraState(B)) === 'connected', 20000);
    check('the FX3A connects once pairing mode is open', true);
    const fxAperture = (await api(`/api/sony/cameras/${B}/properties`)).body?.data?.properties?.aperture;
    check('the FX3A aperture is read-only with no options', fxAperture?.writable === false && fxAperture?.available_values?.length === 0);

    // --- power loss and recovery
    await ctl(`/cameras/${A}/power`, { on: false });
    await waitFor('the a7S III to show disconnected after power-off', async () => (await cameraState(A)) === 'disconnected', 25000);
    check('a powered-off camera stops showing connected', true);
    await ctl(`/cameras/${A}/power`, { on: true });
    await waitFor('the a7S III to reconnect by itself', async () => (await cameraState(A)) === 'connected', 70000, 1000);
    check('an approved camera reconnects by itself when power returns', true);

    // --- a new camera appears that no Sony device is bound to
    await ctl(`/cameras/${D}/power`, { on: true });
    await post('/api/sony/cameras/discover');
    const unbound = await waitFor('the new camera to be listed as unbound', async () => {
      const r = (await api('/api/rigs')).body;
      return r.unboundCameras?.find((c: any) => c.id === D) && r;
    }, 15000);
    check('a newly powered camera with no device appears in unboundCameras', !!unbound);
    const bound = await patch('/api/sony-devices/sony-backup-fx3', { sonyCameraId: D });
    check('binding a discovered camera to a Sony device removes it from unboundCameras', bound.status === 200 && !bound.body.unboundCameras?.some((c: any) => c.id === D));
    const named = (await api('/api/sony/status')).body.cameras?.find((c: any) => c.id === D);
    check('the bound camera shows the name the operator gave it', named?.name === 'Backup FX3 (truck)');
    check('an unused Sony device can be deleted', (await del('/api/sony-devices/sony-backup-fx3')).status === 200);
    check('the file is still fully documented after all the edits', commentCount() === commentsBefore);

    // --- add and remove rigs; presets follow their camera
    const added = await post('/api/rigs', { label: 'Sandbox gimbal', controller: 'gimbal', gimbal: { host: '127.0.0.1', port: 17880 }, inputId: 12 });
    check('POST /api/rigs adds a rig at the end (201) and answers with the new rig view', added.status === 201 && added.body.position === 5 && added.body.key === 'sandbox-gimbal' && added.body.rigs?.length === 5);
    check('the new rig is applied to the running app', (await api('/api/config')).body.cameras?.length === 5);
    check('the new rig is on disk and the file is still documented', fs.readFileSync(yamlFile, 'utf8').includes('sandbox-gimbal') && commentCount() === commentsBefore);
    check('adding a rig on an ATEM input another rig uses is refused (400)', (await post('/api/rigs', { label: 'Clash', controller: 'vbot', visca: { host: '127.0.0.1' }, inputId: 12 })).status === 400);
    const askLast = await delWith('/api/rigs/sandbox-gimbal', {});
    check('removing a rig without confirmation answers 409 with what would change, and changes nothing', askLast.status === 409 && askLast.body.confirmationRequired === true && askLast.body.impact?.shifted?.length === 0 && (await api('/api/config')).body.cameras?.length === 5);
    const removedLast = await delWith('/api/rigs/sandbox-gimbal', { confirm: true, deleteDevice: true });
    check('removing the last rig with confirmation works and can delete its hardware entry', removedLast.status === 200 && removedLast.body.rigs?.length === 4 && !fs.readFileSync(yamlFile, 'utf8').includes('sandbox-gimbal'));

    const askMiddle = await delWith('/api/rigs/birddog1', {});
    const impact = askMiddle.body.impact;
    check('removing a middle rig asks first and lists the presets it loses and the rigs that move', askMiddle.status === 409 && impact?.presetsLost?.join() === 'A' && impact?.shifted?.length === 2);
    check('the impact says which rig takes which camera id and hotkey', impact?.shifted?.[1]?.label === 'DJI RS3' && impact?.shifted?.[1]?.fromId === 'cam4' && impact?.shifted?.[1]?.toId === 'cam3' && impact?.shifted?.[1]?.fromHotkey === 'Y' && impact?.shifted?.[1]?.toHotkey === 'B');
    check('nothing changed while the answer was only a question', (await api('/api/config')).body.cameras?.length === 4 && (await api('/api/presets')).body.cam2?.A !== null);
    const removedMiddle = await delWith('/api/rigs/birddog1', { confirm: true });
    check('removing the middle rig with confirmation works', removedMiddle.status === 200 && removedMiddle.body.rigs?.map((r: any) => r.deviceKey).join() === 'vbot,birddog2,rs3');
    const presetsNow = (await api('/api/presets')).body;
    check('presets moved with their cameras (old cam3 is now cam2, old cam4 is now cam3)', presetsNow.cam2?.X?.pan === 300 && presetsNow.cam3?.Y?.yaw === 12 && presetsNow.cam2?.A === null);
    check('the last camera id is gone from the presets', presetsNow.cam4 === undefined);
    const presetFile = JSON.parse(fs.readFileSync(path.join(runDir, 'presets.json'), 'utf8'));
    check('the shifted presets are saved to disk', presetFile.cam2?.X?.pan === 300 && presetFile.cam4 === undefined);
    check('the running app has three rigs with new ids', (await api('/api/config')).body.cameras?.map((c: any) => c.id).join() === 'cam1,cam2,cam3');
    check('the rig that moved up carries its new hotkey', removedMiddle.body.rigs?.[2]?.id === 'cam3' && removedMiddle.body.rigs?.[2]?.hotkey === 'B');
    check('the removed rig\'s hardware entry is still in the file (it can be added back)', fs.readFileSync(yamlFile, 'utf8').includes('birddog1:'));
    const readded = await post('/api/rigs', { deviceKey: 'birddog1', inputId: 7 });
    check('an existing device can be added back as a new rig', readded.status === 201 && readded.body.position === 4 && readded.body.rigs?.[3]?.deviceKey === 'birddog1');
    check('the last rig of a profile cannot be removed', await (async () => {
      for (const key of ['birddog1', 'birddog2', 'rs3']) await delWith(`/api/rigs/${key}`, { confirm: true });
      const last = await delWith('/api/rigs/vbot', { confirm: true });
      return last.status === 400 && /at least one rig/.test(last.body.error ?? '');
    })());
  } catch (error) {
    check('the self-test ran to completion', false, String(error instanceof Error ? error.message : error));
  }

  app.kill('SIGINT');
  await Promise.race([new Promise((resolve) => app.once('exit', resolve)), sleep(5000)]);
  if (app.exitCode === null) app.kill('SIGKILL');
  await fakes.stop();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} checks passed${failed ? ` — app log: ${path.join(runDir, 'app.log')}` : ''}`);
  return failed ? 1 : 0;
}

// ------------------------------------------------------------ isolated smoke

async function isolatedSmoke(): Promise<number> {
  prepareRunDir();
  const child = spawn(path.join(root, 'node_modules', '.bin', 'ts-node'), ['src/testing/smokeTest.ts'], {
    cwd: root,
    // The suite boots the app once incidentally; point it at the sandbox config, a dead Sony port and no controller.
    env: sandboxEnv({ STATUS_PORT: '8175', SONY_API_URL: 'http://127.0.0.1:8199' }),
    stdio: 'inherit',
  });
  return new Promise((resolve) => child.once('exit', (code) => resolve(code ?? 1)));
}

// -------------------------------------------------------------------- run

async function run(): Promise<void> {
  prepareRunDir();
  const scanDelay = Number(process.env.SANDBOX_SCAN_DELAY_MS ?? 0);
  const fakes = await startFakes(scanDelay);
  const app = startApp();
  const base = `http://127.0.0.1:${APP_PORT}`;
  await waitFor('the sandbox app', async () => (await fetch(`${base}/api/status`)).ok, 40000).catch(() => undefined);
  console.log(`
Sandbox running (the live app and your config are untouched)

  App            ${base}
  Fake Sony      http://127.0.0.1:${SONY_PORT}   (control API under /__sandbox)
  App log        ${path.join(runDir, 'app.log')}
  Config copy    ${runDir}

Fake Sony cameras: ${CAMERAS.map((c) => `${c.model} ${c.id}${c.powered ? '' : ' (off)'}`).join(', ')}

Try, from another terminal:
  curl -X POST -H 'content-type: application/json' -d '{"on":true}'  http://127.0.0.1:${SONY_PORT}/__sandbox/cameras/AA:00:00:00:00:03/power
  curl -X POST -H 'content-type: application/json' -d '{"open":true}' http://127.0.0.1:${SONY_PORT}/__sandbox/cameras/AA:00:00:00:00:02/pairing
  curl -X POST -H 'content-type: application/json' -d '{"ms":10000}'  http://127.0.0.1:${SONY_PORT}/__sandbox/scan-delay

Ctrl+C to stop.`);
  const shutdown = async (): Promise<void> => {
    app.kill('SIGINT');
    await Promise.race([new Promise((resolve) => app.once('exit', resolve)), sleep(5000)]);
    if (app.exitCode === null) app.kill('SIGKILL');
    await fakes.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
  app.once('exit', (code) => { console.log(`app exited (${code}); see ${path.join(runDir, 'app.log')}`); void fakes.stop().then(() => process.exit(code ?? 1)); });
}

const mode = process.argv[2];
const main = mode === '--selftest' ? selfTest : mode === '--smoke' ? isolatedSmoke : (async () => { await run(); return undefined; });
Promise.resolve(main()).then((code) => { if (typeof code === 'number') process.exit(code); })
  .catch((error) => { console.error(error); process.exit(1); });
