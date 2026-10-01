import fs from 'fs';
import path from 'path';
import { spawn as nodeSpawn } from 'child_process';
import { SonyStateStore, ApprovedSonyCamera } from './sonyStateStore';

/** Upstream paths below are the ones already proven against the sidecar by `statusServer.ts`. */
const HEALTH_TIMEOUT_MS = 1500;
const CONNECT_TIMEOUT_MS = 30000;
const READ_TIMEOUT_MS = 5000;
// Reading all of a camera's settings can queue behind other cameras connecting on the same service.
const PROPERTIES_TIMEOUT_MS = 15000;
// A network scan (Wi-Fi/LAN cameras) routinely takes ~10s inside Sony's SDK.
const DISCOVERY_TIMEOUT_MS = 30000;
const FRAME_TIMEOUT_MS = 3000;
const LINK_CHECK_MS = 5000;
const LINK_CHECK_TIMEOUT_MS = 2000;
/**
 * After a connected camera drops, leave it to the Sony SDK's own reconnect (requested with `reconnecting: "on"`)
 * for this long before asking for a fresh connection. A fresh connection is a new session, which an FX3/FX3A
 * refuses (0x820A, "Connect_FailRejected") until it is put in pairing mode again; the SDK's reconnect resumes the
 * existing session and needs no pairing. Discovery keeps checking meanwhile, so a resumed camera shows at once.
 */
const SDK_RECONNECT_GRACE_MS = 20000;
/** A camera that vanished from discovery and came back (powered off, out of range) gets only this long. */
const SDK_REAPPEAR_GRACE_MS = 8000;
const SHUTDOWN_REQUEST_TIMEOUT_MS = 2000;
const SHUTDOWN_EXIT_WAIT_MS = 3000;
const TERM_EXIT_WAIT_MS = 2000;
const READY_POLL_MS = 250;
const READY_LIMIT_MS = 15000;
const DORMANT_HEALTH_MS = 60000;
const RESTART_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
const RESTART_WINDOW_MS = 300000;
const HEALTHY_RESET_MS = 300000;
const DISCOVERY_BURST_MS = [2000, 5000, 10000, 20000, 30000];
const DORMANT_DISCOVERY_MS = 60000;
const JITTER = 0.2;
const SAFE_ID = /^[A-Za-z0-9:-]{1,128}$/;
const SAFE_PROPERTY = /^[A-Za-z0-9-]{1,64}$/;

export type SonySidecarMode = 'disabled' | 'external' | 'managed' | 'absent';
export type SonySidecarState = 'disabled' | 'absent' | 'starting' | 'healthy' | 'crashed';
export type SonyCameraLifecycle =
  | 'discovered_unapproved' | 'connecting' | 'connected' | 'disconnected' | 'needs_pairing' | 'error';

export interface SonyRuntimeConfig { enabled: boolean; apiUrl: string; executable?: string; stateFile: string }

export interface SonyCameraStatus {
  id: string;
  approved: boolean;
  state: SonyCameraLifecycle;
  model?: string;
  connectionType?: string;
  lastSeenAt: string | null;
  nextRetryAt: string | null;
  message: string | null;
}

export interface SonyStatus {
  sidecar: {
    mode: SonySidecarMode; state: SonySidecarState; owned: boolean; apiUrl: string;
    version: string | null; sdkVersion: string | null; message: string | null;
  };
  cameras: SonyCameraStatus[];
}

/** Binary live-view frames never pass through JSON parsing. */
export interface SonyFrame { contentType: string; body: Buffer }

export interface SonySpawnOptions { cwd: string; shell: false; stdio: ['ignore', 'pipe', 'pipe'] }

export interface SonyChildProcess {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
  stdout?: { resume(): void } | null;
  stderr?: { resume(): void } | null;
}

type Timer = unknown;
type CameraRecord = SonyCameraStatus & { missing: boolean; /** Until when (ms) background connects leave it to the SDK's own reconnect. */ sdkGraceUntil?: number };

/** Retryable backpressure for polling reads that hit an occupied camera lane. */
export class SonyRetryableError extends Error {
  readonly statusCode = 503;
  readonly retryAfter = 1;
}

