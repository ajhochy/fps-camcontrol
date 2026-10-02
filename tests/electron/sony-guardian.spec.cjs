const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const guardianPath = path.resolve(__dirname, '../../electron/sony-guardian.cjs');
function implementation() {
  assert.ok(fs.existsSync(guardianPath), 'Sony guardian implementation is required');
  return require(guardianPath);
}
function fixture(overrides = {}) {
  const input = new EventEmitter();
  input.setEncoding = () => {};
  const signals = new EventEmitter();
  const messages = [], exits = [], calls = [], timers = [];
  let now = 0;
  const child = new EventEmitter();
  child.pid = 7654;
  child.exitCode = null;
  child.signalCode = null;
  child.kills = [];
  child.kill = signal => { child.kills.push(signal); return true; };
  child.stdout = { resume() { child.stdout.drained = true; } };
  child.stderr = { resume() { child.stderr.drained = true; } };
  const timerApi = {
    setInterval(fn, ms) { const t = { fn, ms, interval: true }; timers.push(t); return t; },
    clearInterval(t) { t.cleared = true; },
    setTimeout(fn, ms) { const t = { fn, ms }; timers.push(t); return t; },
    clearTimeout(t) { if (t) t.cleared = true; },
  };
  const options = {
    argv: [process.execPath, '--port', '8181'], input, signals,
    output: { write: line => { messages.push(JSON.parse(line)); return true; } },
    spawn(executable, args, config) { calls.push({ executable, args, config }); return child; },
    timers: timerApi, now: () => now, exit: code => exits.push(code),
    env: { HOME: '/safe/home', TMPDIR: '/safe/tmp', PATH: '/usr/bin:/bin',
      CAMCONTROL_SESSION: 'never-inherit', APPLE_APP_SPECIFIC_PASSWORD: 'never-inherit',
      ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', DYLD_INSERT_LIBRARIES: '/bad' },
    ...overrides,
  };
  const instance = implementation().runGuardian(options);
  return { instance, child, input, signals, messages, exits, calls, timers,
    advance(ms) { now += ms; for (const t of timers.filter(t => t.interval && !t.cleared)) t.fn(); },
    timeout(ms) { for (const t of timers.filter(t => !t.interval && t.ms === ms && !t.cleared)) { t.cleared = true; t.fn(); } },
  };
}

test('sony-guardian-c1: accepts only absolute executable and exact bounded Sony port arguments', () => {
  const { parseLaunch } = implementation();
  assert.deepEqual(parseLaunch([process.execPath, '--port', '8181']), {
    executable: process.execPath, args: ['--port', '8181'],
  });
  for (const args of [[], ['relative', '--port', '8181'], [process.execPath],
    [process.execPath, '--port', '0'], [process.execPath, '--port', '65536'],
    [process.execPath, '--port', '8181;echo'], [process.execPath, '--inspect', '8181'],
    [process.execPath, '--port', '8181', 'extra'], [process.execPath + '\0', '--port', '8181']]) {
    assert.throws(() => parseLaunch(args));
  }
});

test('sony-guardian-c2: starts owned child without shell or inherited session and drains private output', () => {
  const f = fixture();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].config.shell, false);
  assert.deepEqual(f.calls[0].args, ['--port', '8181']);
  assert.equal(f.calls[0].config.cwd, path.dirname(process.execPath));
  assert.deepEqual(f.calls[0].config.env, { HOME: '/safe/home', TMPDIR: '/safe/tmp', PATH: '/usr/bin:/bin' });
  assert.equal(f.child.stdout.drained, true);
  assert.equal(f.child.stderr.drained, true);
  f.child.emit('spawn');
  assert.deepEqual(f.messages, [{ type: 'spawned', protocol: 1, pid: 7654 }]);
});

