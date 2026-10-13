import type { MotionDevice } from '../devices/motionDevice';

/** Helper termination can take seconds; never put a motion stop behind it. */
export async function stopMotionBeforeHelpers(
  tracking: { halt(): void; stop(): Promise<void> },
  devices: Iterable<Pick<MotionDevice, 'stop'>>,
): Promise<void> {
  const failures: unknown[] = [];
  try { tracking.halt(); } catch (error) { failures.push(error); }
  for (const device of devices) {
    try { device.stop(); } catch (error) { failures.push(error); }
  }
  // Flush queued transport stops before ending any supervised helper.
  await new Promise<void>(resolve => setImmediate(resolve));
  try { await tracking.stop(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'One or more motion owners could not confirm shutdown');
}
