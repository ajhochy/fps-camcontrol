import { spawn, ChildProcess } from 'child_process';
import { WebSocket } from 'ws';
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
  { id: 'AA:00:00:00:00:02', model: 'ILME-FX3A', powered: true, needsPairing: true, readOnlyAperture: true, battery: 0xffff },
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
    STATUS_HOST: '127.0.0.1', // the sandbox is never on the network
    CAMCONTROL_NO_CONTROLLER: '1',
    CAMCONTROL_GIMBAL_SWEEP: '0', // never sweep the real network: probing a live bridge makes it stop its gimbal
    VISCA_LOCAL_PORT: '0', // never take port 52381 from the live app (it would get the live V-BOT's replies)
    HEALTH_LOG_FILE: path.join(runDir, 'health-events.jsonl'),
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
    ...extra,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function startFakes(scanDelayMs: number): Promise<{ sony: FakeSonySidecar; bridges: VirtualDjiBridge[]; stop: () => Promise<void> }> {
  const visca = VISCA_PORTS.map((port, i) => new FakeViscaCamera(port, `visca-${i + 1}`));
  await Promise.all(visca.map((camera) => camera.start()));
  // Like the real Pi: one host, one bridge instance per gimbal, each naming itself on GET /info.
  const bridges = DJI_PORTS.map((port, i) => new VirtualDjiBridge({ port, statusIntervalMs: 500, safetyTimeoutMs: 250, hostname: 'sandbox-pi', instance: ['rs3', 'rs3pro-a', 'rs3pro-b'][i] }));
  await Promise.all(bridges.map((bridge) => bridge.start()));
  const sony = new FakeSonySidecar(CAMERAS, { scanDelayMs });
  await sony.start(SONY_PORT);
  return {
    sony,
    bridges,
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
  let app = startApp();
  const base = `http://127.0.0.1:${APP_PORT}`;
  const control = `http://127.0.0.1:${SONY_PORT}/__sandbox`;
  // Stop the app and start it again (the fakes keep running), like restarting it on the show computer.
  const restartApp = async (): Promise<void> => {
    app.kill('SIGINT');
    await Promise.race([new Promise((resolve) => app.once('exit', resolve)), sleep(6000)]);
    if (app.exitCode === null) app.kill('SIGKILL');
    app = startApp();
    await waitFor('the app to answer again', async () => (await api('/api/status')).status === 200, 40000);
  };
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
    // Follow-up F3: the controller type and the gimbal model, live.
    const reported = (await api('/api/rigs')).body.rigs?.find((r: any) => r.deviceKey === 'rs3')?.gimbal?.reportedModel;
    check('a gimbal rig shows the model its bridge reports', typeof reported === 'string' && reported.length > 0);
    const sessionsBefore = fakes.bridges.map((bridge) => bridge.sessionsOpened);
    const scanned = (await api('/api/gimbals')).body.gimbals ?? [];
    check('the gimbal scan asks GET /info and opens no session on any bridge (a session\'s end stops a gimbal)', fakes.bridges.every((bridge, i) => bridge.sessionsOpened === sessionsBefore[i] && bridge.infoRequests >= 1));
    check('each gimbal found says which Pi instance and Bluetooth address it is', scanned.filter((g: any) => g.hostname === 'sandbox-pi').map((g: any) => g.instance).join() === 'rs3,rs3pro-a,rs3pro-b' && scanned.every((g: any) => g.hostname !== 'sandbox-pi' || /^AA:BB:CC/.test(g.gimbalAddress)));
    const onPort = (port: number) => scanned.find((g: any) => g.host === '127.0.0.1' && g.port === port);
    check('GET /api/gimbals finds every fake bridge with its model and gimbal link', DJI_PORTS.every((port) => onPort(port)?.reachable === true && onPort(port)?.model === reported && onPort(port)?.gimbalConnected === true));
    check('the gimbal the app drives is reported from its live connection, not probed', onPort(17878)?.drivenBy === 'cam4' && onPort(17878)?.usedBy?.[0]?.deviceKey === 'rs3' && onPort(17879)?.drivenBy === null);
    check('the scan is safe for the driven gimbal: it stays connected', (await api('/api/rigs')).body.rigs?.find((r: any) => r.deviceKey === 'rs3')?.live?.connected === true);
    const toGeneric = await patch('/api/rigs/birddog2', { controller: 'generic' });
    check('a BirdDog can be changed to another VISCA-IP camera and stays connected', toGeneric.status === 200 && toGeneric.body.rigs?.find((r: any) => r.deviceKey === 'birddog2')?.controller === 'generic'
      && !!(await waitFor('the changed camera to reconnect', async () => (await api('/api/rigs')).body.rigs?.find((r: any) => r.deviceKey === 'birddog2')?.live?.connected === true)));
    check('the camera type is changed back', (await patch('/api/rigs/birddog2', { controller: 'birddog' })).status === 200);
    check('a rig with a Sony camera cannot become a BirdDog (400, says why)', await patch('/api/rigs/vbot', { controller: 'birddog' }).then((r) => r.status === 400 && /built-in camera/.test(r.body.error)));
    const toGimbal = await patch('/api/rigs/vbot', { controller: 'gimbal' });
    const asGimbal = toGimbal.body.rigs?.find((r: any) => r.deviceKey === 'vbot');
    check('a V-BOT can become a gimbal: pointed at the gimbals\' Pi on a port no rig drives, live at once', toGimbal.status === 200 && asGimbal?.protocol === 'dji-bridge' && asGimbal?.gimbal?.host === '127.0.0.1' && asGimbal?.gimbal?.port === 7878 && (await api('/api/config')).body.cameras?.[0]?.protocol === 'dji-bridge');
    check('choosing a gimbal another rig drives is refused', (await patch('/api/rigs/vbot', { gimbal: { host: '127.0.0.1', port: 17878 } })).status === 400);
    const chosen = await patch('/api/rigs/vbot', { gimbal: { host: '127.0.0.1', port: 17879, gimbalModel: reported } });
    check('choosing a free gimbal from the scan connects the rig to it', chosen.status === 200
      && !!(await waitFor('the rig to reach its gimbal', async () => (await api('/api/rigs')).body.rigs?.[0]?.live?.connected === true)));
    const backToVbot = await patch('/api/rigs/vbot', { controller: 'vbot', visca: { port: rigs.rigs[0].visca.port } });
    check('and back to a V-BOT on its VISCA port, reconnecting to the camera', backToVbot.status === 200 && backToVbot.body.rigs?.[0]?.protocol === 'visca' && backToVbot.body.rigs?.[0]?.visca?.port === rigs.rigs[0].visca.port
      && !!(await waitFor('the V-BOT to reconnect', async () => (await api('/api/rigs')).body.rigs?.[0]?.live?.connected === true)));
    check('the round trip leaves the file documented', commentCount() === commentsBefore);

    // Horizon (roll) controls on the Status page's Sony cards, for cameras mounted on a gimbal rig.
    {
      const rigsNow = (await api('/api/rigs')).body;
      const gimbalRig = rigsNow.rigs.find((r: any) => r.controller === 'gimbal' && r.camera);
      const mounted = rigsNow.sonyDevices.find((d: any) => d.key === gimbalRig?.camera);
      const onVbot = rigsNow.sonyDevices.find((d: any) => d.key === rigsNow.rigs[0].camera);
      const sonyCams = (await api('/api/sony/status')).body.cameras ?? [];
      const card = sonyCams.find((c: any) => c.id === mounted?.sonyCameraId);
      const vbotCard = sonyCams.find((c: any) => c.id === onVbot?.sonyCameraId);
      check('a Sony camera on a gimbal rig says which rig, so its card offers roll controls', !!gimbalRig && card?.gimbalRig?.id === gimbalRig.id && card?.gimbalRig?.rollAdjustable === true);
      check('a Sony camera on a V-BOT gets no roll controls', !!vbotCard && vbotCard.gimbalRig === undefined);
      const bridge = fakes.bridges.find((b) => b.port === gimbalRig.gimbal.port)!;
      const nudge = await post(`/api/cameras/${gimbalRig.id}/roll`, { delta: 2 });
      check('Roll +2° moves the gimbal to 2° and keeps pan and tilt', nudge.status === 200 && nudge.body.roll === 2 && nudge.body.moved === true
        && !!(await waitFor('the gimbal to roll', async () => Math.abs((bridge as any).roll - 2) < 0.01)));
      const level = await post(`/api/cameras/${gimbalRig.id}/roll`, { level: true });
      check('Level horizon brings roll back to 0°', level.status === 200 && level.body.roll === 0 && !!(await waitFor('the gimbal to level', async () => Math.abs((bridge as any).roll) < 0.01)));
      check('levelling a level gimbal does nothing', (await post(`/api/cameras/${gimbalRig.id}/roll`, { level: true })).body.moved === false);
      check('roll is refused for a rig that is not a gimbal (404) and for a bad nudge (400)', (await post('/api/cameras/cam1/roll', { level: true })).status === 404 && (await post(`/api/cameras/${gimbalRig.id}/roll`, { delta: 45 })).status === 400);
      const order = (await api('/api/sony/status')).body.rigs ?? [];
      check('the Sony dashboard gets the rigs in order with each one\'s Sony camera, to lay cards out under them', order.map((r: any) => r.id).join() === rigsNow.rigs.map((r: any) => r.id).join() && order[0].sonyCameraId === onVbot.sonyCameraId && order.some((r: any) => r.builtInCamera === true && r.sonyCameraId === null));
      check('a Wi-Fi camera is labelled Network, not the Sony service\'s wrong guess of USB', sonyCams.length > 0 && sonyCams.every((c: any) => c.connectionType === 'Network'));
      bridge.link = { drops10m: 2, framesLastMin: 80, corruptLastMin: 2, linkedForS: 30 };
      const sig = await waitFor('the weak signal to show', async () => { const v = (await api('/api/status')).body.cameraGimbalSignal?.[gimbalRig.id]; return v?.rating === 'weak' && v; });
      check('a weak Bluetooth link is reported to the operator, not left to fail silently', sig.rating === 'weak' && /2 Bluetooth drops/.test(sig.summary) && (await api('/api/rigs')).body.rigs.find((r: any) => r.id === gimbalRig.id)?.live?.signal?.rating === 'weak');
      check('the camera tiles say Weak Signal / Poor Signal / Signal Lost, and always show signal bars on gimbal tiles', pageHtml.includes("'Weak Signal'") && pageHtml.includes("'Poor Signal'") && pageHtml.includes("'Signal Lost'") && pageHtml.includes('function signalBadge') && pageHtml.includes('BT signal: '));
      bridge.link = { drops10m: 0, framesLastMin: 80, corruptLastMin: 0, linkedForS: 300 };
      check('the Status page Sony cards show a battery level, toned by charge, with a dash when unknown', pageHtml.includes('function sonyBatteryInfo') && pageHtml.includes('sony-widget__battery') && pageHtml.includes("'Battery —'") && pageHtml.includes('var(--err-text)'));
      check('the Status page draws roll buttons next to the preview', pageHtml.includes('function sonyRollHtml') && pageHtml.includes('Level horizon') && pageHtml.includes("'/roll'"));

      // Wake gimbal: an asleep gimbal can be woken from the app, only after the operator confirms.
      const rigHealthOf = async () => (await api('/api/status')).body.health?.rigs?.[gimbalRig.id];
      bridge.reportSleep = true; bridge.asleep = true;
      const asleepHealth = await waitFor('the gimbal to show Asleep', async () => { const h = await rigHealthOf(); return h?.text === 'Asleep' && h; });
      check('a gimbal that reports it is asleep shows Asleep', asleepHealth.text === 'Asleep' && (await api('/api/status')).body.cameraGimbalCanWake?.[gimbalRig.id] === true);
      check('Device Config offers Wake gimbal for the asleep gimbal', (await api('/api/rigs')).body.rigs.find((r: any) => r.id === gimbalRig.id)?.live?.canWake === true);
      const wakesBefore = bridge.wakes;
      const unconfirmed = await post(`/api/cameras/${gimbalRig.id}/wake`, {});
      check('a wake without { confirm: true } is refused (409) and sends nothing', unconfirmed.status === 409 && /confirm/.test(unconfirmed.body.error) && bridge.wakes === wakesBefore);
      check('wake is refused for a rig that is not a gimbal (404) and a bad id (400)', (await post('/api/cameras/cam1/wake', { confirm: true })).status === 404 && (await post('/api/cameras/nope/wake', { confirm: true })).status === 400);
      const woke = await post(`/api/cameras/${gimbalRig.id}/wake`, { confirm: true });
      check('a confirmed wake is sent once (200)', woke.status === 200 && woke.body.ok === true && bridge.wakes === wakesBefore + 1);
      const awake = await waitFor('the gimbal to report awake', async () => { const h = await rigHealthOf(); return h?.level === 'ready' && h; });
      check('once the gimbal reports awake its health returns to ready', awake.level === 'ready');
      check('the wake is in the activity log', ((await api('/api/activity')).body.entries ?? []).some((e: any) => /wake sent/.test(e.message ?? '')));
      check('the Status page draws a Wake gimbal button that asks first and keeps its state across re-renders', pageHtml.includes('function wakeHtml') && pageHtml.includes('Wake gimbal') && pageHtml.includes("'/wake'") && pageHtml.includes('window.confirm(') && pageHtml.includes('var gimbalWake = {}') && pageHtml.includes('Make sure nobody is touching it.'));
      bridge.reportSleep = false;
    }

    // VISCA cameras: the tiles say whether each one answers, not just that a socket is open.
    const answering = await waitFor('the VISCA cameras to answer a health check', async () => { const a = (await api('/api/status')).body.cameraAnswering ?? {}; return Object.keys(a).length >= 1 && a; }, 40000);
    check('VISCA cameras are reported as answering from their actual replies', Object.values(answering).every((v) => v === true) && Object.keys((await api('/api/status')).body.cameraLastReplyAt ?? {}).length >= 1);
    check('the sandbox does not take port 52381 from the live app', (await api('/api/status')).body.viscaRepliesHeard === false);
    check('tiles show a Ready / Check / Down verdict from the real state', pageHtml.includes('function verdictText') && pageHtml.includes("'Not Answering'") && !pageHtml.includes("(ok ? 'Online' : 'Offline')"));

    // Health: every rig and its Sony camera gets a verdict; changes are logged with a time.
    const health = (await api('/api/status')).body.health;
    check('every rig has a health verdict, and rigs with a Sony camera have one for the camera too', !!health && Object.keys(health.rigs).length === 4 && Object.keys(health.cameras).length >= 1);
    check('the Status page shows an alert banner and a health log', pageHtml.includes('health-alerts') && pageHtml.includes('id="health-log"') && pageHtml.includes("'/api/health/events'"));
    const rigsForHealth = (await api('/api/rigs')).body;
    const mountedOnVbot = rigsForHealth.sonyDevices.find((d: any) => d.key === rigsForHealth.rigs[0].camera);
    if (mountedOnVbot?.sonyCameraId) {
      await fetch(`http://127.0.0.1:${SONY_PORT}/__sandbox/cameras/${mountedOnVbot.sonyCameraId}/power`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: false }) });
      const offEvent = await waitFor('a camera switched off to show in the health log', async () => ((await api('/api/health/events')).body.events ?? []).find((e: any) => e.key === 'camera:cam1' && e.to === 'down'), 60000);
      check('a camera that switches off is logged with a time and why', !!offEvent && !!offEvent.at && /Off or Asleep|Disconnected|Refused/.test(offEvent.text));
      await fetch(`http://127.0.0.1:${SONY_PORT}/__sandbox/cameras/${mountedOnVbot.sonyCameraId}/power`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: true }) });
    }

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
    const batteryOf = async (id: string): Promise<any> => (await api('/api/sony/status')).body.cameras?.find((c: any) => c.id === id)?.battery;
    const firstBattery = await waitFor('the a7S III battery to be read after connect', async () => { const b = await batteryOf(A); return b && typeof b.percent === 'number' && b; }, 10000, 250).catch(() => null);
    check('a connected camera reports its battery level in /api/sony/status', firstBattery?.percent === 82 && typeof firstBattery?.at === 'string' && firstBattery?.stale === false);
    const props = await api(`/api/sony/cameras/${A}/properties`);
    const aperture = props.body?.data?.properties?.aperture;
    check('the a7S III reports a writable aperture with 23 options', aperture?.writable === true && aperture?.available_values?.length === 23);
    check('a setting can be changed with the hex value the dashboard sends', (await put(`/api/sony/cameras/${A}/properties/aperture`, { value: '0x190' })).status === 200);
    const right = (await api(`/api/sony/cameras/${A}/properties/aperture`)).body?.data;
    check('right after a change the camera still reports the old value (the lag behind the menu bug)', right?.formatted !== 'F4');
    const after = await waitFor('the camera to report F4', async () => { const a = (await api(`/api/sony/cameras/${A}/properties`)).body?.data?.properties?.aperture; return a?.current_formatted === 'F4' && a; }, 5000);
    check('the camera now reports F4 (once it has applied it), and one setting can be read fresh', after?.current_formatted === 'F4' && (await api(`/api/sony/cameras/${A}/properties/aperture`)).body?.data?.formatted === 'F4');
    check('the page keeps a pending choice and waits for the camera instead of snapping back', pageHtml.includes('function sonyReported') && pageHtml.includes('state.pending[name]'));
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
    const fxBattery = await waitFor('the FX3A battery to be read', async () => { const b = await batteryOf(B); return b && typeof b.at === 'string' && b; }, 10000, 250).catch(() => null);
    check('a camera that has no battery reading (0xFFFF) reports an unknown level, not 65535%', !!fxBattery && fxBattery.percent === null);
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
    check('deleting the hardware entry with the rig is refused while the profile has unsaved changes (409)', (await delWith('/api/rigs/sandbox-gimbal', { confirm: true, deleteDevice: true })).status === 409);
    const removedLast = await delWith('/api/rigs/sandbox-gimbal', { confirm: true });
    check('removing the last rig with confirmation works and keeps its hardware entry', removedLast.status === 200 && removedLast.body.rigs?.length === 4 && fs.readFileSync(yamlFile, 'utf8').includes('sandbox-gimbal'));

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

    // --- the working copy: rig edits are live and survive a restart, the saved profile stays as saved until you save
    const savedProfile = (name: string): any => { const { parse } = require('yaml'); return parse(fs.readFileSync(yamlFile, 'utf8')).profiles[name]; };
    const workingFile = path.join(runDir, 'working-profile.json');
    await post('/api/profiles/revert');
    let view = (await api('/api/rigs')).body;
    check('after a revert there are no unsaved changes and no working-copy file', view.profile?.modified === false && !fs.existsSync(workingFile));
    check('reverting puts the rigs back as saved (four, V-BOT first)', view.rigs?.length === 4 && view.rigs[0].deviceKey === 'vbot');
    const v0 = view.version;
    const wired = await patch('/api/rigs/vbot', { inputId: 9 });
    check('a wiring edit answers with the profile marked modified and what changed', wired.status === 200 && wired.body.profile?.modified === true && JSON.stringify(wired.body.profile.changes) === JSON.stringify([{ kind: 'input', label: 'V-BOT', from: 6, to: 9 }]));
    check('the running app uses the working rigs at once', (await api('/api/config')).body.cameras?.[0]?.inputId === 9);
    check('the profile in devices.yaml is still exactly as saved', savedProfile('production').slots[0].inputId === 6);
    check('the working copy is saved to a file for restarts', fs.existsSync(workingFile) && JSON.parse(fs.readFileSync(workingFile, 'utf8')).slots[0].inputId === 9);
    await patch('/api/rigs/vbot', { label: 'V-BOT (shared)' });
    check('a hardware edit (the name) is saved at once to devices.yaml while the rigs stay unsaved', fs.readFileSync(yamlFile, 'utf8').includes('V-BOT (shared)') && savedProfile('production').slots[0].inputId === 6 && (await api('/api/rigs')).body.profile.modified === true);
    check('the classic Device Config save is refused while there are unsaved rig changes', (await post('/api/config', { atem: { ip: '127.0.0.1', defaultTransition: 'cut', meIndex: 0 }, cameras: [] })).status === 409);
    const switchAsk = await post('/api/profiles/active', { profile: 'test' });
    check('switching profile with unsaved changes is refused and lists the changes (409)', switchAsk.status === 409 && switchAsk.body.unsavedChanges === true && switchAsk.body.changes?.length === 1);
    check('a refused switch changes nothing', (await api('/api/rigs')).body.activeProfile === 'production' && (await api('/api/rigs')).body.profile.modified === true);

    await restartApp();
    view = (await api('/api/rigs')).body;
    check('after the app restarts the unsaved rig changes are still applied', view.profile?.modified === true && view.rigs?.[0]?.inputId === 9);
    check('the restored changes are still described', view.profile?.changes?.[0]?.kind === 'input' && view.profile?.changes?.[0]?.to === 9);
    check('a restart leaves the saved profile untouched', savedProfile('production').slots[0].inputId === 6);

    const reverted = await post('/api/profiles/revert');
    check('Revert drops the working copy: back to the saved rigs, file gone', reverted.status === 200 && reverted.body.profile?.modified === false && reverted.body.rigs?.[0]?.inputId === 6 && !fs.existsSync(workingFile));
    check('the hardware name edit is shared and is not undone by Revert', reverted.body.rigs?.[0]?.label === 'V-BOT (shared)');
    check('Revert with nothing to revert answers 409', (await post('/api/profiles/revert')).status === 409);
    await patch('/api/rigs/vbot', { label: 'V-BOT' });

    // presets follow their rigs, and Revert puts them back
    const presetsBefore = (await api('/api/presets')).body;
    await delWith('/api/rigs/birddog1', { confirm: true });
    const shifted = (await api('/api/presets')).body;
    check('removing a rig in the working copy shifts the presets at once', shifted.cam2?.X?.pan === presetsBefore.cam3?.X?.pan && shifted.cam4 === undefined);
    await post('/api/profiles/revert');
    const restored = (await api('/api/presets')).body;
    check('Revert restores the presets exactly as they were before the edits', JSON.stringify(restored) === JSON.stringify(presetsBefore));
    check('Revert brings the removed rig back', (await api('/api/rigs')).body.rigs?.map((r: any) => r.deviceKey).join() === 'vbot,birddog1,birddog2,rs3');

    // Save writes the working copy into the profile
    await patch('/api/rigs/vbot', { inputId: 9 });
    const commentsWithDraft = commentCount();
    const saved = await post('/api/profiles/save');
    check('Save writes the working rigs into the profile in devices.yaml and ends the working copy', saved.status === 200 && saved.body.profile?.modified === false && savedProfile('production').slots[0].inputId === 9 && !fs.existsSync(workingFile));
    check('Save keeps the file documented', commentCount() >= commentsWithDraft - 1);
    await patch('/api/rigs/vbot', { inputId: 6 });
    await post('/api/profiles/save');
    check('the profile can be put back the same way', savedProfile('production').slots[0].inputId === 6);

    // Save as: a new profile; the original stays exactly as it was saved
    await patch('/api/rigs/vbot', { inputId: 9 });
    const productionBefore = JSON.stringify(savedProfile('production'));
    const savedAs = await post('/api/profiles/save-as', { label: 'Sunday test' });
    check('Save as creates a new active profile with the working rigs (201)', savedAs.status === 201 && savedAs.body.key === 'sunday-test' && savedAs.body.activeProfile === 'sunday-test' && savedAs.body.profile?.modified === false);
    check('the new profile holds the edited rigs and the original is exactly as it was saved', savedProfile('sunday-test').slots[0].inputId === 9 && JSON.stringify(savedProfile('production')) === productionBefore);
    check('Save as with a name that exists is refused (400)', (await (async () => { await patch('/api/rigs/vbot', { inputId: 10 }); return post('/api/profiles/save-as', { label: 'sunday TEST' }); })()).status === 400);
    await post('/api/profiles/revert');
    const back = await post('/api/profiles/active', { profile: 'production' });
    check('switching back to the original profile shows its rigs as they were', back.status === 200 && (await api('/api/rigs')).body.rigs?.[0]?.inputId === 6);
    check('a profile can be renamed', (await patch('/api/profiles/sunday-test', { label: 'Sunday (two inputs)' })).body.profiles?.find((p: any) => p.name === 'sunday-test')?.label === 'Sunday (two inputs)');
    check('the active profile cannot be deleted (409)', (await del('/api/profiles/production')).status === 409);
    check('an inactive profile can be deleted', (await del('/api/profiles/sunday-test')).status === 200 && !(await api('/api/rigs')).body.profiles?.some((p: any) => p.name === 'sunday-test'));

    // switching with `discard: true` drops the changes (and restores the presets)
    await patch('/api/rigs/vbot', { inputId: 9 });
    const discard = await post('/api/profiles/active', { profile: 'test', discard: true });
    check('switching with discard drops the working copy and switches', discard.status === 200 && (await api('/api/rigs')).body.profile?.modified === false && (await api('/api/rigs')).body.activeProfile === 'test' && !fs.existsSync(workingFile));
    await post('/api/profiles/active', { profile: 'production' });

    // a draft that can no longer be restored is set aside, never lost
    await patch('/api/rigs/vbot', { inputId: 9 });
    const draft = JSON.parse(fs.readFileSync(workingFile, 'utf8'));
    await restartApp();
    fs.writeFileSync(workingFile, JSON.stringify({ ...draft, base: 'a-profile-that-was-deleted' }));
    await restartApp();
    view = (await api('/api/rigs')).body;
    check('a draft whose profile no longer exists is not applied', view.profile?.modified === false && view.rigs?.[0]?.inputId === 6);
    check('the operator is told, and the draft is kept aside', /no longer exists/.test(view.profile?.notice ?? '') && fs.readdirSync(runDir).some((name) => name.startsWith('working-profile.json.orphaned-')));
    await post('/api/profiles/revert');

    // --- iPad remote control: a WebSocket client plays the iPad; the DJI bridge fake is the camera
    {
      const wsBase = `ws://127.0.0.1:${APP_PORT}/ws/remote-controller`;
      const rs3 = fakes.bridges[0];
      const rigIndex = ((await api('/api/config')).body.cameras as any[]).findIndex((c) => c.label === 'DJI RS3');
      const faceBit = [2, 0, 1, 3][rigIndex]; // X, A, B, Y pick cameras 1-4
      check('the RS3 rig is a face-button camera', rigIndex >= 0 && rigIndex <= 3);

      interface Remote { ws: WebSocket; msgs: any[]; closed: { code: number } | null; seq: number; send: (o: unknown) => void; frame: (a: number[], tr?: number[], b?: number) => void; stream: (ms: number, a: number[], tr?: number[], b?: number) => Promise<void>; close: () => void }
      const connect = async (origin: string | null = base, name = 'Test iPad'): Promise<Remote> => {
        const ws = new WebSocket(wsBase, origin === null ? {} : { headers: { Origin: origin } });
        const remote: Remote = {
          ws, msgs: [], closed: null, seq: 0,
          send: (o) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); },
          frame: (a, tr = [0, 0], b = 0) => remote.send({ t: 'in', s: ++remote.seq, a, tr, b }),
          stream: async (ms, a, tr = [0, 0], b = 0) => { const end = Date.now() + ms; while (Date.now() < end) { remote.frame(a, tr, b); await sleep(33); } },
          close: () => ws.close(),
        };
        ws.on('message', (d) => remote.msgs.push(JSON.parse(String(d))));
        ws.on('close', (code) => { remote.closed = { code }; });
        ws.on('error', () => { remote.closed = remote.closed ?? { code: 0 }; });
        await new Promise<void>((resolve) => { ws.once('open', () => resolve()); ws.once('error', () => resolve()); ws.once('close', () => resolve()); });
        if (ws.readyState === WebSocket.OPEN) remote.send({ t: 'hello', v: 1, name, pad: { id: 'Xbox', mapping: 'standard' } });
        return remote;
      };
      const ownerNow = async (): Promise<string> => (await api('/api/status')).body.remoteControl?.owner;
      const claimed = async (r: Remote): Promise<boolean> => { r.send({ t: 'claim' }); return waitFor('the claim to be granted', async () => r.msgs.some((m) => m.t === 'owner' && m.you === true), 3000, 40).then(() => true, () => false); };
      const stoppedSince = async (mark: number, ms = 600): Promise<boolean> => waitFor('the gimbal to stop', async () => rs3.velPan === 0 && rs3.log.slice(mark).includes('stop {}'), ms, 10).then(() => true, () => false);

      check('remote control is off by default', (await api('/api/status')).body.remoteControl?.enabled === false);
      check('GET /remote serves the page, and it loads remote.js', await (async () => { const r = await fetch(`${base}/remote`); const t = await r.text(); return r.status === 200 && t.includes('/ui/remote/remote.js'); })());
      check('remote.js, remoteModel.js and remote.css are served, and the page loads the model before the script', (await fetch(`${base}/ui/remote/remote.js`)).status === 200 && (await fetch(`${base}/ui/remote/remoteModel.js`)).status === 200 && (await fetch(`${base}/ui/remote/remote.css`)).status === 200 && await (async () => { const t = await (await fetch(`${base}/remote`)).text(); return t.indexOf('remoteModel.js') > 0 && t.indexOf('remoteModel.js') < t.indexOf('/ui/remote/remote.js'); })());
      check('the remote enabled switch rejects a non-boolean (400)', (await post('/api/remote/enabled', { enabled: 'yes' })).status === 400);

      // disabled: a claim is refused and nothing moves
      let r1 = await connect();
      await waitFor('welcome', async () => r1.msgs.some((m) => m.t === 'welcome'), 3000, 40);
      check('welcome reports remote control as disabled', r1.msgs.find((m) => m.t === 'welcome')?.enabled === false);
      r1.send({ t: 'claim' });
      await sleep(150);
      check('a claim while remote control is off is denied: disabled', r1.msgs.some((m) => m.t === 'denied' && m.reason === 'disabled') && (await ownerNow()) === 'local');
      r1.close();

      check('switching remote control on', (await post('/api/remote/enabled', { enabled: true })).body.remoteControl?.enabled === true);

      // claim, select the RS3 with its face button, pan it
      r1 = await connect();
      check('a claim is granted when enabled and the desk is quiet', await claimed(r1) && (await ownerNow()) === 'remote');
      check('the status names the iPad as the owner', /Test iPad/.test((await api('/api/status')).body.remoteControl?.ownerName ?? ''));
      await r1.stream(150, [0, 0, 0, 0]);
      await r1.stream(150, [0, 0, 0, 0], [0, 0], 1 << faceBit);
      await r1.stream(150, [0, 0, 0, 0]);
      check('the iPad selects the RS3 rig with its face button', (await api('/api/status')).body.controlledCamera === ((await api('/api/config')).body.cameras as any[])[rigIndex].id);
      check('selecting the rig moved nothing', rs3.velPan === 0);
      const streaming = r1.stream(900, [0, 0, 0.8, 0]);
      await sleep(500);
      check('the right stick pans the gimbal (velPan > 0)', rs3.velPan > 0, `velPan=${rs3.velPan}`);
      await streaming;

      // (a) the socket drops mid-move: an explicit stop, well inside the dead-man window
      const streaming2 = r1.stream(2000, [0, 0, 0.8, 0]);
      await sleep(400);
      const movingBefore = rs3.velPan;
      const logMark = rs3.log.length;
      const closeAt = Date.now();
      r1.ws.terminate();
      const stopped = await waitFor('the gimbal to be stopped', async () => rs3.velPan === 0 && rs3.log.slice(logMark).includes('stop {}'), 1000, 10).then(() => Date.now() - closeAt, () => -1);
      await streaming2;
      check('the gimbal was moving before the socket dropped', movingBefore > 0);
      check('(a) the socket dropping stops the gimbal explicitly (stop sent) within 150 ms', stopped >= 0 && stopped < 150, `stopped after ${stopped} ms`);
      check('(a) the app stopped it, not the bridge watchdog (no safety-stop)', !rs3.log.slice(logMark).includes('safety-stop'));
      await sleep(100);
      check('(d) the owner returns to the desk after the socket closes', (await ownerNow()) === 'local');

      // (b) the iPad goes silent with the socket still open
      const r2 = await connect();
      check('(b) the iPad can claim again after a drop', await claimed(r2));
      await r2.stream(150, [0, 0, 0, 0]);
      const move2 = r2.stream(500, [0, 0, 0.8, 0]);
      await sleep(300);
      const moving2 = rs3.velPan;
      await move2;
      const silentAt = Date.now();
      const stopped2 = await waitFor('the gimbal to stop on silence', async () => rs3.velPan === 0, 1500, 10).then(() => Date.now() - silentAt, () => -1);
      check('(b) the gimbal was moving', moving2 > 0);
      check('(b) going silent with the socket open stops the gimbal within 400 ms', stopped2 >= 0 && stopped2 < 400, `stopped after ${stopped2} ms`);
      check('(b) the owner is revoked after 1 s of silence', await waitFor('owner to revert', async () => (await ownerNow()) === 'local', 2500, 100).then(() => true, () => false));
      check('(b) the iPad is told it lost control', r2.msgs.some((m) => m.t === 'owner' && m.you === false && m.reason === 'timeout'));
      r2.close();
      await sleep(100);

      // idle (page hidden) stops at once and releases the seat
      const r3 = await connect();
      await claimed(r3);
      const move3 = r3.stream(2000, [0, 0, 0.8, 0]);
      await sleep(300);
      const idleMark = rs3.log.length;
      r3.send({ t: 'idle' });
      check('an idle message (page hidden) stops the gimbal at once and releases the seat', await stoppedSince(idleMark) && (await ownerNow()) === 'local');
      await move3;
      check('frames sent after idle (no longer the owner) move nothing', rs3.velPan === 0);

      // the desk wins: Take back; and frames from a non-owner are ignored
      await claimed(r3);
      const spectator = await connect(base, 'Spectator');
      await waitFor('welcome', async () => spectator.msgs.some((m) => m.t === 'welcome'), 3000, 40);
      spectator.send({ t: 'claim' });
      await sleep(150);
      check('a second iPad is refused while one owns: other-remote', spectator.msgs.some((m) => m.t === 'denied' && m.reason === 'other-remote'));
      await spectator.stream(400, [0, 0, 0.8, 0]);
      check('frames from the spectator move nothing', rs3.velPan === 0);
      const move4 = r3.stream(1500, [0, 0, 0.8, 0]);
      await sleep(300);
      const takeMark = rs3.log.length;
      const taken = await post('/api/remote/release');
      check('Take back answers ok and the desk owns again', taken.status === 200 && taken.body.wasRemote === true && (await ownerNow()) === 'local');
      check('Take back stops the gimbal', await stoppedSince(takeMark));
      await move4;
      check('the iPad is told the desk took control back', r3.msgs.some((m) => m.t === 'owner' && m.you === false && m.reason === 'taken-back'));
      spectator.close();

      // STOP from the iPad
      await claimed(r3);
      const move5 = r3.stream(1500, [0, 0, 0.8, 0]);
      await sleep(300);
      const stopMark = rs3.log.length;
      r3.send({ t: 'stop' });
      check('STOP from the iPad stops the gimbal and releases the seat', await stoppedSince(stopMark) && (await ownerNow()) === 'local');
      await move5;
      r3.close();
      await sleep(100);

      // HTTP STOP
      const emer = await post('/api/emergency-stop');
      check('POST /api/emergency-stop answers ok', emer.status === 200 && emer.body.ok === true);

      // (c) junk frames
      const r4 = await connect();
      await claimed(r4);
      for (const junk of ['not json', '[]', '{"t":"in"}', '{"t":"in","s":1,"a":[1e999,0,0,0],"tr":[0,0],"b":0}', '{"t":"in","s":2,"a":[0,0,"x",0],"tr":[0,0],"b":0}', '{"t":"in","s":3,"a":[0,0,1,0],"tr":[0,0],"b":99999999}', '{"t":"in","s":4,"a":[0,0,1],"tr":[0,0],"b":0}', '{"t":"nope"}']) r4.ws.send(junk);
      await sleep(250);
      check('(c) junk frames do not move anything', rs3.velPan === 0);
      for (let i = 0; i < 40; i++) r4.ws.send('junk');
      await waitFor('close on abuse', async () => r4.closed, 2000, 40).catch(() => undefined);
      check('(c) a flood of invalid messages gets the socket closed (1008)', r4.closed?.code === 1008);
      await sleep(100);
      check('(d) the owner is back to the desk after the abuse', (await ownerNow()) === 'local');

      // switching it off while an iPad is driving
      const r5 = await connect();
      await claimed(r5);
      const move6 = r5.stream(1500, [0, 0, 0.8, 0]);
      await sleep(300);
      const offMark = rs3.log.length;
      await post('/api/remote/enabled', { enabled: false });
      check('switching remote control off stops the gimbal and releases the seat', await stoppedSince(offMark) && (await ownerNow()) === 'local');
      await move6;
      r5.send({ t: 'claim' });
      await sleep(150);
      check('and a new claim is denied: disabled', r5.msgs.some((m) => m.t === 'denied' && m.reason === 'disabled'));
      r5.close();
      await sleep(100);
    }
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
