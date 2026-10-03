import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { getAppHome } from './config/paths';
import { startApplication } from './index';
import { startStatusServer } from './ui/statusServer';

const PROTOCOL = 1;

type ShutdownEnvelope = { type: 'shutdown'; protocol: typeof PROTOCOL };
type ElectronParentPort = {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
};

declare global {
  namespace NodeJS {
    interface Process {
      /** Electron exposes this on utility-process globals, unlike Node workers. */
      parentPort?: ElectronParentPort;
    }
  }
}

function isShutdownEnvelope(value: unknown): value is ShutdownEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return Object.keys(message).length === 2 && message.type === 'shutdown' && message.protocol === 1;
}

/**
 * Electron utility-process entrypoint. It is intentionally gated so importing
 * it for a test cannot start the application or create operator data.
 */
export async function runEmbedded(): Promise<void> {
  const logPath = path.join(getAppHome(), 'logs', 'embedded.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const destination = pino.destination(logPath);
  const log = pino({ level: process.env.LOG_LEVEL ?? 'info' }, destination);
  const parentPort = process.parentPort;
  if (!parentPort) throw new Error('embedded mode requires Electron process.parentPort');

  // The embedded runtime always requests port zero; startApplication awaits
  // waitForListening before it returns, so the ready message below reports the
  // OS-selected value only after the listener is live. CAMCONTROL_NO_CONTROLLER
  // remains the hardware-free switch: when set, supervisor.start() is skipped.
  let stopping = false;
  let lastHeartbeat = Date.now();
  let lifecycle: Awaited<ReturnType<typeof startApplication>> | undefined;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(parentWatchdog);
    const deadline = setTimeout(() => process.exit(1), 11000);
    if (lifecycle) {
      const { shutdown } = lifecycle;
      await shutdown();
    }
    log.info('embedded backend stopped');
    destination.flushSync();
    parentPort.postMessage({ type: 'stopped', protocol: PROTOCOL });
    clearTimeout(deadline);
    process.exit(0);
  };
  const parentWatchdog = setInterval(() => {
    if (Date.now() - lastHeartbeat > 3000) void stop();
  }, 250);
  parentPort.on('message', (event: { data: unknown }) => {
    const message = event.data as Record<string, unknown> | null;
    if (message && Object.keys(message).length === 2 && message.type === 'heartbeat' && message.protocol === 1) lastHeartbeat = Date.now();
    if (isShutdownEnvelope(message)) void stop();
  });
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
  lifecycle = await startApplication(
    { embedded: true },
    (app, activityLog) => startStatusServer(app, activityLog, 0),
  );
  if (stopping) { await lifecycle.shutdown(); return; }
  const { server } = lifecycle;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('status server did not bind a TCP address');
  const boundAddress = address;
  parentPort.postMessage({ type: 'ready', protocol: PROTOCOL, port: boundAddress.port, pid: process.pid });
  log.info({ port: boundAddress.port }, 'embedded backend ready');

}

// Without CAMCONTROL_EMBEDDED, index.ts remains the CLI entrypoint and keeps
// its STATUS_PORT and connectAtem startup behavior.
if (require.main === module && process.env.CAMCONTROL_EMBEDDED === '1') {
  runEmbedded().catch(error => {
    // Do not serialize config, cookies, or session material into a parent message.
    console.error('embedded backend failed to start', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
