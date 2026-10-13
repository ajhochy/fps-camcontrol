const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const test = require('node:test');
const lockPath = path.resolve(__dirname, '../../electron/production-lock.cjs');
const { acquire, portFor } = require(lockPath);

test('backend retains hardware ownership after shell death until backend itself exits', async () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-owner-backend-'));
  const shell = await acquire(appData);
  let backend, replacement;
  try {
    backend = await acquire(appData, 'backend');
    assert.notEqual(backend.port, shell.port);
    const sony = await acquire(appData, 'sony');
    try {
      assert.notEqual(sony.port, shell.port);
      assert.notEqual(sony.port, backend.port);
      await assert.rejects(acquire(appData, 'sony'), { code: 'FPS_CONTROL_IN_USE' });
    } finally { await sony.release(); }
    await shell.release(); // Simulates kernel release on shell SIGKILL.
    replacement = await acquire(appData);
    await assert.rejects(acquire(appData, 'backend'), { code: 'FPS_CONTROL_IN_USE' });
    await backend.release();
    const nextBackend = await acquire(appData, 'backend');
    await nextBackend.release();
    await assert.rejects(acquire(appData, 'arbitrary-fallback'), /Invalid ownership scope/);
  } finally {
    await shell.release(); await backend?.release(); await replacement?.release();
  }
});

test('different variants with the same appData cannot both own hardware; release is idempotent', async () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-owner-test-'));
  const manual = await acquire(appData);
  try {
    await assert.rejects(acquire(appData), { code: 'FPS_CONTROL_IN_USE' });
    assert.equal(manual.port, portFor(appData));
  } finally { await manual.release(); await manual.release(); }
  const tracking = await acquire(appData);
  await tracking.release();
});

test('a crashed owner releases its lease without PID cleanup or signalling another process', async () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-owner-crash-'));
  const child = spawn(process.execPath, ['-e',
    "require(process.argv[1]).acquire(process.argv[2]).then(() => process.send({ready:true})).catch(() => process.exit(1))",
    lockPath, appData], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    const ready = await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(() => { throw new Error('Owned test child exited before acquiring lease'); }),
    ]);
    assert.equal(ready[0].ready, true);
    await assert.rejects(acquire(appData), { code: 'FPS_CONTROL_IN_USE' });
    const ended = once(child, 'exit');
    child.kill('SIGKILL');
    await ended;
    const next = await acquire(appData);
    await next.release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});
