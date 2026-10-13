import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadRemoteEnabled, saveRemoteEnabled } from '../app/remoteEnabledStore';

/** The desk's iPad-remote switch survives a restart. */
let passed = 0;
const check = (name: string, ok: boolean): void => { assert.ok(ok, `FAILED ${name}`); passed++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-remote-'));
const file = path.join(dir, 'config', 'remote-control.json');
check('never set: null (the config default applies)', loadRemoteEnabled(file) === null);
saveRemoteEnabled(true, file);
check('switched on is remembered', loadRemoteEnabled(file) === true);
saveRemoteEnabled(false, file);
check('switched off is remembered', loadRemoteEnabled(file) === false);
fs.writeFileSync(file, '{ torn');
check('a damaged file falls back to the config default', loadRemoteEnabled(file) === null);
fs.writeFileSync(file, JSON.stringify({ enabled: 'yes' }));
check('a wrong value falls back to the config default', loadRemoteEnabled(file) === null);
saveRemoteEnabled(true, path.join(dir, 'nope\0', 'x.json'));
check('a failed save never throws', true);
fs.rmSync(dir, { recursive: true, force: true });
console.log(`remoteEnabledStore: ${passed} checks passed`);
