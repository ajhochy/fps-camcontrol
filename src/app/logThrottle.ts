import { logger } from '../index';

// Rate-limits noisy, repeating log lines so a fault loop (e.g. a flapping
// ATEM connection) can never flood the log and fill the disk. Each `key`
// logs at most once per `windowMs`; suppressed repeats are counted and
// reported on the next emission.
interface ThrottleState {
  last: number;
  suppressed: number;
}
const state = new Map<string, ThrottleState>();

function emit(
  level: 'warn' | 'info' | 'error',
  key: string,
  windowMs: number,
  obj: Record<string, unknown>,
  msg: string
): void {
  const now = Date.now();
  const s = state.get(key);
  if (!s || now - s.last >= windowMs) {
    const suppressed = s?.suppressed ?? 0;
    logger[level]({ ...obj, ...(suppressed > 0 ? { suppressedRepeats: suppressed } : {}) }, msg);
    state.set(key, { last: now, suppressed: 0 });
  } else {
    s.suppressed++;
  }
}

export const throttledLog = {
  warn: (key: string, windowMs: number, obj: Record<string, unknown>, msg: string) =>
    emit('warn', key, windowMs, obj, msg),
  info: (key: string, windowMs: number, obj: Record<string, unknown>, msg: string) =>
    emit('info', key, windowMs, obj, msg),
  error: (key: string, windowMs: number, obj: Record<string, unknown>, msg: string) =>
    emit('error', key, windowMs, obj, msg),
};