/** Curated upstream failure: it deliberately carries no upstream body, header, or URL text. */
export class SonyUpstreamError extends Error {
  constructor(readonly statusCode: number, message: string, readonly errorCode?: number) { super(message); }
}

export interface SonyManagerDependencies {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  spawn?: (command: string, args: string[], options: SonySpawnOptions) => SonyChildProcess;
  now?: () => Date;
  setTimeout?: (action: () => void, delay: number) => Timer;
  clearTimeout?: (timer: Timer) => void;
  random?: () => number;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
  /** Empty until a real sidecar contract probe pins exact codes; never guessed from messages. */
  pairingCodes?: number[];
}

/**
 * Optional Sony supervisor. Every upstream request, child process, and timer
 * crosses this boundary so failures stay isolated from the rest of the app.
 */
export class SonyManager {
  private readonly fetcher: NonNullable<SonyManagerDependencies['fetch']>;
  private readonly spawn: NonNullable<SonyManagerDependencies['spawn']>;
  private readonly now: () => Date;
  private readonly setTimer: NonNullable<SonyManagerDependencies['setTimeout']>;
  private readonly clearTimer: NonNullable<SonyManagerDependencies['clearTimeout']>;
  private readonly random: () => number;
  private readonly timeoutSignal: (milliseconds: number) => AbortSignal;
  private readonly pairingCodes: Set<number>;

  private mode: SonySidecarMode = 'disabled';
  private state: SonySidecarState = 'disabled';
  private owned = false;
  private version: string | null = null;
  private sdkVersion: string | null = null;
  private sidecarMessage: string | null = null;

  private started = false;
  private stopped = false;
  private stopping?: Promise<void>;
  private epoch = 0;
  private child?: SonyChildProcess;
  private childExited = false;
  private exitWaiters = new Set<() => void>();
  private sleepers = new Set<() => void>();

  private healthTimer?: Timer;
  private readyTimer?: Timer;
  private restartTimer?: Timer;
  private discoveryTimer?: Timer;
  private linkTimer?: Timer;
  private restartAttempts = 0;
  private outageStartedAt: number | null = null;
  private healthySince: number | null = null;
  private burstIndex = 0;
  private nextDiscoveryAt: string | null = null;

  private approved = new Map<string, ApprovedSonyCamera>();
  private cameras = new Map<string, CameraRecord>();
  private lanes = new Map<string, Promise<unknown>>();
  private reads = new Map<string, Promise<unknown>>();
  private tasks = new Set<Promise<unknown>>();

  constructor(
    private readonly config: SonyRuntimeConfig,
    private readonly store: SonyStateStore,
    dependencies: SonyManagerDependencies = {},
  ) {
    this.fetcher = dependencies.fetch ?? ((url, init) => fetch(url, init));
    this.spawn = dependencies.spawn ?? ((command, args, options) => nodeSpawn(command, args, options) as unknown as SonyChildProcess);
    this.now = dependencies.now ?? (() => new Date());
    this.setTimer = dependencies.setTimeout ?? ((action, delay) => setTimeout(action, delay));
    this.clearTimer = dependencies.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.random = dependencies.random ?? Math.random;
    this.timeoutSignal = dependencies.timeoutSignal ?? ((milliseconds) => AbortSignal.timeout(milliseconds));
    this.pairingCodes = new Set(dependencies.pairingCodes ?? []);
  }

  // ---------------------------------------------------------------- lifecycle

  /** Returns immediately: startup never waits on Sony. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    if (!this.config.enabled) { this.mode = 'disabled'; this.state = 'disabled'; return; }
    if (this.config.executable && !this.loopback()) throw new Error('Managed Sony sidecar requires a loopback apiUrl');
    this.mode = 'absent';
    this.state = 'starting';
    this.track(this.boot());
  }

  /** Resolves once every tracked background task has settled. Test/shutdown hook. */
  async whenIdle(): Promise<void> {
    while (this.tasks.size) await Promise.all([...this.tasks]);
  }

