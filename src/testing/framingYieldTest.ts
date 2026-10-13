import assert from 'assert';
import { TrackingController, TrackingObservation } from '../tracking/trackingController';

/**
 * Held framing with a moving subject (the "Hold this framing" overshoot): a stability model with the live settings
 * (5 fps preview, 300 ms pipeline, maxSpeed 0.55). The camera always trails a moving subject; held framing must give
 * way toward centre so the subject is not lost off the near edge, then come back to the held spot once they stop.
 */
let passed = 0;
const check = (name: string, ok: boolean): void => { assert.ok(ok, `FAILED ${name}`); passed++; };

function run(framing: number, speed: number) {
  const c = new TrackingController({ maxSpeed: .55, deadzone: .04, lostHoldMs: 3000, kp: 1.2, kd: .12, pipelineDelayMs: 300 });
  c.setFraming(framing, .5);
  const held = Math.min(.72, Math.max(.28, framing));
  let subject = 0, aim = -(held - .5), vel = 0, cmd = 0, latest: TrackingObservation | null = null, lost = 0, ticks = 0;
  const frames: { at: number; o: TrackingObservation }[] = [];
  const after: number[] = [];
  for (let t = 0; t <= 10000; t += 5) {
    if (t < 2500) subject += speed * .005;
    const cx = .5 + (subject - aim);
    if (t % 200 === 0) frames.push({ at: t + 300, o: { cx: Math.min(Math.max(cx, -1), 2), cy: .5, w: .12, h: .3, conf: 1, frameTs: t } });
    while (frames.length && frames[0].at <= t) latest = frames.shift()!.o;
    if (t % 50 === 0) { const out = c.update(latest, t); cmd = out.pan; ticks++; if (out.state !== 'tracking') lost++; if (t > 2500) after.push(cx - held); }
    vel += (cmd * 1.8 - vel) * (1 - Math.exp(-5 / 150)); aim += vel * .005;
  }
  return { lostShare: lost / ticks, overshoot: Math.max(0, ...after.map(e => -Math.sign(speed) * e)), finalError: Math.abs(after[after.length - 1]) };
}

for (const speed of [.3, -.3]) {
  const r = run(.3, speed);
  check(`held on a third, subject walking ${speed > 0 ? 'away from' : 'toward'} the near edge stays tracked`, r.lostShare < .1);
  check(`held on a third (${speed > 0 ? 'away' : 'toward'}): no wild overshoot (< 10% of the picture)`, r.overshoot < .1);
  check(`held on a third (${speed > 0 ? 'away' : 'toward'}): lands back on the held spot`, r.finalError <= .05);
}
const centred = run(.5, .3);
check('centred tracking is unchanged: tracked and settled', centred.lostShare < .1 && centred.finalError <= .05);

const c = new TrackingController({ maxSpeed: .55, deadzone: .04, lostHoldMs: 3000, kp: 1.2, kd: .12, pipelineDelayMs: 300 });
check('a box running past the picture edge is still tracked (centre inside)', c.update({ cx: .04, cy: .5, w: .2, h: .3, conf: 1, frameTs: 1000 }, 1000).state === 'tracking');
check('a centre outside the picture is not', c.update({ cx: -.05, cy: .5, w: .2, h: .3, conf: 1, frameTs: 1200 }, 1200).state !== 'tracking');
const edge = new TrackingController({ maxSpeed: .55, deadzone: .04, lostHoldMs: 3000, kp: 1.2, kd: .12, pipelineDelayMs: 300 });
edge.setFraming(.1, .5);
const out = edge.update({ cx: .1, cy: .5, w: .1, h: .3, conf: 1, frameTs: 0 }, 0);
check('framing held too close to the edge is pulled in to keep room for lag (subject at 0.1 is not "on target")', out.pan !== 0 || out.state === 'tracking');
console.log(`framingYield: ${passed} checks passed`);