test('sony-guardian-c3: EOF sends TERM, escalates to KILL, and waits for actual child exit', () => {
  const f = fixture();
  f.child.emit('spawn');
  f.input.emit('end');
  assert.deepEqual(f.child.kills, ['SIGTERM']);
  assert.deepEqual(f.exits, []);
  f.timeout(2000);
  assert.deepEqual(f.child.kills, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(f.exits, [], 'issuing kill must not be treated as exit');
  f.child.emit('exit', null, 'SIGKILL');
  assert.deepEqual(f.exits, [0]);
  assert.deepEqual(f.messages.at(-1), { type: 'exit', protocol: 1, code: null, signal: 'SIGKILL' });
});

test('sony-guardian-c4: exact heartbeat refreshes deadline and expires before any unowned action', () => {
  const f = fixture();
  f.advance(2500);
  assert.deepEqual(f.child.kills, []);
  f.input.emit('data', 'heart');
  f.input.emit('data', 'beat\n');
  f.advance(2500);
  assert.deepEqual(f.child.kills, []);
  f.advance(500);
  assert.deepEqual(f.child.kills, ['SIGTERM']);
  f.input.emit('data', 'heartbeat\n');
  f.timeout(2000);
  assert.deepEqual(f.child.kills, ['SIGTERM', 'SIGKILL']);
});

test('sony-guardian-c5: malformed or oversized parent input fails closed without reflecting payload', () => {
  for (const message of ['secret-token\n', 'x'.repeat(1025), '{}\n']) {
    const f = fixture();
    f.input.emit('data', message);
    assert.deepEqual(f.child.kills, ['SIGTERM']);
    assert.deepEqual(f.messages, []);
  }
});

test('sony-guardian-c6: stop and kill commands signal only owned child and never finish early', () => {
  const f = fixture();
  f.input.emit('data', 'stop\n');
  f.input.emit('data', 'kill\n');
  f.signals.emit('SIGTERM');
  assert.deepEqual(f.child.kills, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(f.exits, []);
  f.child.emit('exit', 0, null);
  f.child.emit('exit', 0, null);
  assert.deepEqual(f.exits, [0]);
});

test('sony-guardian-c7: spawn failure emits only curated terminal metadata', () => {
  const f = fixture();
  f.child.emit('error', new Error('private executable path and secret'));
  assert.deepEqual(f.exits, [1]);
  assert.deepEqual(f.messages, [{ type: 'exit', protocol: 1, code: null, signal: null }]);
});

test('sony-guardian-c8: graceful child exit cancels watchdog and escalation', () => {
  const f = fixture();
  f.signals.emit('SIGTERM');
  f.child.emit('exit', 0, null);
  f.advance(10000);
  f.timeout(2000);
  assert.deepEqual(f.child.kills, ['SIGTERM']);
  assert.deepEqual(f.exits, [0]);
});

test('sony-guardian-c10: broken metadata pipe cannot orphan an already spawned child', () => {
  const output = new EventEmitter();
  output.write = () => true;
  const f = fixture({ output });
  f.child.emit('spawn');
  output.emit('error', Object.assign(new Error('private pipe error'), { code: 'EPIPE' }));
  assert.deepEqual(f.child.kills, ['SIGTERM']);
  assert.deepEqual(f.exits, []);
  f.timeout(2000);
  f.child.emit('exit', null, 'SIGKILL');
  assert.deepEqual(f.exits, [0]);
});

test('sony-guardian-c11: post-spawn child error is not evidence the process exited', () => {
  const f = fixture();
  f.child.emit('spawn');
  f.child.emit('error', new Error('private kill error'));
  assert.deepEqual(f.child.kills, ['SIGTERM']);
  assert.deepEqual(f.exits, []);
  f.timeout(2000);
  assert.deepEqual(f.child.kills, ['SIGTERM', 'SIGKILL']);
  assert.equal(f.messages.length, 1);
  f.child.emit('exit', null, 'SIGKILL');
  assert.deepEqual(f.exits, [0]);
});

test('sony-guardian-c12: rejected launch does not spawn or disclose arguments', () => {
  const f = fixture({ argv: ['/private/no-such-secret-executable', '--port', '8181'] });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.exits, [1]);
  assert.deepEqual(f.messages, [{ type: 'exit', protocol: 1, code: null, signal: null }]);
  assert.equal(f.timers.every(timer => timer.cleared), true);
});

test('sony-guardian-c13: throwing spawn fails closed and clears supervision timers', () => {
  const f = fixture({ spawn() { throw new Error('private launch error'); } });
  assert.deepEqual(f.exits, [1]);
  assert.deepEqual(f.messages, [{ type: 'exit', protocol: 1, code: null, signal: null }]);
  assert.equal(f.timers.every(timer => timer.cleared), true);
});

test('sony-guardian-c14: parent EOF during pending lease acquisition prevents native spawn', async () => {
  let acquired, releases = 0;
  const lease = new Promise(resolve => { acquired = resolve; });
  const f = fixture({
    env: { CAMCONTROL_EMBEDDED: '1', CAMCONTROL_HOME: '/private/app-data/Manual' },
    acquireLease(appData, scope) {
      assert.equal(appData, '/private/app-data');
      assert.equal(scope, 'sony');
      return lease;
    },
  });
  assert.deepEqual(f.calls, []);
  f.input.emit('end');
  acquired({ async release() { releases++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, [], 'a child must never spawn after its parent was lost');
  assert.equal(releases, 1);
  assert.deepEqual(f.exits, [0]);
});

test('sony-guardian-c15: lease remains held through TERM and KILL until confirmed child exit', async () => {
  let releases = 0, released;
  const releasePending = new Promise(resolve => { released = resolve; });
  const f = fixture({
    env: { CAMCONTROL_EMBEDDED: '1', CAMCONTROL_HOME: '/private/app-data/Manual' },
    acquireLease: async () => ({ release() { releases++; return releasePending; } }),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  f.child.emit('spawn');
  f.input.emit('end');
  f.timeout(2000);
  assert.equal(releases, 0);
  assert.deepEqual(f.exits, []);
  f.child.emit('exit', null, 'SIGKILL');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases, 1);
  assert.deepEqual(f.exits, [], 'guardian must flush lease release before its own exit');
  released();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.exits, [0]);
});

async function until(predicate, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(message);
}
function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

test('sony-guardian-c9: actual parent SIGKILL closes pipe and reaps TERM-ignoring owned helper', { timeout: 15000 }, async t => {
  implementation();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-sony-guardian-'));
  const executable = path.join(dir, 'synthetic-helper');
  const ready = path.join(dir, 'ready');
  fs.writeFileSync(executable, '#!' + process.execPath + '\n' +
    'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(' + JSON.stringify(ready) + ',"ready");' +
    'process.stdout.write("PRIVATE_STDOUT");process.stderr.write("PRIVATE_STDERR");setInterval(()=>{},1000);\n', { mode: 0o700 });
  const source = 'const {spawn}=require("node:child_process");' +
    'const g=spawn(process.execPath,' + JSON.stringify([guardianPath, executable, '--port', '8181']) +
    ',{stdio:["pipe","pipe","pipe"],env:{PATH:"/usr/bin:/bin"}});' +
    'console.log(JSON.stringify({type:"guardian",pid:g.pid}));g.stdout.pipe(process.stdout);g.stderr.resume();' +
    'setInterval(()=>{if(g.stdin.writable)g.stdin.write("heartbeat\\n");},100);';
  const parent = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
  let output = '', errors = '';
  parent.stdout.on('data', chunk => { output += chunk; });
  parent.stderr.on('data', chunk => { errors += chunk; });
  let guardianPid, helperPid;
  t.after(() => {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
    // These exact PIDs were emitted by processes created by this test, never discovered globally.
    for (const pid of [guardianPid, helperPid]) if (pid && isAlive(pid)) process.kill(pid, 'SIGKILL');
  });
  await until(() => {
    const lines = output.split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line));
    guardianPid = lines.find(line => line.type === 'guardian')?.pid;
    helperPid = lines.find(line => line.type === 'spawned')?.pid;
    return guardianPid && helperPid && fs.existsSync(ready);
  }, 'owned helper did not start');
  assert.equal(isAlive(helperPid), true);
  assert.doesNotMatch(output + errors, /PRIVATE_/);
  parent.kill('SIGKILL');
  await until(() => !isAlive(helperPid), 'helper survived parent death and escalation');
  await until(() => !isAlive(guardianPid), 'guardian survived child exit');
});

test('sony-guardian-c16: real lease rejects overlapping guardians through native shutdown grace', { timeout: 15000 }, async t => {
  implementation();
  const { acquire } = require('../../electron/production-lock.cjs');
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-sony-lease-'));
  const executable = path.join(appData, 'synthetic-helper');
  const ready = path.join(appData, 'ready');
  fs.writeFileSync(executable, '#!' + process.execPath + '\n' +
    'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(' + JSON.stringify(ready) + ',"ready");' +
    'setInterval(()=>{},1000);\n', { mode: 0o700 });
  const guardians = [];
  let helperPid, heartbeat;
  const expectBusy = async () => {
    let unexpectedLease;
    try {
      await assert.rejects(acquire(appData, 'sony').then(lease => { unexpectedLease = lease; return lease; }),
        { code: 'FPS_CONTROL_IN_USE' });
    } finally { await unexpectedLease?.release(); }
  };
  const start = () => {
    const child = spawn(process.execPath, [guardianPath, executable, '--port', '8181'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', CAMCONTROL_EMBEDDED: '1', CAMCONTROL_HOME: path.join(appData, 'Manual') },
    });
    child.stdin.on('error', () => {});
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.resume();
    const entry = { child, messages: () => stdout.split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line)) };
    guardians.push(entry);
    return entry;
  };
  t.after(() => {
    clearInterval(heartbeat);
    for (const { child } of guardians) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (helperPid && isAlive(helperPid)) process.kill(helperPid, 'SIGKILL');
  });
  const first = start();
  heartbeat = setInterval(() => { if (!first.child.stdin.destroyed) first.child.stdin.write('heartbeat\n'); }, 100);
  await until(() => {
    helperPid = first.messages().find(message => message.type === 'spawned')?.pid;
    return helperPid && fs.existsSync(ready);
  }, 'first lease-owning helper did not start');
  await expectBusy();
  clearInterval(heartbeat);
  first.child.stdin.end();
  const overlapping = start();
  await until(() => overlapping.child.exitCode !== null, 'overlapping guardian did not reject busy lease');
  assert.equal(overlapping.child.exitCode, 1);
  assert.equal(overlapping.messages().some(message => message.type === 'spawned'), false);
  assert.equal(isAlive(helperPid), true, 'original helper is still in its TERM grace period');
  await expectBusy();
  await until(() => first.child.exitCode !== null, 'original guardian did not finish cleanup');
  assert.equal(first.child.exitCode, 0);
  assert.equal(isAlive(helperPid), false);
  const nextLease = await acquire(appData, 'sony');
  await nextLease.release();
});