  stop(): Promise<void> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  private async shutdown(): Promise<void> {
    this.stopped = true;
    this.epoch++;
    this.cancelAllTimers();
    this.lanes.clear();
    this.reads.clear();
    const child = this.child;
    if (!this.owned || !child) return;
    try {
      await this.request('/api/server/shutdown', { method: 'POST' }, SHUTDOWN_REQUEST_TIMEOUT_MS);
    } catch (_) { /* graceful request is best effort */ }
    if (await this.waitForExit(SHUTDOWN_EXIT_WAIT_MS)) { this.child = undefined; return; }
    child.kill('SIGTERM');
    if (await this.waitForExit(TERM_EXIT_WAIT_MS)) { this.child = undefined; return; }
    child.kill('SIGKILL');
    this.child = undefined;
  }

  getStatus(): SonyStatus {
    return {
      sidecar: {
        mode: this.mode, state: this.state, owned: this.owned, apiUrl: this.config.apiUrl,
        version: this.version, sdkVersion: this.sdkVersion, message: this.sidecarMessage,
      },
      cameras: [...this.cameras.values()].map(({ missing: _missing, sdkGraceUntil: _grace, ...camera }) => ({ ...camera })),
    };
  }

  /** UI "Retry Sony service": clears the crash budget and boots again. */
  retryService(): void {
    if (!this.config.enabled) return;
    this.epoch++;
    this.stopped = false;
    this.stopping = undefined;
    this.cancelAllTimers();
    this.restartAttempts = 0;
    this.outageStartedAt = null;
    this.state = 'starting';
    this.sidecarMessage = null;
    this.track(this.boot());
  }

  private async boot(): Promise<void> {
    const epoch = this.epoch;
    this.approved = new Map((await this.store.load()).map((camera) => [camera.id, camera]));
    this.seedApprovedCameras();
    if (this.isStale(epoch)) return;
    if (await this.probe()) {
      if (this.isStale(epoch)) return;
      if (!this.owned) this.mode = 'external';
      this.state = 'healthy';
      this.sidecarMessage = null;
      this.healthySince = this.now().getTime();
      await this.discover();
      return;
    }
    if (this.isStale(epoch)) return;
    if (!this.config.executable || !this.executableUsable()) {
      this.markAbsent();
      this.scheduleHealthProbe();
      return;
    }
    await this.launch(epoch);
  }

  /**
   * List every saved (approved) camera from the start, even while it is off. Without this a camera
   * that is powered down when the app starts has no record at all: it is not shown, and nothing
   * retries it when it powers on, so a restart would look like the app forgot it.
   */
  private seedApprovedCameras(): void {
    for (const approved of this.approved.values()) {
      if (this.cameras.has(approved.id)) continue;
      this.cameras.set(approved.id, {
        id: approved.id, approved: true, state: 'disconnected',
        model: approved.model, connectionType: approved.connectionType,
        lastSeenAt: null, nextRetryAt: null, message: 'Camera not found', missing: true,
      });
    }
  }

  private async launch(epoch: number): Promise<void> {
    this.mode = 'managed';
    this.owned = true;
    this.state = 'starting';
    this.childExited = false;
    const child = this.spawn(this.config.executable as string, ['--port', this.port()], {
      cwd: path.dirname(this.config.executable as string), shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    // Drain both pipes so the child never blocks on a full buffer. Output is
    // discarded rather than retained: raw sidecar logs must not reach status/logs.
    child.stdout?.resume();
    child.stderr?.resume();
    const onExit = () => {
      if (this.child !== child) return;
      this.childExited = true;
      for (const waiter of [...this.exitWaiters]) waiter();
      if (this.stopped || this.isStale(epoch)) return;
      this.child = undefined;
      this.cancelDiscovery();
      this.markCamerasOffline();
      this.scheduleRestart();
    };
    child.on('exit', onExit);
    child.on('error', onExit);

    if (await this.waitForReady(epoch)) {
      if (this.isStale(epoch)) return;
      this.state = 'healthy';
      this.sidecarMessage = null;
      this.healthySince = this.now().getTime();
      await this.discover();
      return;
    }
    if (this.isStale(epoch)) return;
    // Detach before signalling so the resulting exit event cannot double-restart.
    this.child = undefined;
    child.kill('SIGTERM');
    this.sidecarMessage = 'Sony service failed to become ready';
    this.scheduleRestart();
  }

  private async waitForReady(epoch: number): Promise<boolean> {
    for (let elapsed = 0; elapsed < READY_LIMIT_MS; elapsed += READY_POLL_MS) {
      if (this.isStale(epoch)) return false;
      if (await this.probe()) return true;
      if (this.isStale(epoch)) return false;
      await this.sleep(READY_POLL_MS);
    }
    return false;
  }

  /** Cancellable sleep: cancelling timers must never strand a background task. */
  private sleep(milliseconds: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = (): void => { this.sleepers.delete(wake); this.clearTimer(timer); resolve(); };
      const timer = this.setTimer(wake, milliseconds);
      this.readyTimer = timer;
      this.sleepers.add(wake);
    });
  }

