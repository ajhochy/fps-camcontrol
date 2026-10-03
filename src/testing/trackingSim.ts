import { TrackingController, TrackingObservation } from '../tracking/trackingController';

/** Synthetic 60degree horizontal field of view and30degree/sec full speed.
 * This is a stability model, not a claim about an uncalibrated physical rig. */
export function runTrackingSimulation({ delayMs = 300, durationMs = 30000, initialError = .25 } = {}) {
  const model = { frameIntervalMs: 125, tickMs: 50, plantTauMs: 150, quantum: .001, imageRatePerUnit: .5 };
  const controller = new TrackingController({ maxSpeed: .35, deadzone: .04, lostHoldMs: 3000, kp: 1.2, kd: .12, pipelineDelayMs: delayMs });
  const frames: { delivered: number; observation: TrackingObservation }[] = [];
  const samples: { at: number; error: number; velocity: number }[] = [];
  const commands: { at: number; pan: number }[] = [];
  let error = initialError, velocity = 0, command = 0, latest: TrackingObservation | null = null;
  for (let at = 0; at <= durationMs; at += 5) {
    if (at % model.frameIntervalMs === 0) frames.push({ delivered: at + delayMs, observation: { cx: .5 + error, cy: .5, w: .1, h: .2, conf: 1, frameTs: at } });
    while (frames.length && frames[0].delivered <= at) latest = frames.shift()!.observation;
    if (at % model.tickMs === 0) {
      command = Math.round(controller.update(latest, at).pan / model.quantum) * model.quantum;
      commands.push({ at, pan: command }); samples.push({ at, error, velocity });
    }
    velocity += (command * model.imageRatePerUnit - velocity) * (1 - Math.exp(-5 / model.plantTauMs));
    error -= velocity * .005;
  }
  let settledAtMs = Infinity;
  for (let i = samples.length - 1; i >= 0 && Math.abs(samples[i].error) <= .04; i--) settledAtMs = samples[i].at;
  const crossed = samples.findIndex(x => Math.sign(x.error) !== Math.sign(initialError));
  let postCrossingReversals = 0, previousSign = 0;
  for (const sample of crossed < 0 ? [] : samples.slice(crossed)) {
    const sign = Math.sign(sample.velocity);
    if (sign && previousSign && sign !== previousSign) postCrossingReversals++;
    if (sign) previousSign = sign;
  }
  const overshootRatio = Math.max(0, ...samples.map(x => -Math.sign(initialError) * x.error)) / Math.abs(initialError);
  return { model, samples, commands, metrics: { settledAtMs, overshootRatio, postCrossingReversals, finalError: error } };
}
if (require.main === module) console.table([150, 300, 500].map(delayMs => ({ delayMs, ...runTrackingSimulation({ delayMs }).metrics })));
