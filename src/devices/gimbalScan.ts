import WebSocket from 'ws';
import net from 'net';
import os from 'os';
import dns from 'dns';

/**
 * Find the DJI bridges a Pi is running (one bridge instance per gimbal, each on its own port) and whether a
 * gimbal is attached to each, so the operator picks a gimbal instead of typing a port.
 *
 * Safety: the Pi bridge stops its gimbal whenever a client disconnects (dji_bridge.py, Session.run). A probe
 * connects and disconnects, so it must never be pointed at a port the app is driving; the caller reports those
 * from the live connection instead. On a port nobody drives the stop is harmless.
 */

export interface BridgeIdentity {
  /** The Pi's host name, from a bridge >= 0.2.0; null for older bridges. */
  hostname: string | null;
  /** The systemd instance (dji-bridge@<instance>), e.g. "rs3pro-a". */
  instance: string | null;
  /** The Bluetooth address of the gimbal this bridge drives. */
  gimbalAddress: string | null;
  /** Control sessions open on the bridge (from /info only). */
  clients: number | null;
}

export interface BridgeProbe extends BridgeIdentity {
  host: string;
  port: number;
  reachable: boolean;
  /** What the bridge named, if anything. */
  model: string | null;
  /** Whether a gimbal is attached; null when the bridge did not say in time (a Pi with no gimbal goes quiet). */
  gimbalConnected: boolean | null;
  /** How it was asked: `info` (plain HTTP, opens no session, always safe) or `hello` (an older bridge). */
  via: 'info' | 'hello' | null;
}

const text = (value: unknown, max = 64): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
const NO_IDENTITY: BridgeIdentity = { hostname: null, instance: null, gimbalAddress: null, clients: null };

/**
 * Ask a bridge >= 0.2.0 who it is with a plain HTTP GET /info. It opens no WebSocket session, so unlike a hello it
 * can never make the bridge stop its gimbal, and it is safe even on a port the app is driving. Null for an older
 * bridge (it answers 426 Upgrade Required) or one that does not answer.
 */
export async function fetchBridgeInfo(host: string, port: number, timeoutMs = 1500): Promise<BridgeProbe | null> {
  try {
    const response = await fetch(`http://${host.includes(':') ? `[${host}]` : host}:${port}/info`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || typeof body.bridgeVersion !== 'string') return null;
    return {
      host, port, reachable: true, via: 'info',
      model: text(body.gimbalModel, 32),
      gimbalConnected: typeof body.gimbalConnected === 'boolean' ? body.gimbalConnected : null,
      hostname: text(body.hostname),
      instance: text(body.instance),
      gimbalAddress: text(body.gimbalAddress, 32),
      clients: typeof body.clients === 'number' && Number.isInteger(body.clients) ? body.clients : null,
    };
  } catch {
    return null;
  }
}

/** The ports the Pi's bridge instances use by default (dji-bridge@rs3 / @rs3pro-a / @rs3pro-b and room for more). */
export const DEFAULT_BRIDGE_PORTS = [7878, 7879, 7880, 7881, 7882, 7883, 7884, 7885];

/** Say hello over a WebSocket: the only way to learn about a bridge older than 0.2.0. Opens a session; see above. */
export function probeBridge(host: string, port: number, timeoutMs = 1500): Promise<BridgeProbe> {
  return new Promise((resolve) => {
    const result: BridgeProbe = { host, port, reachable: false, model: null, gimbalConnected: null, via: null, ...NO_IDENTITY };
    let ws: WebSocket;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      resolve(result);
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      ws = new WebSocket(`ws://${host.includes(':') ? `[${host}]` : host}:${port}`, { handshakeTimeout: timeoutMs });
    } catch {
      finish();
      return;
    }
    ws.on('open', () => {
      ws.send(JSON.stringify({ v: 1, id: 1, type: 'cmd', method: 'hello', params: { clientId: 'fps-camcontrol-scan', protocolVersion: 1 } }));
    });
    ws.on('message', (data) => {
      let frame: { type?: string; id?: number; method?: string; params?: Record<string, unknown> };
      try { frame = JSON.parse(data.toString()); } catch { return; }
      if (frame.type === 'ack' && frame.id === 1) {
        result.reachable = true;
        result.via = 'hello';
        result.model = text(frame.params?.gimbalModel, 32);
        result.hostname = text(frame.params?.hostname);
        result.instance = text(frame.params?.instance);
        result.gimbalAddress = text(frame.params?.gimbalAddress, 32);
        if (typeof frame.params?.gimbalConnected === 'boolean') { result.gimbalConnected = frame.params.gimbalConnected; finish(); }
        return;
      }
      if (frame.type === 'evt' && frame.method === 'status' && result.reachable) {
        const connected = frame.params?.gimbalConnected;
        result.gimbalConnected = typeof connected === 'boolean' ? connected : true; // a pose frame means a gimbal is there
        finish();
      }
    });
    ws.on('error', finish);
    ws.on('close', finish);
  });
}