  private async probe(): Promise<boolean> {
    try {
      const body = await this.request('/api/server/status', undefined, HEALTH_TIMEOUT_MS) as any;
      if (!body?.success || !body?.server?.version || !body?.server?.sdkVersion) return false;
      this.version = String(body.server.version);
      this.sdkVersion = String(body.server.sdkVersion);
      return true;
    } catch (_) {
      return false;
    }
  }

  private scheduleRestart(): void {
    if (this.stopped) return;
    const at = this.now().getTime();
    // A healthy run of five minutes, or a five-minute gap, opens a fresh budget.
    const healthyLongEnough = this.healthySince !== null && at - this.healthySince >= HEALTHY_RESET_MS;
    const outageExpired = this.outageStartedAt === null || at - this.outageStartedAt > RESTART_WINDOW_MS;
    if (healthyLongEnough || outageExpired) { this.restartAttempts = 0; this.outageStartedAt = at; }
    this.healthySince = null;
    if (this.restartAttempts >= RESTART_DELAYS_MS.length) {
      this.state = 'crashed';
      this.sidecarMessage = 'Sony service stopped after repeated failures';
      return;
    }
    const delay = this.jitter(RESTART_DELAYS_MS[this.restartAttempts++]);
    this.state = 'starting';
    const epoch = this.epoch;
    this.restartTimer = this.setTimer(() => {
      this.restartTimer = undefined;
      if (this.isStale(epoch)) return;
      this.track(this.boot());
    }, delay);
  }

  private scheduleHealthProbe(): void {
    if (this.stopped || this.healthTimer) return;
    const epoch = this.epoch;
    this.healthTimer = this.setTimer(() => {
      this.healthTimer = undefined;
      if (this.isStale(epoch)) return;
      this.track(this.boot());
    }, DORMANT_HEALTH_MS);
  }

  private markAbsent(): void {
    this.mode = 'absent';
    this.state = 'absent';
    this.owned = false;
    this.sidecarMessage = 'Sony service unavailable';
    this.markCamerasOffline();
  }

  // ---------------------------------------------------------------- discovery

