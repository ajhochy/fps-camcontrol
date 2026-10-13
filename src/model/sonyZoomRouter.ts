import type { AppState } from '../app/state';
import type { AppConfig } from '../config/configLoader';
import type { MotionDevice } from '../devices/motionDevice';
import { SonyRetryableError, SonyUpstreamError } from '../sony/sonyManager';
import { SonyZoom, ZoomTarget, zoomTarget } from './zoomTarget';

/** After the Sony camera refuses zoom, a rig whose head CAN zoom zooms the head for this long, then retries the camera. */
export const SONY_ZOOM_FALLBACK_MS = 30000;
/** A desk zoom button that stops refreshing (page closed, network gone) is stopped on the server after this long. */
export const DESK_ZOOM_DEADMAN_MS = 600;

export interface ZoomNotice { cameraId: string; sonyId: string; message: string; at: number }

/**
 * The zoom decision after a refusal, pure so a unit test covers it. `refusedUntil` is when the camera's refusal
 * stops counting; `headCanZoom` is the rig device's capabilities.zoom. A refused camera on a rig whose head cannot
 * zoom (a DJI gimbal) is NOT sent to the head: there is nothing there to move, so the camera is simply tried
 * again on the next press and the operator is told why it failed.
 */
export function resolveZoomTarget(base: ZoomTarget, refusedUntil: number, now: number, headCanZoom: boolean): ZoomTarget {
  if (base.kind === 'head') return base;
  if (refusedUntil > now && headCanZoom) return { kind: 'head' };
  return base;
}

/** The sentence the operator sees. A refusal names the cure; any other failure names the failure. */
export function zoomNoticeMessage(rigLabel: string, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  // The manager keeps only the status of a sidecar answer ("Sony upstream 400"); a 400 on the zoom action is the camera saying no.
  if (/not supported|refus/i.test(reason) || (err instanceof SonyUpstreamError && err.statusCode === 400)) {
    return `${rigLabel} camera refused zoom — set its Zoom setting to Clear Image or Digital Zoom (⋯ menu / desk card)`;
  }
  return `${rigLabel} camera zoom failed (${reason})`;
}

export type SonyZoomResult = 'ok' | 'busy' | 'refused';

/**
 * One zoom path for every source: the Xbox triggers and the iPad (through ControlStateMachine) and the desk
 * page's hold-to-zoom buttons. It owns the refusal memory and the per-rig notice in state, so a refused zoom is
 * never silent and a successful one clears the notice.
 */
