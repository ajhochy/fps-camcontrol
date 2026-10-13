import fs from 'fs';
import path from 'path';
import { getUserPath } from '../config/paths';
import { writeFileAtomic } from '../config/atomicWrite';

/**
 * The desk's iPad-remote on/off switch, remembered across app restarts (a restart used to switch the remote off,
 * which looks like the iPad stopped working). config/remote-control.json; null = never set, use the config default.
 */
export function remoteEnabledFile(): string {
  return process.env.REMOTE_CONTROL_STATE_FILE ?? getUserPath('config/remote-control.json');
}

export function loadRemoteEnabled(file = remoteEnabledFile()): boolean | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))?.enabled;
    return typeof value === 'boolean' ? value : null;
  } catch { return null; }
}

/** Best effort: failing to remember the switch must never break the switch itself. */
export function saveRemoteEnabled(enabled: boolean, file = remoteEnabledFile()): void {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); writeFileAtomic(file, JSON.stringify({ enabled, at: new Date().toISOString() }, null, 2) + '\n'); } catch { /* not fatal */ }
}
