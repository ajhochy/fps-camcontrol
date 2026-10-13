const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

function portFor(appData, scope = 'shell') {
  if (!path.isAbsolute(appData)) throw new Error('Application data must be an absolute path');
  if (!['shell', 'backend', 'sony'].includes(scope)) throw new Error('Invalid ownership scope');
  const canonical = fs.realpathSync(appData);
  const digest = crypto.createHash('sha256').update(`fps-camcontrol-hardware-owner-v1\0${canonical}`).digest();
  // Below macOS's default ephemeral range: the later Sony lease must not
  // collide with this app's own OS-assigned HTTP listener.
  const base = { shell: 20000, backend: 25000, sony: 30000 }[scope];
  return base + (digest.readUInt32BE(0) % 5000);
}

/**
 * One hardware owner across the manual and tracking identities. Electron's
 * singleton is per userData, but both variants share the OS appData directory.
 * The kernel releases this lease even after SIGKILL. There are no stale PID
 * files to remove, and no process is ever signalled by the lock.
 * The backend independently holds the backend scope until process exit: a
 * shell crash must not allow a replacement to open hardware while the old
 * backend's parent-loss watchdog is still shutting it down.
 * A Sony guardian holds the sony scope through actual native child exit; the
 * next backend also holds that scope while probing an external Sony service,
 * preventing adoption of an old managed helper still being reaped.
 *
 * A collision with any other listener fails closed. Do not pick another port:
 * a fallback would allow two copies to own the physical controller. This
 * listener has no application protocol and immediately closes incoming peers.
 */
async function acquire(appData, scope = 'shell') {
  const port = portFor(appData, scope);
  const server = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    const failed = () => {
      server.removeListener('listening', ready);
      const error = new Error('Camera control is already in use, or its ownership port is unavailable. Close the other CamControl app and try again.');
      error.code = 'FPS_CONTROL_IN_USE';
      reject(error);
    };
    const ready = () => {
      server.removeListener('error', failed);
      resolve();
    };
    server.once('error', failed);
    server.once('listening', ready);
    server.listen({ host: '127.0.0.1', port, exclusive: true });
  });
  let releasePromise;
  return {
    port,
    release() {
      if (!releasePromise) releasePromise = new Promise(resolve => server.close(() => resolve()));
      return releasePromise;
    },
  };
}

module.exports = { acquire, portFor };
