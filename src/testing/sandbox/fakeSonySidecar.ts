import http from 'http';

/**
 * A stand-in for the Sony "CameraWebApp" sidecar (crsdk/alpha-sdk-api), for the
 * sandbox and for tests. It speaks the routes CamControl uses, in the shapes the
 * real service returns, and adds a /__sandbox control API so a tester can power
 * cameras on and off or open a camera's pairing mode without touching hardware.
 *
 * Behaviours copied from the real service on purpose:
 *  - only powered-on cameras are listed; a scan can be slow (scanDelayMs);
 *  - setting values must be strings: a hex value ("0x190") or the formatted
 *    text ("F4"); raw JSON numbers are refused with 400;
 *  - a camera that needs pairing refuses connect with error 0x0000820A until
 *    pairing is opened;
 *  - a read-only property (aperture on a lens with its own ring) reports
 *    writable:false and no options;
 *  - a camera that loses power stops being connected on its own;
 *  - battery-remain is a read-only percent ("82%"), 0xFFFF when the SDK has no reading.
 */

interface Option { value: number; hex: string; formatted: string }
interface Prop { name: string; options: Option[]; current: number; writable: boolean }

const hex = (value: number): string => `0x${value.toString(16)}`;
const apertureValues = [180, 200, 220, 250, 280, 320, 350, 400, 450, 500, 560, 630, 710, 800, 900, 1000, 1100, 1300, 1400, 1600, 1800, 2000, 2200];
const shutterDenominators = [4, 5, 6, 8, 10, 13, 15, 20, 25, 30, 40, 50, 60, 80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400, 8000];
const isoValues = [80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400, 8000, 10000, 12800, 16000, 20000, 25600, 32000, 40000, 51200, 64000, 80000, 102400];

function makeProps(readOnlyAperture: boolean): Prop[] {
  const aperture: Option[] = apertureValues.map((v) => ({ value: v, hex: hex(v), formatted: `F${(v / 100).toString()}` }));
  const shutter: Option[] = shutterDenominators.map((d) => ({ value: 0x10000 + d, hex: hex(0x10000 + d), formatted: `1/${d}` }));
  const iso: Option[] = [{ value: 0xffffff, hex: '0xffffff', formatted: 'ISO AUTO' }, ...isoValues.map((v) => ({ value: v, hex: hex(v), formatted: `ISO ${v}` }))];
  const wb: Option[] = [['AWB', 0], ['Daylight', 0x11], ['Shade', 0x12], ['Cloudy', 0x13], ['Incandescent', 0x14], ['Fluorescent', 0x15]]
    .map(([formatted, value]) => ({ value: value as number, hex: hex(value as number), formatted: formatted as string }));
  const focusMode: Option[] = [['AF_C', 3], ['MF', 1]].map(([formatted, value]) => ({ value: value as number, hex: hex(value as number), formatted: formatted as string }));
  const focusArea: Option[] = [['Wide', 1], ['Zone', 2], ['Center', 3], ['Flexible Spot S', 4], ['Flexible Spot M', 5], ['Flexible Spot L', 6], ['Expand Flexible Spot', 7]]
    .map(([formatted, value]) => ({ value: value as number, hex: hex(value as number), formatted: formatted as string }));
  const zoomSetting: Option[] = [['Optical Zoom Only', 1], ['Smart Zoom Only', 2], ['Clear Image Zoom', 3], ['Digital Zoom', 4]]
    .map(([formatted, value]) => ({ value: value as number, hex: hex(value as number), formatted: formatted as string }));
  return [
    { name: 'aperture', options: readOnlyAperture ? [] : aperture, current: readOnlyAperture ? 160 : 800, writable: !readOnlyAperture },
    { name: 'shutter-speed', options: shutter, current: 0x10000 + 125, writable: true },
    { name: 'iso', options: iso, current: 0xffffff, writable: true },
    { name: 'white-balance', options: wb, current: 0, writable: true },
    { name: 'focus-mode', options: focusMode, current: 3, writable: true },
    { name: 'focus-area', options: focusArea, current: 1, writable: true },
    { name: 'zoom-setting', options: zoomSetting, current: 1, writable: true },
  ];
}

