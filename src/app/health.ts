import fs from 'fs';
import path from 'path';
import type { AppState } from './state';

/**
 * One answer per device to "can I use this right now, and if not, why?" — computed on the server so the Status
 * page, Device Config and the health log all agree, and so every change can be recorded with a time.
 *
 * Levels: ready (usable), check (works, needs attention), down (not usable).
 */
export type HealthLevel = 'ready' | 'check' | 'down';
export interface Health { level: HealthLevel; text: string; hint: string }

export interface RigCamera { id: string; label: string; protocol: string }

/** A rig's motion side: the VISCA head or the DJI gimbal behind a Pi bridge. */
export function rigHealth(state: AppState, cam: RigCamera): Health {
  const id = cam.id;
  const connected = !!state.cameraConnected[id];
  if (cam.protocol !== 'dji-bridge') {
    // VISCA (V-BOT head, BirdDog, other VISCA-IP): UDP has no link to lose; what counts is whether it answered.
    if (!connected) return { level: 'down', text: 'No VISCA Link', hint: 'The app could not open its VISCA connection' };
    const answering = state.cameraAnswering[id];
    const last = state.cameraLastReplyAt[id];
    if (answering === true) return { level: 'ready', text: 'Answering', hint: last ? `Last reply ${ago(last)}` : '' };
    if (answering === false) {
      if (state.viscaRepliesHeard === false) return { level: 'check', text: 'Replies Not Heard', hint: 'Port 52381 is in use by another app on this Mac, so replies cannot be heard; commands are still sent' };
      return { level: 'down', text: 'Not Answering', hint: 'No reply to VISCA: powered off, asleep, or off the network' + (last ? `; last reply ${ago(last)}` : '') };
    }
    return { level: 'check', text: 'Checking…', hint: '' };
  }
  if (!state.cameraBridgeReachable[id]) return { level: 'down', text: 'Bridge Offline', hint: 'Cannot reach the Pi bridge: is the Pi powered (PoE) and on the network?' };
  const signal = state.cameraGimbalSignal[id];
  const weak = !!signal && signal.rating !== 'good';
  if (!state.cameraGimbalAttached[id]) {
    if (weak && signal.drops10m) return { level: 'down', text: 'Signal Lost', hint: `${signal.summary}; move the Pi or the gimbal closer` };
    return { level: 'down', text: 'Gimbal Off', hint: 'Bridge up, gimbal not found: powered off, asleep for a long time, or out of range' };
  }
  if (state.cameraGimbalResponding[id] === false) {
    return { level: 'down', text: 'Asleep / Not Moving', hint: 'Linked but ignoring moves: asleep (often from imbalance), motors off, or overloaded. Press its power button once to wake it' + (weak ? `; ${signal.summary}` : '') };
  }
  if (weak) return { level: signal.rating === 'poor' ? 'down' : 'check', text: signal.rating === 'poor' ? 'Poor Signal' : 'Weak Signal', hint: `${signal.summary}; move the Pi or the gimbal closer` };
  return { level: 'ready', text: 'Gimbal Linked', hint: '' };
}

/** What the Sony service reports about one camera (the subset health needs). */
export interface SonyCameraLike {
  state: string;
  missing?: boolean;
  message?: string | null;
  lastSeenAt?: string | null;
  battery?: { percent: number | null; stale?: boolean } | null;
  overheat?: { state: 'normal' | 'pre' | 'over' | null } | null;
}

