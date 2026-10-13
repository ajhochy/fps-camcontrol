import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(__dirname, '../..');
const embedPath = path.join(repoRoot, 'src/embed.ts');

function readEmbeddedEntry(): string {
  assert.ok(fs.existsSync(embedPath), 'issue-41: src/embed.ts must own the explicit embedded lifecycle');
  return fs.readFileSync(embedPath, 'utf8');
}

test('issue-41-c1: embedded lifecycle binds an ephemeral port and reports readiness after startup', () => {
  const source = readEmbeddedEntry();
  assert.match(source, /startStatusServer\([^\n]*,\s*0\)/, 'embedded server must request an OS-assigned free port');
  assert.match(source, /listening|waitForListening/, 'startup must wait for listener readiness');
  assert.match(source, /type:\s*['"]ready['"]/, 'ready message must be sent after listener readiness');
});

test('issue-41-c2: embedded lifecycle uses Electron utility process parentPort for IPC', () => {
  const source = readEmbeddedEntry();
  assert.match(source, /process\.parentPort/, 'Electron utility IPC must use process.parentPort');
  assert.match(source, /\.on\(['"]message['"]/, 'embedded process must receive parent messages');
});

test('issue-41-c3: embedded lifecycle writes logs under the configured app home', () => {
  const source = readEmbeddedEntry();
  assert.match(source, /getAppHome\(/, 'embedded logger must resolve its destination from the app home');
  assert.match(source, /createWriteStream|destination|transport/, 'embedded logger must write to a file destination');
});

test('issue-41-c4: embedded lifecycle honors the no-controller test flag', () => {
  const source = readEmbeddedEntry();
  assert.match(source, /CAMCONTROL_NO_CONTROLLER/, 'embedded startup must honor the hardware-free test flag');
  assert.match(source, /supervisor\.start\(\)/, 'controller startup must remain behind the disable flag');
});

test('issue-41-c5: ready message reports the actual bound port', () => {
  const source = readEmbeddedEntry();
  assert.match(source, /server\.address\(\)/, 'ready port must come from the bound server address');
  assert.match(source, /port:\s*(?:address|boundAddress)\.port/, 'ready message must carry the actual integer port');
});

test('issue-41-c6: validated shutdown message completes cleanup and exits successfully', () => {
  const source = readEmbeddedEntry();
  assert.match(source, /type\s*===\s*['"]shutdown['"]/, 'shutdown messages must be type-checked');
  assert.match(source, /protocol\s*===\s*1/, 'shutdown messages must validate protocol version');
  assert.match(source, /await\s+shutdown\(/, 'shutdown handling must await graceful cleanup');
  assert.match(source, /exit\(0\)|exitCode\s*=\s*0/, 'successful cleanup must exit with status 0');
  assert.match(source, /type:\s*['"]stopped['"]/, 'parent must receive stopped after cleanup');
});

test('issue-41-c7: non-embedded startup retains the existing developer behavior', () => {
  const source = readEmbeddedEntry();
  assert.match(source, /CAMCONTROL_EMBEDDED/, 'embedded-specific startup must be gated by explicit mode');
  assert.match(source, /CAMCONTROL_EMBEDDED[\s\S]*?STATUS_PORT/, 'non-embedded startup must preserve STATUS_PORT behavior');
  assert.match(source, /CAMCONTROL_EMBEDDED[\s\S]*?connectAtem/, 'non-embedded startup must preserve normal ATEM connection behavior');
});
