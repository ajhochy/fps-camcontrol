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

export interface BridgeProbe {
  host: string;
  port: number;
  reachable: boolean;
  /** What the bridge's `hello` named, if anything. */
  model: string | null;
  /** From the bridge's first status frame; null when it sent none in time (a Pi with no gimbal goes quiet). */
  gimbalConnected: boolean | null;
}

/** The ports the Pi's bridge instances use by default (dji-bridge@rs3 / @rs3pro-a / @rs3pro-b and room for more). */
export const DEFAULT_BRIDGE_PORTS = [7878, 7879, 7880, 7881, 7882, 7883, 7884, 7885];

export function probeBridge(host: string, port: number, timeoutMs = 1500): Promise<BridgeProbe> {
  return new Promise((resolve) => {
    const result: BridgeProbe = { host, port, reachable: false, model: null, gimbalConnected: null };
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
        const model = frame.params?.gimbalModel;
        result.model = typeof model === 'string' && model.trim() ? model.trim().slice(0, 32) : null;
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
