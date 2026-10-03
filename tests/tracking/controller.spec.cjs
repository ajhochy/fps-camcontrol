const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { load, config, observation } = require('./helpers.cjs');
test('issue-25-c1: pure control module uses injected time without timers or device imports', () => {
  const { TrackingController } = load('tracking/trackingController');
  const text = fs.readFileSync(require.resolve('../../src/tracking/trackingController.ts'), 'utf8');
  assert.doesNotMatch(text, /setInterval|setTimeout|Date\.now|from ['"].*(?:devices|ui|ws)/);
  const a = new TrackingController(config), b = new TrackingController(config);
  assert.deepEqual(a.update(observation('x', 100), 150), b.update(observation('x', 100), 150));
});
test('issue-25-c2: simulator records 8fps captures, bounded20Hz quantized commands and first-order plant lag', () => {
  const run = load('testing/trackingSim').runTrackingSimulation({ delayMs: 300 });
  assert.equal(run.model.frameIntervalMs, 125); assert.equal(run.model.tickMs, 50);
  assert.ok(run.model.plantTauMs > 0); assert.ok(run.model.quantum > 0);
  assert.ok(run.commands.every((x, i, all) => !i || x.at - all[i - 1].at >= 50));
  assert.ok(run.commands.every(x => Math.abs(x.pan / run.model.quantum - Math.round(x.pan / run.model.quantum)) < 1e-8));
});
test('issue-25-c3: delay sweep settles by30s with <=20percent overshoot and <=1 reversal after crossing', () => {
  for (const delayMs of [150, 300, 500]) {
    const run = load('testing/trackingSim').runTrackingSimulation({ delayMs });
    assert.ok(run.metrics.settledAtMs <= 30000, JSON.stringify({ delayMs, ...run.metrics }));
    assert.ok(run.metrics.overshootRatio <= .2); assert.ok(run.metrics.postCrossingReversals <= 1);
    assert.ok(run.samples.filter(x => x.at >= 20000).every(x => Math.abs(x.error) <= config.deadzone));
  }
});
test('issue-25-c4: stationary is exact zero; lost stops within one tick and never resumes from missing data', () => {
  const { TrackingController } = load('tracking/trackingController');
  const c = new TrackingController(config);
  for (let now = 0; now < 30000; now += 50) assert.equal(c.update(observation('x', now, { cx: .5, cy: .5 }), now).pan, 0);
  assert.ok(c.update(observation('x', 30000), 30000).pan > 0);
  for (let now = 30050; now < 35000; now += 50) {
    const result = c.update(null, now); assert.equal(result.pan, 0); assert.equal(result.tilt, 0);
  }
});
test('issue-25-c5: invalid observations always zero and all valid outputs are finite and speed-capped', () => {
  const { TrackingController } = load('tracking/trackingController');
  for (const invalid of [{ conf: 0 }, { cx: NaN }, { cy: Infinity }, { cx: 2 }, { w: -1 }, { frameTs: 9000 }]) {
    const result = new TrackingController(config).update(observation('x', 100, invalid), 100);
    assert.equal(result.pan, 0); assert.equal(result.tilt, 0);
  }
  for (let i = 0; i < 100; i++) {
    const result = new TrackingController({ ...config, maxSpeed: .05 }).update(observation('x', 100, { cx: .05 + i * .009, cy: .1 + i * .008 }), 100);
    assert.ok(Number.isFinite(result.pan) && Math.abs(result.pan) <= .05); assert.ok(Number.isFinite(result.tilt) && Math.abs(result.tilt) <= .05);
  }
});
test('issue-25-c6: all four quadrants obey pan-right tilt-up and independent inversion', () => {
  const { TrackingController } = load('tracking/trackingController');
  for (const cx of [.2, .8]) for (const cy of [.2, .8]) for (const invertPan of [false, true]) for (const invertTilt of [false, true]) {
    const result = new TrackingController({ ...config, invertPan, invertTilt }).update(observation('x', 100, { cx, cy }), 100);
    assert.equal(Math.sign(result.pan), Math.sign(cx - .5) * (invertPan ? -1 : 1));
    assert.equal(Math.sign(result.tilt), Math.sign(.5 - cy) * (invertTilt ? -1 : 1));
  }
});