  async discover(): Promise<SonyCameraStatus[]> {
    if (this.stopped || this.state !== 'healthy') return this.getStatus().cameras;
    let found: any[];
    try {
      const body = await this.request('/api/cameras', undefined, DISCOVERY_TIMEOUT_MS) as any;
      found = Array.isArray(body?.cameras) ? body.cameras : [];
    } catch (_) {
      // A failed or slow scan is not proof the sidecar is gone: only declare
      // loss when the health endpoint is also unreachable.
      if (!(await this.probe())) this.handleSidecarLoss();
      return this.getStatus().cameras;
    }
    const seen = new Set<string>();
    const reconnect: string[] = [];
    for (const raw of found) {
      if (!this.safeId(raw?.id)) continue;
      const id: string = raw.id;
      seen.add(id);
      const previous = this.cameras.get(id);
      const approved = this.approved.has(id);
      const connected = this.connectedFlag(raw);
      if (previous?.missing && approved) this.burstIndex = 0; // reappearance starts a fresh burst
      const nowMs = this.now().getTime();
      const sdkGraceUntil = connected ? undefined
        : previous?.state === 'connected' && !previous.missing ? nowMs + SDK_RECONNECT_GRACE_MS // dropped while still on the network
          // Back after dropping and vanishing in this run: only a short beat for the SDK first. A camera never
          // connected in this run (e.g. at startup) has no session to resume and gets no grace at all.
          : previous?.missing && previous.sdkGraceUntil !== undefined ? Math.min(previous.sdkGraceUntil, nowMs + SDK_REAPPEAR_GRACE_MS)
            : previous?.sdkGraceUntil;
      this.cameras.set(id, {
        id,
        approved,
        state: this.discoveredState(previous, approved, connected),
        model: typeof raw.model === 'string' ? raw.model : previous?.model,
        connectionType: typeof raw.connectionType === 'string' ? raw.connectionType : previous?.connectionType,
        lastSeenAt: this.now().toISOString(),
        nextRetryAt: null,
        message: connected ? null : previous?.message ?? null,
        missing: false,
        sdkGraceUntil,
      });
      // Only remembered cameras get background work; unknown IDs wait for an explicit Connect. A camera that
      // just dropped is left to the SDK's own reconnect first (see SDK_RECONNECT_GRACE_MS).
      const inGrace = sdkGraceUntil !== undefined && nowMs < sdkGraceUntil;
      if (approved && !connected && previous?.state !== 'needs_pairing' && !inGrace) reconnect.push(id);
    }
    for (const [id, camera] of [...this.cameras]) {
      if (seen.has(id)) continue;
      if (!camera.approved) { this.cameras.delete(id); continue; }
      if (camera.state === 'connected') camera.sdkGraceUntil = this.now().getTime() + SDK_RECONNECT_GRACE_MS;
      camera.missing = true;
      if (camera.state !== 'needs_pairing') camera.state = 'disconnected';
      camera.message = camera.message ?? 'Camera not found';
    }
    for (const id of reconnect) this.track(this.connect(id, true).catch(() => undefined));
    this.refreshDiscoverySchedule();
    return this.getStatus().cameras;
  }

  private discoveredState(previous: CameraRecord | undefined, approved: boolean, connected: boolean): SonyCameraLifecycle {
    if (!approved) return 'discovered_unapproved';
    if (connected) return 'connected';
    if (previous?.state === 'needs_pairing' || previous?.state === 'error') return previous.state;
    return 'disconnected';
  }

  /** One shared timer for every pending camera: an outage costs one probe, not N. */
  private refreshDiscoverySchedule(): void {
    this.refreshLinkCheck();
    const pending = [...this.cameras.values()].some((camera) => camera.approved && camera.state !== 'connected');
    if (!pending || this.stopped || this.state !== 'healthy') {
      this.cancelDiscovery();
      this.burstIndex = 0;
      this.nextDiscoveryAt = null;
      this.stampRetry();
      return;
    }
    if (this.discoveryTimer) { this.stampRetry(); return; }
    const base = this.burstIndex < DISCOVERY_BURST_MS.length ? DISCOVERY_BURST_MS[this.burstIndex++] : DORMANT_DISCOVERY_MS;
    const delay = this.jitter(base);
    this.nextDiscoveryAt = new Date(this.now().getTime() + delay).toISOString();
    this.stampRetry();
    const epoch = this.epoch;
    this.discoveryTimer = this.setTimer(() => {
      this.discoveryTimer = undefined;
      if (this.isStale(epoch)) return;
      this.track(this.discover());
    }, delay);
  }

  /** A camera that loses power never announces it, so re-check the link of every camera shown as connected. */
  private refreshLinkCheck(): void {
    const watching = !this.stopped && this.state === 'healthy' && [...this.cameras.values()].some((camera) => camera.state === 'connected');
    if (!watching) { this.cancelLinkCheck(); return; }
    if (this.linkTimer) return;
    const epoch = this.epoch;
    this.linkTimer = this.setTimer(() => {
      this.linkTimer = undefined;
      if (this.isStale(epoch)) return;
      this.track(this.checkLinks(epoch).finally(() => { if (!this.isStale(epoch)) this.refreshLinkCheck(); }));
    }, LINK_CHECK_MS);
  }