export interface FakeSonyCameraSpec {
  id: string;
  model: string;
  /** Start powered on (discoverable). */
  powered?: boolean;
  /** Refuse connect (0x820A) until pairing mode is opened, like the FX3A over Wi-Fi. */
  needsPairing?: boolean;
  /** Report aperture as read-only with no options, like a lens with its own aperture ring. */
  readOnlyAperture?: boolean;
  /** battery-remain percent (0-100); 0xFFFF for "not taken". Defaults to 82. */
  battery?: number;
  /** Answer actions/zoom with "not supported" (no power zoom, Clear Image Zoom off). The ILCE-7M4 always does. */
  noZoom?: boolean;
}

interface FakeCamera extends Required<FakeSonyCameraSpec> {
  connected: boolean;
  /** A touch-focus point is set (the real camera only lets you cancel one that is). */
  touchPoint?: boolean;
  pairingOpen: boolean;
  props: Prop[];
  frames: number;
  /** Last zoom speed received (-10..10, 0 = stopped) and how many zoom requests were accepted. */
  zoomSpeed: number;
  zoomCalls: number;
}

export class FakeSonySidecar {
  private server: http.Server;
  private cameras = new Map<string, FakeCamera>();
  private startedAt = Date.now();
  scanDelayMs: number;
  connectDelayMs: number;
  /** The next N settings reads answer 500, like a busy service. */
  failProperties = 0;
  /** A camera reports a newly set value only this long after accepting it (the real FX3/A7S III lag). */
  applyLagMs = 600;
  /** Live-view stop requests received. */
  liveViewStops = 0;
  requests = 0;

  constructor(specs: FakeSonyCameraSpec[], options: { scanDelayMs?: number; connectDelayMs?: number } = {}) {
    this.scanDelayMs = options.scanDelayMs ?? 0;
    this.connectDelayMs = options.connectDelayMs ?? 0;
    for (const spec of specs) {
      this.cameras.set(spec.id.toUpperCase(), {
        powered: true, needsPairing: false, readOnlyAperture: false, battery: 82, noZoom: false, ...spec, id: spec.id.toUpperCase(),
        connected: false, pairingOpen: false, props: makeProps(!!spec.readOnlyAperture), frames: 0, zoomSpeed: 0, zoomCalls: 0,
      });
    }
    this.server = http.createServer((req, res) => { void this.handle(req, res); });
  }

