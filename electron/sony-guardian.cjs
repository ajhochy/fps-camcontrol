'use strict';

// This process, not the backend, owns the native Sony child. Parent pipe EOF
// still reaches it after backend/main SIGKILL; no PID discovery or adoption is
// used. Killing the guardian itself with SIGKILL cannot provide this guarantee.
const { spawn: nodeSpawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const HEARTBEAT_TIMEOUT_MS = 3000;
const STOP_GRACE_MS = 2000;
const MAX_INPUT_LENGTH = 1024;

function parseLaunch(argv) {
  if (!Array.isArray(argv) || argv.length !== 3 ||
      typeof argv[0] !== 'string' || !path.isAbsolute(argv[0]) || /[\x00-\x1f\x7f]/.test(argv[0]) ||
      argv[1] !== '--port' || typeof argv[2] !== 'string' || !/^[1-9]\d{0,4}$/.test(argv[2]) ||
      Number(argv[2]) > 65535) {
    throw new Error('Invalid Sony guardian launch arguments');
  }
  if (!fs.statSync(argv[0]).isFile()) throw new Error('Invalid Sony executable');
  fs.accessSync(argv[0], fs.constants.X_OK);
  return { executable: argv[0], args: ['--port', argv[2]] };
}

function sonyEnvironment(source) {
  const env = {};
  // Credentials, NODE_OPTIONS, ELECTRON_RUN_AS_NODE and dynamic-loader options
  // are intentionally excluded even when the guardian inherited them.
  for (const key of ['HOME', 'TMPDIR', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE']) {
    if (typeof source[key] === 'string') env[key] = source[key];
  }
  return env;
}

function runGuardian({
  argv = process.argv.slice(2), input = process.stdin, output = process.stdout,
  signals = process, spawn = nodeSpawn, timers = globalThis,
  now = () => performance.now(), env = process.env,
  acquireLease = (appData, scope) => require('./production-lock.cjs').acquire(appData, scope),
  exit = code => { process.exitCode = code; input.destroy?.(); },
} = {}) {
  let child;
  let lease;
  let finished = false;
  let started = false;
  let stopping = false;
  let killed = false;
  let outputAvailable = true;
  let buffer = '';
  let escalation;
  let lastHeartbeat = now();

  function publish(message) {
    if (!outputAvailable) return;
    try { output.write(JSON.stringify(message) + '\n'); }
    catch { outputAvailable = false; stop(); }
  }

  function signalOwned(signal) {
    if (!child || finished) return;
    // Keep waiting for the actual ChildProcess exit event if kill fails. A
    // permission error must never become a false successful cleanup report.
    try { child.kill(signal); } catch { /* The watchdog still owns this child. */ }
  }

  function kill() {
    if (finished || killed) return;
    stopping = true;
    killed = true;
    timers.clearTimeout(escalation);
    signalOwned('SIGKILL');
  }

  function stop() {
    if (finished || stopping) return;
    stopping = true;
    signalOwned('SIGTERM');
    escalation = timers.setTimeout(kill, STOP_GRACE_MS);
  }

  function outputLost() {
    outputAvailable = false;
    stop();
  }

  function receive(chunk) {
    if (finished) return;
    buffer += String(chunk);
    if (buffer.length > MAX_INPUT_LENGTH) { buffer = ''; stop(); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line === 'heartbeat') {
        if (!stopping) lastHeartbeat = now();
      } else if (line === 'stop') stop();
      else if (line === 'kill') kill();
      else { buffer = ''; stop(); return; }
    }
  }

  function finish(code, signal, failed = false) {
    if (finished) return;
    finished = true;
    timers.clearInterval(watchdog);
    timers.clearTimeout(escalation);
    input.removeListener('data', receive);
    input.removeListener('end', stop);
    input.removeListener('close', stop);
    input.removeListener('error', stop);
    signals.removeListener('SIGTERM', stop);
    signals.removeListener('SIGINT', stop);
    const complete = leaseFailed => {
      // Keep output's error handler installed through the terminal write: the
      // parent may have disappeared between child exit and pipe flush (EPIPE).
      publish({ type: 'exit', protocol: 1, code: Number.isInteger(code) ? code : null,
        signal: typeof signal === 'string' ? signal : null });
      exit(failed || leaseFailed ? 1 : 0);
    };
    // A replacement backend cannot adopt the old managed Sony service while
    // this guardian is still waiting for its native child's real exit event.
    if (lease) Promise.resolve().then(() => lease.release()).then(() => complete(false), () => complete(true));
    else complete(false);
  }

  // Supervision is active before spawn. Malformed input and parent loss fail
  // closed, and heartbeats can never cancel a stop already in progress.
  const watchdog = timers.setInterval(() => {
    if (!finished && now() - lastHeartbeat >= HEARTBEAT_TIMEOUT_MS) stop();
  }, 250);
  input.setEncoding?.('utf8');
  input.on('data', receive);
  input.on('end', stop);
  input.on('close', stop);
  input.on('error', stop);
  output.on?.('error', outputLost);
  signals.on('SIGTERM', stop);
  signals.on('SIGINT', stop);

  function launchNative(launch) {
    // Parent EOF/signals can arrive while acquiring the lease. Never launch a
    // new hardware owner after its parent has already requested termination.
    if (stopping) { finish(null, null); return; }
    try {
      child = spawn(launch.executable, launch.args, {
        cwd: path.dirname(launch.executable), shell: false,
        stdio: ['ignore', 'pipe', 'pipe'], env: sonyEnvironment(env),
      });
      child.on('spawn', () => {
        if (finished) return;
        started = true;
        publish({ type: 'spawned', protocol: 1, pid: child.pid });
      });
      child.on('exit', (code, signal) => finish(code, signal));
      child.on('error', () => {
        if (!started) finish(null, null, true);
        else stop();
      });
      // Sony may print camera/config details. Drain without forwarding or storing.
      child.stdout?.on?.('error', stop);
      child.stderr?.on?.('error', stop);
      child.stdout?.resume();
      child.stderr?.resume();
    } catch { finish(null, null, true); }
  }

  try {
    const launch = parseLaunch(argv);
    if (env.CAMCONTROL_EMBEDDED === '1') {
      if (typeof env.CAMCONTROL_HOME !== 'string' || !path.isAbsolute(env.CAMCONTROL_HOME)) {
        throw new Error('Embedded Sony guardian requires an absolute app home');
      }
      Promise.resolve(acquireLease(path.dirname(env.CAMCONTROL_HOME), 'sony')).then(acquired => {
        if (!acquired || typeof acquired.release !== 'function') throw new Error('Invalid Sony lease');
        lease = acquired;
        launchNative(launch);
      }).catch(() => finish(null, null, true));
    } else launchNative(launch);
  } catch {
    finish(null, null, true);
  }
  return { stop, kill };
}

module.exports = { parseLaunch, sonyEnvironment, runGuardian };
if (require.main === module) runGuardian();