export class SonyZoomRouter {
  private refusedUntil = new Map<string, number>();
  private deskTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private state: AppState,
    private config: Pick<AppConfig, 'cameras' | 'devices'>,
    private sony: (SonyZoom) | null,
    private devices: Map<string, MotionDevice>,
    private log: (level: 'warn' | 'info', msg: string, extra?: object) => void = () => undefined
  ) {}

  headCanZoom(cameraId: string): boolean {
    return this.devices.get(cameraId)?.capabilities.zoom === true;
  }

  targetFor(cameraId: string, now = Date.now()): ZoomTarget {
    const base = zoomTarget(cameraId, this.config, this.sony);
    if (base.kind === 'head') return base;
    return resolveZoomTarget(base, this.refusedUntil.get(base.sonyId) ?? 0, now, this.headCanZoom(cameraId));
  }

  /** Fire-and-forget send to the camera; the promise says how it ended. A stop (0) is always sent. */
  send(cameraId: string, sonyId: string, speed: number): Promise<SonyZoomResult> {
    if (!this.sony) return Promise.resolve('refused');
    return this.sony.zoom(sonyId, speed).then(() => {
      if (speed !== 0) this.clearNotice(cameraId);
      return 'ok' as const;
    }, (err): SonyZoomResult => {
      if (err instanceof SonyRetryableError) return 'busy'; // busy lane: the next change or the stop gets through
      // A failed stop is not a zoom failure to report; it is logged by the caller's stop path.
      if (speed === 0) return 'refused';
      this.noteRefusal(cameraId, sonyId, err);
      return 'refused';
    });
  }

  private noteRefusal(cameraId: string, sonyId: string, err: unknown): void {
    const headCan = this.headCanZoom(cameraId);
    const label = this.config.cameras.find((camera) => camera.id === cameraId)?.label ?? cameraId;
    if (headCan) {
      this.refusedUntil.set(sonyId, Date.now() + SONY_ZOOM_FALLBACK_MS);
      this.log('warn', 'Sony zoom failed: zooming the PTZ head instead for 30 s', { err, sonyId });
      return;
    }
    const message = zoomNoticeMessage(label, err);
    this.setNotice({ cameraId, sonyId, message, at: Date.now() });
    this.log('warn', `Sony zoom failed and the head cannot zoom: ${message}`, { err, sonyId });
  }

  setNotice(notice: ZoomNotice): void {
    const notices = (this.state.zoomNotices ??= {});
    notices[notice.cameraId] = notice;
    this.state.zoomNotice = notice;
  }

  clearNotice(cameraId: string): void {
    if (this.state.zoomNotices?.[cameraId]) delete this.state.zoomNotices[cameraId];
    if (this.state.zoomNotice?.cameraId === cameraId) {
      const rest = Object.values(this.state.zoomNotices ?? {}).sort((a, b) => b.at - a.at);
      this.state.zoomNotice = rest[0] ?? null;
    }
  }

  /** Which rig a Sony camera is bound to (first match), for notices and the rig-level desk route. */
  rigForSony(sonyId: string): string | null {
    const wanted = sonyId.toUpperCase();
    for (const rig of this.config.cameras) {
      const device = rig.camera ? this.config.devices?.[rig.camera] : undefined;
      if (device?.protocol === 'sony' && device.sonyCameraId?.toUpperCase() === wanted) return rig.id;
    }
    return null;
  }

  sonyForRig(cameraId: string): string | null {
    const rig = this.config.cameras.find((camera) => camera.id === cameraId);
    const device = rig?.camera ? this.config.devices?.[rig.camera] : undefined;
    return device?.protocol === 'sony' && device.sonyCameraId ? device.sonyCameraId : null;
  }

  /**
   * Desk page zoom for one Sony camera (by Sony id or by rig), speed -10..10 as the sidecar takes it. Every non-zero
   * call re-arms a dead-man: with no refresh within DESK_ZOOM_DEADMAN_MS the camera is told 0 by the server itself.
   */
  async deskZoom(input: { sonyId?: string; rigId?: string }, speed: number): Promise<{ ok: boolean; sonyId: string; message?: string }> {
    const sonyId = input.sonyId ?? (input.rigId ? this.sonyForRig(input.rigId) : null);
    if (!sonyId) throw new Error('No Sony camera on that rig');
    const cameraId = input.rigId ?? this.rigForSony(sonyId) ?? sonyId;
    const key = sonyId.toUpperCase();
    const timer = this.deskTimers.get(key);
    if (timer) { clearTimeout(timer); this.deskTimers.delete(key); }
    if (speed !== 0) {
      this.deskTimers.set(key, setTimeout(() => {
        this.deskTimers.delete(key);
        void this.send(cameraId, sonyId, 0);
      }, DESK_ZOOM_DEADMAN_MS));
      this.deskTimers.get(key)?.unref?.();
    }
    const result = await this.send(cameraId, sonyId, speed);
    if (result === 'refused' && speed !== 0) {
      return { ok: false, sonyId, message: this.state.zoomNotices?.[cameraId]?.message ?? 'Sony camera refused zoom' };
    }
    return { ok: true, sonyId };
  }

  /** Cancel dead-man timers (shutdown / tests). */
  dispose(): void {
    for (const timer of this.deskTimers.values()) clearTimeout(timer);
    this.deskTimers.clear();
  }
}

const routers = new WeakMap<AppState, SonyZoomRouter>();
/** The one router for a state, so the control machine and the desk routes share refusal memory and notices. */
export function zoomRouterFor(
  state: AppState, config: Pick<AppConfig, 'cameras' | 'devices'>, sony: SonyZoom | null, devices: Map<string, MotionDevice>,
  log?: (level: 'warn' | 'info', msg: string, extra?: object) => void
): SonyZoomRouter {
  let router = routers.get(state);
  if (!router) { router = new SonyZoomRouter(state, config, sony, devices, log); routers.set(state, router); }
  return router;
}
