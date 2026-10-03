import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';

/**
 * The switcher's PROGRAM output, captured on this Mac and shown in the iPad's PGM pane (docs/program-feed.md).
 * One supervised ffmpeg child turns the capture device into an MJPEG stream on stdout; only the latest JPEG is kept.
 * Started lazily on the first frame request, stopped after 15 s without one, restarted with backoff (1 s → 30 s)
 * while it is wanted, and killed with the app. CAMCONTROL_FAKE_PROGRAM=1 (the interactive sandbox) synthesises
 * an SVG test frame instead and never spawns anything.
 */
export type ProgramKind = 'avfoundation' | 'decklink';
export interface ProgramConfig { enabled: boolean; input: string | null; kind: ProgramKind | null; formatCode: string | null; fps: number; width: number; ffmpegPath: string }
export interface ProgramDevice { index: number; name: string; kind: ProgramKind }
export interface ProgramFrame { body: Buffer; type: string; at: number }
export interface ProgramStatus { enabled: boolean; device: string | null; kind: ProgramKind | null; running: boolean; fps: number; lastFrameAgoMs: number | null; error: string | null }
export const PROGRAM_DEFAULTS: ProgramConfig = { enabled: false, input: null, kind: null, formatCode: null, fps: 10, width: 960, ffmpegPath: 'ffmpeg' };

const IDLE_MS = 15000, FRAME_WAIT_MS = 4000, LIST_CACHE_MS = 10000, BACKOFF_MIN = 1000, BACKOFF_MAX = 30000;
const BLACKMAGIC = /decklink|ultrastudio|intensity|blackmagic/i;
const SOI = Buffer.from([0xff, 0xd8]), EOI = Buffer.from([0xff, 0xd9]);

/** Splits an MJPEG byte stream (concatenated JPEGs, FFD8 … FFD9) into whole frames, across chunk boundaries. */
export class MjpegSplitter {
  private buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Buffer[] = [];
    for (;;) {
      const start = this.buf.indexOf(SOI);
      if (start < 0) { this.buf = this.buf.subarray(Math.max(0, this.buf.length - 1)); break; } // keep a split FF
      const end = this.buf.indexOf(EOI, start + 2);
      if (end < 0) { this.buf = this.buf.subarray(start); break; }
      out.push(Buffer.from(this.buf.subarray(start, end + 2)));
      this.buf = this.buf.subarray(end + 2);
    }
    // ponytail: a stream with no EOI for 8 MB is garbage; drop it rather than grow forever.
    if (this.buf.length > 8 * 1024 * 1024) this.buf = Buffer.alloc(0);
    return out;
  }
}

const strip = (line: string): string => line.replace(/^\[[^\]]*\]\s?/, '');
/** `[N] Name` lines under "AVFoundation video devices" (screens left out: they are not capture cards). */
export function parseAvfoundationDevices(stderr: string): ProgramDevice[] {
  const out: ProgramDevice[] = [];
  let video = false;
  for (const raw of stderr.split(/\r?\n/)) {
    const line = strip(raw);
    if (/AVFoundation video devices/.test(line)) { video = true; continue; }
    if (/AVFoundation audio devices/.test(line)) { video = false; continue; }
    const m = video ? /^\[(\d+)\]\s+(.+?)\s*$/.exec(line) : null;
    if (m && !/^Capture screen/.test(m[2])) out.push({ index: Number(m[1]), name: m[2], kind: 'avfoundation' });
  }
  return out;
}
/** `ffmpeg -sources decklink` ("  Name [description]") or the older `-list_devices 1` stderr ("  'Name'"). */
export function parseDecklinkDevices(text: string): ProgramDevice[] {
  const names: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = strip(raw);
    const m = /^\s*\*?\s*(.+?) \[.*\]\s*$/.exec(line) ?? /^\s*'(.+)'\s*$/.exec(line);
    if (m && !/^Auto-detected/.test(m[1])) names.push(m[1]);
  }
  return [...new Set(names)].map((name, index) => ({ index, name, kind: 'decklink' as const }));
}
/** `-list_formats 1`: "\tHp30\t\t1920x1080 at 30000/1001 fps" → { code, description }. */
export function parseDecklinkFormats(stderr: string): { code: string; description: string }[] {
  return stderr.split(/\r?\n/).map(strip).map(line => /^\s*(\S{2,4})\s+(\d+x\d+ .+?)\s*$/.exec(line))
    .filter((m): m is RegExpExecArray => !!m).map(m => ({ code: m[1], description: m[2] }));
}
/** By name: exact, then case-insensitive substring; a bare number is a last-resort index. */
export function matchDevice(devices: ProgramDevice[], input: string | null): ProgramDevice | null {
  if (!input) return null;
  const lower = input.toLowerCase();
  return devices.find(d => d.name === input) ?? devices.find(d => d.name.toLowerCase().includes(lower))
    ?? (/^\d+$/.test(input) ? devices.find(d => d.index === Number(input)) ?? null : null);
}