  private async checkLinks(epoch: number): Promise<void> {
    let lost = false;
    for (const camera of [...this.cameras.values()]) {
      if (camera.state !== 'connected') continue;
      try {
        const body = await this.request(`${this.cameraPath(camera.id)}/connection`, undefined, LINK_CHECK_TIMEOUT_MS);
        if (this.isStale(epoch)) return;
        if (!this.connectedFlag(body) && camera.state === 'connected') {
          camera.state = 'disconnected';
          camera.message = 'Camera stopped responding';
          camera.sdkGraceUntil = this.now().getTime() + SDK_RECONNECT_GRACE_MS;
          lost = true;
        }
      } catch (_) { /* inconclusive: a sidecar outage is handled by the health probe, not here */ }
    }
    if (lost) { this.burstIndex = 0; this.refreshDiscoverySchedule(); }
  }

  private cancelLinkCheck(): void {
    if (this.linkTimer) this.clearTimer(this.linkTimer);
    this.linkTimer = undefined;
  }

  private stampRetry(): void {
    for (const camera of this.cameras.values()) {
      camera.nextRetryAt = camera.approved && camera.state !== 'connected' ? this.nextDiscoveryAt : null;
    }
  }

  private handleSidecarLoss(): void {
    if (this.stopped || this.owned) return;
    this.markAbsent();
    this.cancelDiscovery();
    this.scheduleHealthProbe();
  }

  private markCamerasOffline(): void {
    for (const camera of this.cameras.values()) {
      if (!camera.approved) continue;
      camera.missing = true;
      camera.nextRetryAt = null;
      if (camera.state !== 'needs_pairing') camera.state = 'disconnected';
    }
  }

  // ------------------------------------------------------------ camera actions