test('sony-guardian-c17: actual parent SIGKILL during pending acquisition never launches native helper', { timeout: 15000 }, async t => {
  const lockPath = path.resolve(__dirname, '../../electron/production-lock.cjs');
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-sony-pending-'));
  const executable = path.join(appData, 'synthetic-helper');
  const ready = path.join(appData, 'unexpected-child.json');
  fs.writeFileSync(executable, '#!' + process.execPath + '\n' +
    'require("node:fs").writeFileSync(' + JSON.stringify(ready) + ',JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);\n', { mode: 0o700 });
  const guardianSource = 'require(' + JSON.stringify(guardianPath) + ').runGuardian({' +
    'argv:' + JSON.stringify([executable, '--port', '8181']) + ',' +
    'acquireLease:async(...args)=>{console.log(JSON.stringify({type:"acquiring"}));' +
    'await new Promise(resolve=>setTimeout(resolve,1000));return require(' + JSON.stringify(lockPath) + ').acquire(...args);}});';
  const parentSource = 'const g=require("node:child_process").spawn(process.execPath,' + JSON.stringify(['-e', guardianSource]) +
    ',{stdio:["pipe","pipe","pipe"],env:' + JSON.stringify({
      PATH: '/usr/bin:/bin', CAMCONTROL_EMBEDDED: '1', CAMCONTROL_HOME: path.join(appData, 'Manual'),
    }) + '});console.log(JSON.stringify({type:"guardian",pid:g.pid}));g.stdout.pipe(process.stdout);g.stderr.resume();setInterval(()=>{},1000);';
  const parent = spawn(process.execPath, ['-e', parentSource], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', guardianPid;
  parent.stdout.on('data', chunk => { stdout += chunk; });
  parent.stderr.resume();
  t.after(() => {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
    if (guardianPid && isAlive(guardianPid)) process.kill(guardianPid, 'SIGKILL');
    if (fs.existsSync(ready)) {
      const { pid } = JSON.parse(fs.readFileSync(ready, 'utf8'));
      if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  });
  await until(() => {
    const messages = stdout.split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line));
    guardianPid = messages.find(message => message.type === 'guardian')?.pid;
    return guardianPid && messages.some(message => message.type === 'acquiring');
  }, 'guardian did not enter pending acquisition');
  parent.kill('SIGKILL');
  await until(() => !isAlive(guardianPid), 'guardian did not release lease after parent death');
  assert.equal(fs.existsSync(ready), false, 'native helper must not be launched after parent pipe EOF');
  const lease = await require(lockPath).acquire(appData, 'sony');
  await lease.release();
});
