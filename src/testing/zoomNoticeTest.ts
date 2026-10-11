import assert from 'node:assert/strict';
import { createInitialState } from '../app/state';
import { zoomHealth } from '../app/health';
import { ControlStateMachine } from '../model/controlStateMachine';
import { SonyZoomRouter, resolveZoomTarget, zoomNoticeMessage, DESK_ZOOM_DEADMAN_MS } from '../model/sonyZoomRouter';
import { SonyUpstreamError } from '../sony/sonyManager';
import type { AppConfig } from '../config/configLoader';
import type { AtemClient } from '../atem/atemClient';
import type { MotionDevice } from '../devices/motionDevice';

/** Zoom fallback decision, refused-zoom notice (set, shown, cleared), mapping-driven trigger zoom, desk dead-man. */
let passed = 0;
const check = (name: string, condition: unknown): void => { assert.ok(condition, `FAILED ${name}`); passed++; };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const REFUSAL = 'Zoom operation not supported for this camera/lens';

// ---- the pure decision
check('a camera that has not refused zooms the camera', resolveZoomTarget({ kind: 'sony', sonyId: 'S' }, 0, 1000, true).kind === 'sony');
check('refused + a head that can zoom (VISCA): fall back to the head', resolveZoomTarget({ kind: 'sony', sonyId: 'S' }, 5000, 1000, true).kind === 'head');
check('refused + a head that cannot zoom (gimbal): no head fallback, keep trying the camera', resolveZoomTarget({ kind: 'sony', sonyId: 'S' }, 5000, 1000, false).kind === 'sony');
check('the refusal expires', resolveZoomTarget({ kind: 'sony', sonyId: 'S' }, 900, 1000, true).kind === 'sony');
check('a head target stays the head', resolveZoomTarget({ kind: 'head' }, 5000, 1000, false).kind === 'head');
check('the refusal message names the rig and the cure', /^Far Right camera refused zoom — set its Zoom setting to Clear Image or Digital Zoom/.test(zoomNoticeMessage('Far Right', new Error(REFUSAL))));
check('a bare upstream 400 from the manager is a refusal too', /refused zoom/.test(zoomNoticeMessage('Far Right', new SonyUpstreamError(400, 'Sony upstream 400'))));
check('any other failure says what failed instead', zoomNoticeMessage('Far Right', new Error('timed out')) === 'Far Right camera zoom failed (timed out)');
check('zoomHealth: no notice is ready, a fresh one is CHECK with the reason, an old one expires',
  zoomHealth(null, 1).level === 'ready' && zoomHealth({ message: 'why', at: 1000 }, 2000).level === 'check' && zoomHealth({ message: 'why', at: 1000 }, 2000).hint === 'why' && zoomHealth({ message: 'why', at: 1000 }, 1000 + 11 * 60 * 1000).level === 'ready');

// ---- rigs: a gimbal (head cannot zoom) and a VISCA head, each with a bound Sony camera
interface Spy extends MotionDevice { zooms: number[] }
const device = (id: string, protocol: string, zoom: boolean): Spy => {
  const zooms: number[] = [];
  return { id, label: id, protocol, capabilities: { pan: true, tilt: true, roll: false, zoom, position: false, moveTo: false }, connected: true, zooms,
    setZoom: (v: number) => { zooms.push(v); }, setPanTilt: () => undefined, stop: () => undefined } as unknown as Spy;
};
const gimbal = device('cam1', 'dji-bridge', false);
const visca = device('cam2', 'visca', true);
const devicesConfig = { dji: { protocol: 'dji-bridge' }, vis: { protocol: 'visca' }, sonyG: { protocol: 'sony', sonyCameraId: 'AA:01' }, sonyV: { protocol: 'sony', sonyCameraId: 'AA:02' } };
const config = {
  cameras: [{ id: 'cam1', label: 'Far Right', protocol: 'dji-bridge', camera: 'sonyG', speedScale: 1 }, { id: 'cam2', label: 'V-BOT', protocol: 'visca', camera: 'sonyV', speedScale: 1 }],
  devices: devicesConfig,
  speeds: { presets: [{ name: 'Fast', multiplier: 1 }], activePreset: 0 },
  mappings: { panTilt: 'rightStick', zoomIn: 'rightTrigger', zoomOut: 'leftTrigger', cameraSelectLeft: 'leftStickLeft', cameraSelectRight: 'leftStickRight', autoTransition: 'RB', precisionMode: 'LS',
    selectCam1: 'X', selectCam2: 'A', selectCam3: 'B', selectCam4: 'Y', speedUp: 'dpadUp', speedDown: 'dpadDown', lowerThirds: 'dpadLeft', emergencyStop: 'back' },
} as unknown as AppConfig;