  start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => { this.server.close(() => resolve()); this.server.closeAllConnections?.(); });
  }

  /** Direct control for in-process tests. */
  power(id: string, on: boolean): void {
    const camera = this.cameras.get(id.toUpperCase());
    if (!camera) throw new Error(`unknown camera ${id}`);
    camera.powered = on;
    if (!on) { camera.connected = false; camera.pairingOpen = false; }
  }
  pairing(id: string, open: boolean): void {
    const camera = this.cameras.get(id.toUpperCase());
    if (!camera) throw new Error(`unknown camera ${id}`);
    camera.pairingOpen = open;
  }
  setBattery(id: string, percent: number): void {
    const camera = this.cameras.get(id.toUpperCase());
    if (!camera) throw new Error(`unknown camera ${id}`);
    camera.battery = percent;
  }
  snapshot(): unknown {
    return [...this.cameras.values()].map(({ id, model, powered, connected, needsPairing, pairingOpen, battery, zoomSpeed, zoomCalls }) => ({ id, model, powered, connected, needsPairing, pairingOpen, battery, zoomSpeed, zoomCalls }));
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  }

  private info(camera?: FakeCamera, id = ''): { connected: boolean; model: string; id: string } {
    return { connected: !!camera?.connected, model: camera?.connected ? camera.model : '', id: camera?.connected ? camera.id : id };
  }

  private async readBody(req: http.IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
  }

  private frame(camera: FakeCamera): string {
    camera.frames++;
    const t = new Date().toISOString().slice(11, 23);
    // A 16:9 SMPTE-style test pattern (75% bars, sub-bar row, slate field) with a plain white "subject marker" that
    // drifts left-right on a sine so the frame is visibly live and person tracking has a target to tap.
    const x = 320 + Math.sin(camera.frames / 40) * 120;
    const w = 640 / 7;
    const bars = (colors: string[], y: number, h: number): string =>
      colors.map((c, i) => `<rect x="${(i * w).toFixed(2)}" y="${y}" width="${(w + 0.5).toFixed(2)}" height="${h}" fill="${c}"/>`).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
<rect width="640" height="360" fill="#101010"/>
${bars(['#bfbfbf', '#bfbf00', '#00bfbf', '#00bf00', '#bf00bf', '#bf0000', '#0000bf'], 0, 206)}
${bars(['#0000bf', '#131313', '#bf00bf', '#131313', '#00bfbf', '#131313', '#bfbfbf'], 206, 28)}
<rect x="${(x - 12).toFixed(1)}" y="252" width="24" height="60" fill="#ffffff"/>
<g stroke="#ffffff" stroke-opacity="0.35" stroke-width="1" fill="none"><rect x="32" y="18" width="576" height="324"/><line x1="320" y1="18" x2="320" y2="30"/><line x1="320" y1="330" x2="320" y2="342"/><line x1="32" y1="180" x2="44" y2="180"/><line x1="596" y1="180" x2="608" y2="180"/></g>
<text x="44" y="334" fill="#d0d0d0" font-family="monospace" font-size="14">${camera.model}  ${camera.id}</text>
<text x="596" y="334" fill="#d0d0d0" font-family="monospace" font-size="14" text-anchor="end">${t}  F${String(camera.frames).padStart(6, '0')}</text></svg>`;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.requests++;
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    // ---- sandbox controls ----------------------------------------------------
    if (parts[0] === '__sandbox') {
      if (method === 'GET' && parts[1] === 'state') return this.json(res, 200, { scanDelayMs: this.scanDelayMs, cameras: this.snapshot() });
      if (method === 'POST' && parts[1] === 'cameras' && parts[2] && parts[3]) {
        const body = await this.readBody(req);
        try {
          if (parts[3] === 'power') this.power(parts[2], !!body.on);
          else if (parts[3] === 'pairing') this.pairing(parts[2], !!body.open);
          else if (parts[3] === 'battery') this.setBattery(parts[2], Number(body.percent));
          else return this.json(res, 404, { success: false, message: 'Not found' });
        } catch (error) { return this.json(res, 404, { success: false, message: String(error) }); }
        return this.json(res, 200, { success: true, cameras: this.snapshot() });
      }
      if (method === 'POST' && parts[1] === 'fail-properties') {
        this.failProperties = Math.max(0, Number((await this.readBody(req)).count) || 0);
        return this.json(res, 200, { success: true, failProperties: this.failProperties });
      }
      if (method === 'POST' && parts[1] === 'scan-delay') {
        this.scanDelayMs = Math.max(0, Number((await this.readBody(req)).ms) || 0);
        return this.json(res, 200, { success: true, scanDelayMs: this.scanDelayMs });
      }
      return this.json(res, 404, { success: false, message: 'Not found' });
    }

    // ---- the real service's routes --------------------------------------------
    if (method === 'GET' && url.pathname === '/api/server/status') {
      const list = [...this.cameras.values()];
      return this.json(res, 200, {
        success: true,
        server: { version: '3.0.0', sdkVersion: 'V2.02.00', uptime: Math.round((Date.now() - this.startedAt) / 1000), platform: 'sandbox' },
        cameras: { connected: list.filter((c) => c.connected).length, discovered: list.filter((c) => c.powered).length },
      });
    }
    if (method === 'GET' && url.pathname === '/api/cameras') {
      if (this.scanDelayMs) await sleep(this.scanDelayMs);
      const cameras = [...this.cameras.values()].filter((c) => c.powered)
        .map((c) => ({ id: c.id, model: c.model, connectionType: /TCP:|192\./.test(c.id) ? 'Network' : 'USB', connected: c.connected })); // the real service's guess, wrong for Wi-Fi cameras
      return this.json(res, 200, { cameras, message: 'Camera discovery completed', success: true });
    }
    if (parts[0] === 'api' && parts[1] === 'cameras' && parts[2]) {
      const id = parts[2].toUpperCase();
      const camera = this.cameras.get(id);
      const sub = parts.slice(3).join('/');
      const notConnected = (): void => this.json(res, 400, { success: false, message: `Camera not connected: ${id}`, camera: this.info() });

      if (sub === 'connection' && method === 'GET') {
        return this.json(res, 200, camera?.connected
          ? { success: true, message: 'Camera connected', camera: this.info(camera), data: { mode: 'remote' } }
          : { success: true, message: 'No camera connected', camera: this.info(undefined, id) });
      }
      if (sub === 'connection' && method === 'POST') {
        if (this.connectDelayMs) await sleep(this.connectDelayMs);
        if (!camera || !camera.powered) {
          return this.json(res, 400, { success: false, message: 'Connection did not complete within 15s. If this is a network connection, check that remote shooting is enabled on the camera.', camera: this.info() });
        }
        if (camera.needsPairing && !camera.pairingOpen) {
          return this.json(res, 400, { success: false, message: 'Camera refused the connection (0x0000820A)', camera: this.info(), data: { error_code: '0x0000820A' } });
        }
        camera.connected = true;
        return this.json(res, 200, { success: true, message: 'Camera connected successfully in remote mode', camera: this.info(camera) });
      }
      if (sub === 'connection' && method === 'DELETE') {
        if (camera) camera.connected = false;
        return this.json(res, 200, { success: true, message: 'Camera disconnected successfully', camera: this.info(undefined, id) });
      }
      if (sub === 'fingerprint' && method === 'GET') {
        return camera
          ? this.json(res, 200, { success: true, message: 'This camera does not use access authentication; no fingerprint is needed to connect.', data: { ssh_supported: false } })
          : this.json(res, 404, { success: false, message: 'Camera not found' });
      }
      if (!camera?.connected) return notConnected();

      if (sub === 'properties/all' && method === 'GET') {
        if (this.failProperties > 0) { this.failProperties--; return this.json(res, 500, { success: false, message: 'Service busy' }); }
        const properties: Record<string, unknown> = {};
        for (const prop of camera.props) {
          const current = prop.options.find((o) => o.value === prop.current);
          properties[prop.name] = {
            current_value: prop.current, current_hex_value: hex(prop.current), current_formatted: current?.formatted ?? `F${(prop.current / 100).toString()}`,
            writable: prop.writable,
            available_values: prop.options.map((o) => ({ value: o.value, hex_value: o.hex, formatted: o.formatted })),
          };
        }
        properties['battery-remain'] = {
          current_value: camera.battery, current_hex_value: hex(camera.battery), current_formatted: `${camera.battery}%`, writable: false, available_values: [],
        };
        return this.json(res, 200, { success: true, message: 'Retrieved all camera properties', camera: this.info(camera), data: { total_properties: camera.props.length, properties } });
      }
      // Single-property read, in the real service's shape (buildPropertyResponse): data.value is hex, data.formatted is "NN%".
      if (sub === 'properties/battery-remain' && method === 'GET') {
        return this.json(res, 200, {
          success: true, message: 'Property retrieved successfully', camera: this.info(camera),
          data: { available_values: [], formatted: `${camera.battery}%`, property: 'battery-remain', value: hex(camera.battery), writable: false },
        });
      }
      const propMatch = sub.match(/^properties\/([a-z-]+)$/);
      if (propMatch && method === 'GET') {
        const prop = camera.props.find((p) => p.name === propMatch[1]);
        if (!prop) return this.json(res, 404, { success: false, message: `Unknown property ${propMatch[1]}`, camera: this.info(camera) });
        const current = prop.options.find((o) => o.value === prop.current);
        return this.json(res, 200, {
          success: true, message: 'Property retrieved successfully', camera: this.info(camera),
          data: { property: prop.name, value: hex(prop.current), formatted: current?.formatted ?? String(prop.current), writable: prop.writable, available_values: prop.options.map((o) => ({ value: o.value, hex_value: o.hex, formatted: o.formatted })) },
        });
      }
      if (propMatch && method === 'PUT') {
        const prop = camera.props.find((p) => p.name === propMatch[1]);
        if (!prop) return this.json(res, 404, { success: false, message: `Unknown property ${propMatch[1]}`, camera: this.info(camera) });
        const body = await this.readBody(req);
        if (typeof body.value !== 'string') return this.json(res, 400, { success: false, message: 'value must be a string', camera: this.info(camera) });
        if (!prop.writable) return this.json(res, 400, { success: false, message: `Property ${prop.name} is read-only`, camera: this.info(camera) });
        const wanted = body.value.trim().toLowerCase().replace(/^f\//, 'f');
        const option = prop.options.find((o) => o.hex.toLowerCase() === wanted || o.formatted.toLowerCase().replace(/\s/g, '') === wanted.replace(/\s/g, ''));
        if (!option) return this.json(res, 400, { success: false, message: `${prop.name} value ${body.value} not supported by camera`, camera: this.info(camera) });
        // Like a real camera: it accepts the change at once but only reports the new value a moment later.
        if (this.applyLagMs > 0) setTimeout(() => { prop.current = option.value; }, this.applyLagMs);
        else prop.current = option.value;
        return this.json(res, 200, { success: true, message: `Property ${prop.name} set successfully`, camera: this.info(camera), data: { value: option.hex, requested_value: body.value, property: prop.name } });
      }
      if (sub === 'live-view/start' && method === 'POST') return this.json(res, 200, { success: true, message: 'Live view started', camera: this.info(camera) });
      if (sub === 'live-view/stop' && method === 'POST') { this.liveViewStops++; return this.json(res, 200, { success: true, message: 'Live view stopped', camera: this.info(camera) }); }
      if (sub === 'live-view/frame' && method === 'GET') {
        const svg = this.frame(camera);
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'content-length': Buffer.byteLength(svg), 'cache-control': 'no-store' });
        return void res.end(svg);
      }
      if (sub === 'actions/zoom' && method === 'POST') {
        const { speed } = await this.readBody(req);
        if (!Number.isInteger(speed) || speed < -10 || speed > 10) return this.json(res, 400, { success: false, message: 'speed must be an integer from -10 to 10', camera: this.info(camera) });
        if (camera.noZoom || camera.model === 'ILCE-7M4') return this.json(res, 400, { success: false, message: 'Zoom operation not supported for this camera/lens', camera: this.info(camera) });
        camera.zoomSpeed = speed;
        camera.zoomCalls++;
        return this.json(res, 200, { success: true, message: 'Zoom accepted', camera: this.info(camera) });
      }
      if (sub === 'actions/touch' && method === 'POST') { camera.touchPoint = true; return this.json(res, 200, { success: true, message: 'Touch accepted', camera: this.info(camera) }); }
      if (sub === 'actions/touch-cancel' && method === 'POST') {
        // Like the real service: nothing to cancel unless a touch point is set (and never in manual focus).
        if (!camera.touchPoint) return this.json(res, 400, { success: false, message: 'Nothing to cancel — the camera reports CancelRemoteTouchOperationEnableStatus as Disable', camera: this.info(camera) });
        camera.touchPoint = false;
        return this.json(res, 200, { success: true, message: 'Remote touch cancelled', camera: this.info(camera) });
      }
    }
    return this.json(res, 404, { success: false, message: 'Not found' });
  }
}