  /** `automatic` is background work: it may only ever target an already-approved camera. */
  async connect(id: string, automatic = false): Promise<void> {
    this.assertId(id);
    if (automatic && !this.approved.has(id)) throw new Error('Sony automatic connect requires an approved camera');
    await this.operation(id, async () => {
      const previous = this.cameras.get(id);
      if (previous) previous.state = 'connecting';
      try {
        const body = await this.request(`${this.cameraPath(id)}/connection`, {
          // `reconnecting: "on"` lets the SDK resume this session by itself after a Wi-Fi blip (no re-pairing).
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'remote', reconnecting: 'on' }),
        }, CONNECT_TIMEOUT_MS) as any;
        const camera = this.normalizeCamera(body, id, previous);
        // Only an explicit, successful Connect persists approval.
        if (!automatic) await this.store.approve({ id, model: camera.model, connectionType: camera.connectionType });
        if (!automatic) this.approved.set(id, { ...this.approved.get(id), id, model: camera.model, connectionType: camera.connectionType, approvedAt: this.approved.get(id)?.approvedAt ?? this.now().toISOString() });
        this.cameras.set(id, { ...camera, approved: this.approved.has(id), state: 'connected', missing: false });
        this.refreshDiscoverySchedule();
      } catch (error) {
        const camera = this.cameras.get(id);
        if (camera) {
          camera.state = this.classifyConnectionFailure(error);
          camera.message = this.curatedMessage(error);
        }
        this.refreshDiscoverySchedule();
        throw error;
      }
    });
  }

  /** Cancels this camera's future automatic work before the approval is removed. */
  async forget(id: string): Promise<void> {
    this.assertId(id);
    this.approved.delete(id);
    this.lanes.delete(id);
    for (const key of [...this.reads.keys()]) if (key.startsWith(`${id}:`)) this.reads.delete(key);
    const camera = this.cameras.get(id);
    if (camera) { camera.approved = false; camera.state = 'discovered_unapproved'; camera.nextRetryAt = null; camera.message = null; }
    this.refreshDiscoverySchedule();
    await this.store.forget(id);
  }

  async retryCamera(id: string): Promise<void> {
    this.assertId(id);
    await this.connect(id, this.approved.has(id));
  }

  properties(id: string): Promise<unknown> {
    return this.readOnce(id, 'properties', () => this.request(`${this.cameraPath(id)}/properties/all`, undefined, PROPERTIES_TIMEOUT_MS));
  }

  property(id: string, name: string, init?: RequestInit): Promise<unknown> {
    const suffix = `${this.cameraPath(id)}/properties/${this.safeProperty(name)}`;
    if (!init?.method || init.method === 'GET') return this.readOnce(id, `property:${name}`, () => this.request(suffix, init, READ_TIMEOUT_MS));
    return this.operation(id, () => this.request(suffix, init, READ_TIMEOUT_MS));
  }

  liveViewStart(id: string): Promise<unknown> {
    return this.operation(id, () => this.request(`${this.cameraPath(id)}/live-view/start`, { method: 'POST' }, READ_TIMEOUT_MS));
  }

  liveViewFrame(id: string): Promise<SonyFrame> {
    return this.readOnce(id, 'frame', () => this.requestBinary(`${this.cameraPath(id)}/live-view/frame`, FRAME_TIMEOUT_MS));
  }

  touch(id: string, normalized: { x: number; y: number }): Promise<unknown> {
    if (![normalized?.x, normalized?.y].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)) {
      throw new Error('Sony touch coordinates must be finite and normalized');
    }
    return this.operation(id, () => this.request(`${this.cameraPath(id)}/actions/touch`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ normalized: { x: normalized.x, y: normalized.y } }),
    }, READ_TIMEOUT_MS));
  }

  /** Encoded for upstream safety, but the sidecar's literal colons survive. */
  cameraPath(id: string): string {
    this.assertId(id);
    return `/api/cameras/${encodeURIComponent(id).replace(/%3A/gi, ':')}`;
  }

  classifyConnectionFailure(error: unknown): 'needs_pairing' | 'disconnected' | 'error' {
    const code = (error as SonyUpstreamError)?.errorCode;
    if (typeof code === 'number' && this.pairingCodes.has(code)) return 'needs_pairing';
    const status = (error as SonyUpstreamError)?.statusCode;
    if (status === 404 || status === 502 || status === 503 || status === 504) return 'disconnected';
    const message = String((error as Error)?.message ?? '');
    return /ECONNREFUSED|ETIMEDOUT|timed out|unavailable|not found|powered off/i.test(message) ? 'disconnected' : 'error';
  }

  private curatedMessage(error: unknown): string {
    const classification = this.classifyConnectionFailure(error);
    if (classification === 'needs_pairing') return 'Camera needs pairing or camera-side setup';
    if (classification === 'disconnected') return 'Camera not found or powered off';
    return 'Camera connection failed';
  }

  private normalizeCamera(body: any, id: string, previous?: CameraRecord): CameraRecord {
    const nested = { ...(body ?? {}), ...(body?.camera ?? {}), ...(body?.data ?? {}), ...(body?.data?.camera ?? {}) };
    return {
      id,
      approved: previous?.approved ?? false,
      state: 'connected',
      model: typeof nested.model === 'string' ? nested.model : previous?.model,
      connectionType: typeof nested.connectionType === 'string' ? nested.connectionType : previous?.connectionType,
      lastSeenAt: this.now().toISOString(),
      nextRetryAt: null,
      message: null,
      missing: false,
    };
  }

  private connectedFlag(raw: any): boolean {
    return !!(raw?.camera?.connected ?? raw?.data?.connected ?? raw?.connected);
  }

  // ------------------------------------------------------------------- lanes

  /** One in-flight operation per camera; a busy lane is retryable backpressure. */
  private async operation<T>(id: string, run: () => Promise<T>): Promise<T> {
    this.assertId(id);
    if (this.lanes.has(id)) throw new SonyRetryableError('Sony camera operation is busy');
    const work = run();
    this.lanes.set(id, work.catch(() => undefined));
    try {
      return await work;
    } finally {
      this.lanes.delete(id);
    }
  }

  /** Polling reads coalesce onto one in-flight request instead of queueing. */
  private async readOnce<T>(id: string, key: string, run: () => Promise<T>): Promise<T> {
    this.assertId(id);
    const lane = `${id}:${key}`;
    const inFlight = this.reads.get(lane) as Promise<T> | undefined;
    if (inFlight) return inFlight;
    if (this.lanes.has(id)) throw new SonyRetryableError('Sony camera operation is busy');
    const work = run();
    this.reads.set(lane, work);
    void work.catch(() => undefined).then(() => { if (this.reads.get(lane) === work) this.reads.delete(lane); });
    return work;
  }

  // ----------------------------------------------------------------- upstream

  private async request(endpoint: string, init: RequestInit | undefined, timeoutMs: number): Promise<unknown> {
    const response = await this.fetchUpstream(endpoint, init, timeoutMs);
    const body: any = await response.json().catch(() => ({}));
    if (!response.ok) throw new SonyUpstreamError(response.status, `Sony upstream ${response.status}`, this.errorCode(body));
    return body;
  }

  private async requestBinary(endpoint: string, timeoutMs: number): Promise<SonyFrame> {
    const response = await this.fetchUpstream(endpoint, undefined, timeoutMs);
    const body = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw new SonyUpstreamError(response.status, `Sony upstream ${response.status}`);
    return { contentType: response.headers.get('content-type') ?? 'image/jpeg', body };
  }

  private async fetchUpstream(endpoint: string, init: RequestInit | undefined, timeoutMs: number): Promise<Response> {
    try {
      return await this.fetcher(`${this.config.apiUrl}${endpoint}`, { ...init, signal: this.timeoutSignal(timeoutMs) });
    } catch (error) {
      const name = (error as Error)?.name;
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      // Transport detail is dropped: it can carry URLs and credentials.
      throw new SonyUpstreamError(timedOut ? 504 : 502, timedOut ? 'Sony service timed out' : 'Sony service unavailable');
    }
  }

  private errorCode(body: any): number | undefined {
    const code = body?.data?.error_code ?? body?.error_code;
    return typeof code === 'number' ? code : undefined;
  }

  // ------------------------------------------------------------------ helpers

  private track(work: Promise<unknown>): void {
    const tracked = work.catch(() => undefined).then(() => { this.tasks.delete(tracked); });
    this.tasks.add(tracked);
  }

  private isStale(epoch: number): boolean {
    return this.stopped || this.epoch !== epoch;
  }

  private waitForExit(milliseconds: number): Promise<boolean> {
    if (this.childExited) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const waiter = () => { this.exitWaiters.delete(waiter); this.clearTimer(timer); resolve(true); };
      const timer = this.setTimer(() => { this.exitWaiters.delete(waiter); resolve(false); }, milliseconds);
      this.exitWaiters.add(waiter);
    });
  }

  private jitter(base: number): number {
    return Math.round(base * (1 + (this.random() * 2 - 1) * JITTER));
  }

  private cancelDiscovery(): void {
    if (this.discoveryTimer) this.clearTimer(this.discoveryTimer);
    this.discoveryTimer = undefined;
  }

  private cancelAllTimers(): void {
    for (const timer of [this.healthTimer, this.readyTimer, this.restartTimer, this.discoveryTimer, this.linkTimer]) {
      if (timer) this.clearTimer(timer);
    }
    this.healthTimer = this.readyTimer = this.restartTimer = this.discoveryTimer = this.linkTimer = undefined;
    for (const wake of [...this.sleepers]) wake();
  }

  private port(): string {
    return new URL(this.config.apiUrl).port;
  }

  private loopback(): boolean {
    const host = new URL(this.config.apiUrl).hostname;
    return host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === 'localhost';
  }

  /** Absolute, existing, regular, and executable — or it is not launched at all. */
  private executableUsable(): boolean {
    const executable = this.config.executable as string;
    if (!path.isAbsolute(executable)) return false;
    try {
      if (!fs.statSync(executable).isFile()) return false;
      fs.accessSync(executable, fs.constants.X_OK);
      return true;
    } catch (_) {
      return false;
    }
  }

  private safeId(id: unknown): id is string {
    return typeof id === 'string' && SAFE_ID.test(id);
  }

  private assertId(id: unknown): asserts id is string {
    if (!this.safeId(id)) throw new Error('Sony camera ID must be a safe identifier');
  }

  private safeProperty(name: string): string {
    if (typeof name !== 'string' || !SAFE_PROPERTY.test(name)) throw new Error('Sony property name must be a safe identifier');
    return name;
  }
}