/** A Sony stub: refuses zoom for the ids in `refuse`, records every zoom call. */
const sonyStub = (refuse: Set<string>) => {
  const calls: { id: string; speed: number }[] = [];
  return { calls, connected: () => true, zoom: async (id: string, speed: number) => { calls.push({ id, speed }); if (refuse.has(id)) throw new Error(REFUSAL); return { success: true }; } };
};
const build = (controlled: string, refuse: string[], mappings?: Partial<Record<string, string>>) => {
  const state = createInitialState({ controlledCamera: controlled, programCamera: controlled, previewCamera: controlled, cameraIndex: controlled === 'cam1' ? 0 : 1, controllerConnected: true, speedPreset: 0 });
  const sony = sonyStub(new Set(refuse));
  const cfg = mappings ? { ...config, mappings: { ...config.mappings, ...mappings } } as unknown as AppConfig : config;
  const csm = new ControlStateMachine(state, cfg, {} as unknown as AtemClient, new Map<string, MotionDevice>([['cam1', gimbal], ['cam2', visca]]), null, sony);
  return { state, sony, csm };
};
const press = (csm: ControlStateMachine, triggers: Record<string, number>, buttons: Record<string, boolean> = {}) => { csm.updateInput({ axes: {}, buttons, triggers }); csm.tick(); };