/** A Sony camera mounted on a rig (video and remote settings). */
export function sonyHealth(camera: SonyCameraLike | undefined, serviceUp: boolean, bound: boolean): Health {
  if (!serviceUp) return { level: 'down', text: 'Sony Service Off', hint: 'The Sony camera service is not running' };
  if (!bound) return { level: 'check', text: 'Not Bound', hint: 'This Sony device is not bound to a camera yet (Device Config ▸ Sony connections)' };
  if (!camera) return { level: 'down', text: 'Not Seen', hint: 'The Sony service has not seen this camera: is it on, with Wi-Fi / PC Remote on?' };
  const battery = camera.battery && typeof camera.battery.percent === 'number' && !camera.battery.stale ? camera.battery.percent : null;
  const hot = camera.overheat?.state ?? null;
  switch (camera.state) {
    case 'connected':
      if (hot === 'over') return { level: 'down', text: 'Overheating', hint: 'The camera reports overheating and may shut down: give it air or shade; set Auto Power OFF Temp. to High' };
      if (hot === 'pre') return { level: 'check', text: 'Getting Hot', hint: 'The camera reports it is close to overheating' };
      if (battery !== null && battery < 15) return { level: 'down', text: `Battery ${battery}%`, hint: 'Camera battery nearly empty: it will shut down soon' };
      if (battery !== null && battery < 25) return { level: 'check', text: `Battery ${battery}%`, hint: 'Camera battery low' };
      return { level: 'ready', text: battery !== null ? `Connected · ${battery}%` : 'Connected', hint: '' };
    case 'connecting':
      return { level: 'check', text: 'Reconnecting…', hint: camera.message ?? '' };
    case 'needs_pairing':
      return { level: 'down', text: 'Needs Pairing', hint: 'The camera refused the connection: put it in pairing mode, then Retry connect' };
    case 'error':
      return { level: 'down', text: 'Refused / Failed', hint: (camera.message ?? 'Connection failed') + '. The app keeps retrying' };
    default:
      if (hot === 'pre' || hot === 'over') return { level: 'down', text: 'Shut Down: Overheated?', hint: 'It was reporting overheating before it dropped; let it cool, then power it on' };
      if (camera.missing || /not found/i.test(camera.message ?? '')) return { level: 'down', text: 'Off or Asleep', hint: 'Not on the network: powered off, in power save, overheated, or out of Wi-Fi' + (camera.lastSeenAt ? `; last seen ${ago(Date.parse(camera.lastSeenAt))}` : '') };
      return { level: 'down', text: 'Disconnected', hint: camera.message ?? 'The camera dropped its remote connection; the app keeps retrying' };
  }
}

export function ago(ms: number, now = Date.now()): string {
  const sec = Math.max(0, Math.round((now - ms) / 1000));
  if (sec < 60) return `${sec} s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  return `${Math.round(sec / 3600)} h ago`;
}

// ------------------------------------------------------------ change tracking and the health log

export interface HealthItem { key: string; label: string; health: Health }
export interface HealthEvent { at: string; key: string; label: string; from: HealthLevel | null; to: HealthLevel; text: string; hint: string }
export interface TrackedHealth extends Health { since: string }

/**
 * Remembers each device's last health and records a change (level or text) as an event, in memory (last 200) and
 * appended to a JSON-lines file so a drop during a service can be explained afterwards.
 */
export class HealthTracker {
  private current = new Map<string, TrackedHealth>();
  private events: HealthEvent[] = [];

  constructor(private readonly file: string | null, private readonly now: () => Date = () => new Date()) {
    if (file) {
      try {
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-200);
        for (const line of lines) { try { this.events.push(JSON.parse(line)); } catch { /* skip a torn line */ } }
      } catch { /* no log yet */ }
    }
  }

  /** Feed the latest health of every device; returns the events this produced. */
  update(items: HealthItem[]): HealthEvent[] {
    const at = this.now().toISOString();
    const seen = new Set<string>();
    const produced: HealthEvent[] = [];
    for (const item of items) {
      seen.add(item.key);
      const before = this.current.get(item.key);
      if (before && before.level === item.health.level && before.text === item.health.text) {
        this.current.set(item.key, { ...item.health, since: before.since }); // the hint (e.g. "3 s ago") may change freely
        continue;
      }
      this.current.set(item.key, { ...item.health, since: at });
      // The very first reading after start is not a change unless it is a problem worth recording.
      if (!before && item.health.level === 'ready') continue;
      produced.push({ at, key: item.key, label: item.label, from: before ? before.level : null, to: item.health.level, text: item.health.text, hint: item.health.hint });
    }
    for (const key of [...this.current.keys()]) if (!seen.has(key)) this.current.delete(key);
    if (produced.length) {
      this.events.push(...produced);
      if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
      if (this.file) {
        try {
          fs.mkdirSync(path.dirname(this.file), { recursive: true });
          fs.appendFileSync(this.file, produced.map((event) => JSON.stringify(event)).join('\n') + '\n');
        } catch { /* the log is a convenience; never let it break the app */ }
      }
    }
    return produced;
  }

  snapshot(): Record<string, TrackedHealth> {
    return Object.fromEntries(this.current);
  }

  recent(limit = 50): HealthEvent[] {
    return this.events.slice(-limit).reverse();
  }
}
