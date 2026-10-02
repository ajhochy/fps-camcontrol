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