// ------------------------------------------------------------ finding Pis on the network


/** Is a TCP port open? Used to find bridges cheaply before saying hello to them. */
export function tcpOpen(host: string, port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open: boolean): void => { socket.destroy(); resolve(open); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Every other address on this machine's local IPv4 networks, limited to the /24 around each address. */
export function localSubnetHosts(): string[] {
  const hosts = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const parts = addr.address.split('.').map(Number);
      if (parts[0] === 169 && parts[1] === 254) continue; // link-local: no Pi lives there
      for (let last = 1; last < 255; last++) if (last !== parts[3]) hosts.add(`${parts[0]}.${parts[1]}.${parts[2]}.${last}`);
    }
  }
  return [...hosts];
}

/** Run `work` over `items` with at most `limit` in flight. */
export async function inBatches<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await work(items[i]); }
  }));
  return out;
}

/** The IPv4 address a host name resolves to (mDNS `.local` names included on macOS), or null. */
export function resolveHost(host: string): Promise<string | null> {
  if (net.isIP(host)) return Promise.resolve(host);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 1500);
    dns.lookup(host, { family: 4 }, (err, address) => { clearTimeout(timer); resolve(err ? null : address); });
  });
}

/** The machine's own name for an address when it has one (a Pi's `name.local`), so a moved Pi keeps working. */
export function nameOf(ip: string): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 1500);
    dns.lookupService(ip, 0, (err, hostname) => {
      clearTimeout(timer);
      resolve(!err && hostname && hostname !== ip && /\.local\.?$/i.test(hostname) ? hostname.replace(/\.$/, '') : null);
    });
  });
}

// ------------------------------------------------------------ one gimbal, many addresses

export interface FoundBridge extends BridgeProbe {
  /** The address the host resolved to, when known. */
  address: string | null;
  /** Every host:port this same bridge was reached at (a Pi on Wi-Fi and Ethernet answers on both). */
  aliases: string[];
}

/**
 * Merge entries that are the same bridge reached at different addresses. Two entries are the same bridge when they
 * report the same host name and port (bridges >= 0.2.0), or failing that the same gimbal Bluetooth address and port.
 * The kept entry's host is the most useful one: a host the inventory already uses, else `<hostname>.local`, else
 * the first found. Entries with no identity are kept as they are.
 */
export function mergeBridges(found: FoundBridge[], preferredHosts: string[]): FoundBridge[] {
  const keyOf = (b: FoundBridge): string | null => (b.hostname ? `name:${b.hostname.toLowerCase()}:${b.port}` : b.gimbalAddress ? `ble:${b.gimbalAddress.toUpperCase()}:${b.port}` : null);
  const groups = new Map<string, FoundBridge[]>();
  const out: FoundBridge[] = [];
  for (const b of found) {
    const key = keyOf(b);
    if (!key) { out.push({ ...b, aliases: [`${b.host}:${b.port}`] }); continue; }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(b);
  }
  for (const group of groups.values()) {
    const preferred = group.find((b) => preferredHosts.includes(b.host))
      ?? group.find((b) => b.hostname && b.host.toLowerCase() === `${b.hostname.toLowerCase()}.local`)
      ?? group[0];
    const reachable = group.find((b) => b.reachable) ?? preferred;
    out.push({
      ...reachable,
      host: preferred.host,
      address: preferred.address ?? reachable.address,
      aliases: [...new Set(group.map((b) => `${b.host}:${b.port}`))],
    });
  }
  return out;
}

// ------------------------------------------------------------ which Bluetooth gimbal a bridge drives (bridge >= 0.6.0)

/** The bridge's `bluetooth` block (GET /info, hello, status): the gimbal it is set to drive and how it was chosen. */
export interface BluetoothGimbal {
  address: string | null;
  name: string | null;
  /** dBm, from the bridge's last scan or connect (a linked gimbal does not advertise, so it cannot be measured live). */
  rssi: number | null;
  /** `auto`: nothing chosen yet, the bridge will take the strongest DJI gimbal it hears; `fixed`: one is chosen. */
  mode: 'auto' | 'fixed' | null;
  /** How it was chosen: operator, auto-strongest, installer, config (DJI_RS3_BLE_ADDRESS) or saved. */
  chosenBy: string | null;
  /** Whether the choice is saved on the Pi (survives a restart); null when the bridge did not say. */
  saved: boolean | null;
  connected: boolean | null;
  switching: boolean;
  error: string | null;
}

export interface BluetoothGimbalRow {
  address: string;
  name: string | null;
  rssi: number | null;
  advertising: boolean;
  selected: boolean;
  connected: boolean;
  strongest: boolean;
}

export interface BluetoothGimbalList {
  scanned: boolean;
  scannedAt: number | null;
  note: string | null;
  error: string | null;
  selected: BluetoothGimbal | null;
  gimbals: BluetoothGimbalRow[];
}

const MAC = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;
/** AA:BB:CC:DD:EE:FF (upper case) or null. */
export function normalizeBluetoothAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toUpperCase().replace(/-/g, ':');
  return MAC.test(value) ? value : null;
}
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