const esc = (s: string): string => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
/** The sandbox's program picture: SMPTE-style bars, a PROGRAM slate, the program camera, a timecode and the lower third. */
export function fakeProgramSvg(cameraLabel: string, lowerThird: boolean, now = new Date()): string {
  const w = 640 / 7;
  const bars = (colors: string[], y: number, h: number): string =>
    colors.map((c, i) => `<rect x="${(i * w).toFixed(2)}" y="${y}" width="${(w + 0.5).toFixed(2)}" height="${h}" fill="${c}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
<rect width="640" height="360" fill="#101010"/>
${bars(['#bfbfbf', '#bfbf00', '#00bfbf', '#00bf00', '#bf00bf', '#bf0000', '#0000bf'], 0, 206)}
${bars(['#0000bf', '#131313', '#bf00bf', '#131313', '#00bfbf', '#131313', '#bfbfbf'], 206, 28)}
<rect x="170" y="62" width="300" height="84" fill="#000000" fill-opacity="0.7"/>
<text x="320" y="112" fill="#ffffff" font-family="Helvetica, Arial, sans-serif" font-size="44" font-weight="700" text-anchor="middle">PROGRAM</text>
<text x="320" y="136" fill="#d0d0d0" font-family="monospace" font-size="16" text-anchor="middle">${esc(cameraLabel)}</text>
${lowerThird ? '<g id="lower-third"><rect x="0" y="282" width="640" height="46" fill="#0b3d91"/><rect x="0" y="282" width="10" height="46" fill="#ffb000"/><text x="28" y="312" fill="#ffffff" font-family="Helvetica, Arial, sans-serif" font-size="20" font-weight="700">LOWER THIRD · Sandbox Speaker</text></g>' : ''}
<text x="596" y="350" fill="#d0d0d0" font-family="monospace" font-size="14" text-anchor="end">${now.toISOString().slice(11, 23)}</text></svg>`;
}

/** Runs a short ffmpeg probe and returns its stdout + stderr (bounded: 64 KB, 5 s). '' when ffmpeg is missing. */
function probe(bin: string, args: string[]): Promise<string> {
  return new Promise(resolve => {
    let text = '';
    let child: ChildProcess;
    try { child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch { resolve(''); return; }
    const add = (b: Buffer): void => { if (text.length < 65536) text += b.toString('utf8'); };
    child.stdout?.on('data', add); child.stderr?.on('data', add);
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('error', () => { clearTimeout(timer); resolve(''); });
    child.once('close', () => { clearTimeout(timer); resolve(text); });
  });
}

export class ProgramFeed {
  private child: ChildProcess | null = null;
  private latest: ProgramFrame | null = null;
  private lastAsked = 0;
  private backoff = BACKOFF_MIN;
  private restartTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private error: string | null = null;
  private device: ProgramDevice | null = null;
  private listCache: { at: number; bin: string; devices: ProgramDevice[] } | null = null;
  private decklinkSupport = new Map<string, Promise<boolean>>();
  private starting = false;

  constructor(private cfg: ProgramConfig, private readonly fake?: () => { cameraLabel: string; lowerThird: boolean }) {
    // Never outlive the app: however this process ends normally, ffmpeg goes with it. (A SIGKILLed app closes the
    // stdout pipe, and ffmpeg exits on its next write.)
    process.once('exit', () => { this.child?.kill('SIGKILL'); });
  }

  /** The ffmpeg to run: the configured one; plain "ffmpeg" prefers Homebrew's (launchd's PATH lacks /opt/homebrew/bin). */
  private bin(): string {
    return this.cfg.ffmpegPath === 'ffmpeg' && fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : this.cfg.ffmpegPath;
  }

  configure(cfg: ProgramConfig): void {
    this.stop();
    this.cfg = cfg;
    this.listCache = null;
    this.error = null; this.device = null; this.latest = null; this.backoff = BACKOFF_MIN;
  }

  /** Whether this ffmpeg was built with the DeckLink demuxer (`ffmpeg -devices`), once per binary. */
  hasDecklink(): Promise<boolean> {
    const bin = this.bin();
    let known = this.decklinkSupport.get(bin);
    if (!known) { known = probe(bin, ['-hide_banner', '-devices']).then(text => /decklink/.test(text)); this.decklinkSupport.set(bin, known); }
    return known;
  }

  async devices(): Promise<ProgramDevice[]> {
    if (this.fake) return [{ index: 0, name: 'Fake program capture', kind: 'avfoundation' }];
    const bin = this.bin();
    if (this.listCache && this.listCache.bin === bin && Date.now() - this.listCache.at < LIST_CACHE_MS) return this.listCache.devices;
    const av = parseAvfoundationDevices(await probe(bin, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']));
    let dl: ProgramDevice[] = [];
    if (await this.hasDecklink()) {
      dl = parseDecklinkDevices(await probe(bin, ['-hide_banner', '-sources', 'decklink']));
      if (!dl.length) dl = parseDecklinkDevices(await probe(bin, ['-hide_banner', '-f', 'decklink', '-list_devices', '1', '-i', 'dummy']));
    }
    const devices = [...av, ...dl];
    this.listCache = { at: Date.now(), bin, devices };
    return devices;
  }

  /** The DeckLink device's video modes, for program.formatCode. Empty when ffmpeg has no DeckLink support. */
  async formats(): Promise<{ code: string; description: string }[]> {
    if (this.fake || !this.cfg.input || !(await this.hasDecklink())) return [];
    return parseDecklinkFormats(await probe(this.bin(), ['-hide_banner', '-f', 'decklink', '-list_formats', '1', '-i', this.cfg.input]));
  }

  status(): ProgramStatus {
    return {
      enabled: this.cfg.enabled,
      device: this.fake ? 'Fake program capture' : this.device?.name ?? this.cfg.input,
      kind: this.device?.kind ?? this.cfg.kind,
      running: this.cfg.enabled && (this.fake ? true : !!this.child),
      fps: this.cfg.fps,
      lastFrameAgoMs: this.latest ? Date.now() - this.latest.at : null,
      error: this.cfg.enabled ? this.error : null,
    };
  }

  /** The latest frame no older than 4 s, waiting up to 4 s for one (and starting ffmpeg if it is down). null = none. */
  async frame(): Promise<ProgramFrame | null> {
    if (!this.cfg.enabled) return null;
    if (this.fake) { const s = this.fake(); return { body: Buffer.from(fakeProgramSvg(s.cameraLabel, s.lowerThird)), type: 'image/svg+xml', at: Date.now() }; }
    this.lastAsked = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), IDLE_MS); this.idleTimer.unref();
    if (!this.child && !this.restartTimer) void this.start();
    const deadline = Date.now() + FRAME_WAIT_MS;
    for (;;) {
      if (this.latest && Date.now() - this.latest.at < FRAME_WAIT_MS) return this.latest;
      if (Date.now() >= deadline) return null;
      await new Promise(r => setTimeout(r, 100));
    }
  }

  private wanted(): boolean { return this.cfg.enabled && Date.now() - this.lastAsked < IDLE_MS; }

  private async start(): Promise<void> {
    if (this.starting || this.child || !this.wanted()) return;
    this.starting = true;
    try {
      const bin = this.bin(), named = this.cfg.input;
      if (!named) { this.error = 'No capture device chosen'; return; }
      // Matched by name at every (re)start: AVFoundation indices shift when a camera is plugged in.
      const found = matchDevice(await this.devices(), named);
      const kind: ProgramKind = this.cfg.kind ?? found?.kind ?? (BLACKMAGIC.test(named) ? 'decklink' : 'avfoundation');
      if (kind === 'decklink' && !(await this.hasDecklink())) {
        // No restart loop: nothing changes until ffmpegPath does.
        this.error = `ffmpeg at ${bin} has no DeckLink support — build it with --enable-decklink (see docs/program-feed.md)`;
        return;
      }
      const device = found && found.kind === kind ? found : null;
      if (!device) { this.error = `No ${kind === 'decklink' ? 'DeckLink' : 'AVFoundation'} capture device matches "${named}"`; this.scheduleRestart(); return; }
      this.device = device;
      const out = ['-vf', `fps=${this.cfg.fps},scale=${this.cfg.width}:-2`, '-q:v', '5', '-f', 'mjpeg', 'pipe:1'];
      this.spawnCapture(bin, kind === 'decklink'
        ? ['-hide_banner', '-loglevel', 'error', '-f', 'decklink', '-raw_format', 'uyvy422', ...(this.cfg.formatCode ? ['-format_code', this.cfg.formatCode] : []), '-i', device.name, ...out]
        : ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation', '-framerate', '30', '-video_size', '1280x720', '-i', `${device.index}:none`, ...out]);
    } finally { this.starting = false; }
  }

  private spawnCapture(bin: string, args: string[]): void {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    const splitter = new MjpegSplitter();
    let stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      const frames = splitter.push(chunk);
      if (frames.length) { this.latest = { body: frames[frames.length - 1], type: 'image/jpeg', at: Date.now() }; this.error = null; this.backoff = BACKOFF_MIN; }
    });
    // The stderr tail is what the iPad sees: a missing camera permission or device shows up there.
    child.stderr!.on('data', (b: Buffer) => { stderr = (stderr + b.toString('utf8')).slice(-400); });
    child.once('error', (err) => { this.error = `ffmpeg could not start (${bin}): ${err.message}`; });
    child.once('close', (code, signal) => {
      if (this.child !== child) return; // stopped on purpose
      this.child = null;
      const tail = stderr.trim().split(/\r?\n/).slice(-3).join(' ').trim();
      if (tail || !this.error) this.error = tail || `ffmpeg exited (${code ?? signal})`;
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (!this.wanted() || this.restartTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX);
    this.restartTimer = setTimeout(() => { this.restartTimer = null; void this.start(); }, delay);
    this.restartTimer.unref();
  }

  /** Stops ffmpeg: SIGTERM, then SIGKILL after 1 s (the tracking helper's bound). */
  stop(): void {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1000);
    timer.unref();
    child.once('close', () => clearTimeout(timer));
  }
}