(async () => {
  // gimbal rig: Sony refuses -> no head fallback (the head cannot zoom) + a notice
  {
    gimbal.zooms.length = 0;
    const { state, sony, csm } = build('cam1', ['AA:01']);
    press(csm, { rightTrigger: 0.8 });
    await sleep(30);
    check('the trigger zoom goes to the Sony camera first', sony.calls.length === 1 && sony.calls[0].id === 'AA:01' && sony.calls[0].speed > 0);
    check('the refusal records a notice for that rig with the reason', state.zoomNotice?.cameraId === 'cam1' && state.zoomNotice.sonyId === 'AA:01' && /Far Right camera refused zoom/.test(state.zoomNotice.message) && typeof state.zoomNotice.at === 'number' && !!state.zoomNotices?.cam1);
    press(csm, { rightTrigger: 0.9 });
    press(csm, { rightTrigger: 0.5 });
    check('a gimbal rig is never zoomed through its head after a refusal', gimbal.zooms.every((z) => z === 0) );
    press(csm, {});
    await sleep(30);
    check('releasing still sends the camera a zoom stop (0)', sony.calls[sony.calls.length - 1].speed === 0);
    const before = sony.calls.length;
    press(csm, { rightTrigger: 0.8 });
    await sleep(20);
    check('the next press tries the camera again (so a fixed Zoom setting works at once)', sony.calls.length > before && sony.calls[before].speed > 0);
  }
  // refusal then success clears the notice
  {
    const { state, sony, csm } = build('cam1', ['AA:01']);
    press(csm, { rightTrigger: 0.8 }); await sleep(30); press(csm, {}); await sleep(30);
    check('notice present after the refusal', !!state.zoomNotice);
    (sony as unknown as { zoom: (id: string, speed: number) => Promise<unknown> }).zoom = async () => ({ success: true });
    press(csm, { rightTrigger: 0.8 }); await sleep(30);
    check('a successful zoom clears the notice (single and per rig)', state.zoomNotice === null && !state.zoomNotices?.cam1);
    press(csm, {});
  }
  // VISCA rig: head can zoom -> fall back to the head, no notice
  {
    visca.zooms.length = 0;
    const { state, sony, csm } = build('cam2', ['AA:02']);
    press(csm, { rightTrigger: 0.8 }); await sleep(30);
    check('the first press asks the Sony camera', sony.calls.length === 1 && sony.calls[0].id === 'AA:02');
    press(csm, { rightTrigger: 0.8 }); press(csm, { rightTrigger: 0.8 });
    check('after the refusal a VISCA rig zooms its head', visca.zooms.some((z) => z > 0));
    check('and there is no notice, since the zoom works', state.zoomNotice === null);
    press(csm, {});
    check('releasing stops the head', visca.zooms[visca.zooms.length - 1] === 0);
  }
  // mapping-driven trigger zoom
  {
    const base = build('cam2', []);
    press(base.csm, { rightTrigger: 0.8 }); await sleep(20);
    check('default mapping: right trigger zooms in', base.sony.calls.at(-1)?.speed === 8 || (base.sony.calls.at(-1)?.speed ?? 0) > 0);
    press(base.csm, {}); await sleep(20);
    press(base.csm, { leftTrigger: 0.8 }); await sleep(20);
    check('default mapping: left trigger zooms out', (base.sony.calls.at(-1)?.speed ?? 0) < 0);
    press(base.csm, {}); await sleep(20);

    const swapped = build('cam2', [], { zoomIn: 'leftTrigger', zoomOut: 'rightTrigger' });
    press(swapped.csm, { leftTrigger: 0.8 }); await sleep(20);
    check('mappings.zoomIn = leftTrigger: the left trigger now zooms in', (swapped.sony.calls.at(-1)?.speed ?? 0) > 0);
    press(swapped.csm, {}); await sleep(20);
    press(swapped.csm, { rightTrigger: 0.8 }); await sleep(20);
    check('mappings.zoomOut = rightTrigger: the right trigger now zooms out', (swapped.sony.calls.at(-1)?.speed ?? 0) < 0);
    press(swapped.csm, {}); await sleep(20);

    const calls = swapped.sony.calls.length;
    press(swapped.csm, { rightTrigger: 0 }, { RB: false }); press(swapped.csm, {}); await sleep(20);
    check('an unmapped input does nothing', swapped.sony.calls.length === calls);
    const bound = build('cam2', [], { zoomIn: 'dpadRight' });
    press(bound.csm, {}, { dpadRight: true }); await sleep(20);
    check('a button can be mapped to zoom in (full speed)', bound.sony.calls.at(-1)?.speed === 10);
    press(bound.csm, {}); await sleep(20);
  }
  // desk zoom + dead-man (router level; the sandbox repeats this over HTTP)
  {
    const state = createInitialState();
    const sony = sonyStub(new Set(['AA:01']));
    const router = new SonyZoomRouter(state, config, sony, new Map([['cam1', gimbal], ['cam2', visca]]));
    const ok = await router.deskZoom({ sonyId: 'AA:02' }, 5);
    check('desk zoom by Sony id reaches the camera', ok.ok && sony.calls.at(-1)?.speed === 5);
    await sleep(DESK_ZOOM_DEADMAN_MS + 150);
    check('the server-side dead-man sends zoom 0 when the refreshes stop', sony.calls.at(-1)?.speed === 0 && sony.calls.at(-1)?.id === 'AA:02');
    const byRig = await router.deskZoom({ rigId: 'cam1' }, 5);
    check('desk zoom by rig on a refusing gimbal rig reports the reason and sets the notice', !byRig.ok && /refused zoom/.test(byRig.message ?? '') && state.zoomNotice?.cameraId === 'cam1');
    await router.deskZoom({ sonyId: 'AA:01' }, 0);
    let threw = false;
    try { await router.deskZoom({ rigId: 'nope' }, 3); } catch { threw = true; }
    check('desk zoom for a rig with no Sony camera is an error', threw);
    router.dispose();
  }
  console.log(`zoomNotice: ${passed} checks passed`);
})().catch((error) => { console.error(error); process.exit(1); });