/** Read a bridge's `bluetooth` block defensively; null when absent (a bridge older than 0.6.0). */
export function parseBluetoothGimbal(raw: unknown): BluetoothGimbal | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  return {
    address: normalizeBluetoothAddress(b.address),
    name: text(b.name, 64),
    rssi: num(b.rssi),
    mode: b.mode === 'auto' || b.mode === 'fixed' ? b.mode : null,
    chosenBy: text(b.chosenBy, 32),
    saved: bool(b.saved),
    connected: bool(b.connected),
    switching: b.switching === true,
    error: text(b.error, 200),
  };
}

function parseList(body: unknown): BluetoothGimbalList | null {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { gimbals?: unknown }).gimbals)) return null;
  const b = body as Record<string, unknown>;
  const gimbals: BluetoothGimbalRow[] = [];
  for (const raw of b.gimbals as unknown[]) {
    const g = (raw ?? {}) as Record<string, unknown>;
    const address = normalizeBluetoothAddress(g.address);
    if (!address) continue;
    gimbals.push({
      address, name: text(g.name, 64), rssi: num(g.rssi), advertising: g.advertising === true,
      selected: g.selected === true, connected: g.connected === true, strongest: g.strongest === true,
    });
  }
  return { scanned: b.scanned === true, scannedAt: num(b.scannedAt), note: text(b.note, 300), error: text(b.error, 300), selected: parseBluetoothGimbal(b.selected), gimbals };
}

const bridgeUrl = (host: string, port: number, path: string): string => `http://${host.includes(':') ? `[${host}]` : host}:${port}${path}`;

/** A bridge older than 0.6.0 knows no such route: the request falls through to the WebSocket handshake, which
 * refuses it with a plain-text 400/426, not one of our JSON answers. */
const olderBridge = (status: number, body: unknown): boolean => (status === 426 || status === 404 || status === 400 || status === 405) && (!body || typeof body !== 'object');

export type BridgeCallResult<T> = { ok: true; body: T } | { ok: false; status: number; error: string; body?: unknown };

/**
 * GET /gimbals on a bridge: the DJI gimbals it can hear. `scan` asks it to scan now even though a gimbal is linked
 * (a BlueZ scan can briefly disturb a live link, so the bridge does not do that on its own). Plain HTTP: opens no
 * session, so it never triggers the bridge's stop-on-disconnect.
 */
export async function fetchBluetoothGimbals(host: string, port: number, scan: boolean, timeoutMs = 20000): Promise<BridgeCallResult<BluetoothGimbalList>> {
  try {
    const response = await fetch(bridgeUrl(host, port, `/gimbals${scan ? '?scan=1' : ''}`), { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json().catch(() => null);
    if (olderBridge(response.status, body)) return { ok: false, status: 501, error: 'this gimbal’s Pi bridge cannot list Bluetooth gimbals yet: it needs updating (0.6.0 or later)' };
    if (!response.ok) return { ok: false, status: response.status, error: text((body as { error?: unknown } | null)?.error, 300) ?? `the bridge answered ${response.status}`, body };
    const list = parseList(body);
    return list ? { ok: true, body: list } : { ok: false, status: 502, error: 'the bridge sent an answer this app does not understand' };
  } catch (err) {
    return { ok: false, status: 504, error: `the bridge at ${host}:${port} did not answer (${(err as Error).name === 'TimeoutError' ? 'timed out' : 'unreachable'})` };
  }
}

/**
 * POST /gimbal?address=<address|auto>: make the bridge drive another gimbal. It stops the camera, drops its
 * current Bluetooth link, saves the choice and connects the new one. No request body: the bridge's HTTP parser
 * (websockets) refuses one, so the address travels in the query string.
 */
export async function selectBluetoothGimbal(host: string, port: number, target: string, timeoutMs = 30000): Promise<BridgeCallResult<{ selected: BluetoothGimbal | null }>> {
  try {
    const response = await fetch(bridgeUrl(host, port, `/gimbal?address=${encodeURIComponent(target)}`), { method: 'POST', signal: AbortSignal.timeout(timeoutMs) });
    const body = (await response.json().catch(() => null)) as { ok?: unknown; error?: unknown; selected?: unknown } | null;
    if (olderBridge(response.status, body)) return { ok: false, status: 501, error: 'this gimbal’s Pi bridge cannot switch gimbals yet: it needs updating (0.6.0 or later)' };
    if (!response.ok || !body || body.ok !== true) return { ok: false, status: response.ok ? 502 : response.status, error: text(body?.error, 300) ?? `the bridge answered ${response.status}`, body };
    return { ok: true, body: { selected: parseBluetoothGimbal(body.selected) } };
  } catch (err) {
    return { ok: false, status: 504, error: `the bridge at ${host}:${port} did not answer (${(err as Error).name === 'TimeoutError' ? 'timed out' : 'unreachable'})` };
  }
}
