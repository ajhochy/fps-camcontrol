const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TrackingController } = require('../../src/tracking/trackingController');

// Regression: assembling the old integration controller silently loses framing.
test('combined assembly retains off-center framing without a capture impulse', () => {
  const controller = new TrackingController({ maxSpeed: .35, deadzone: .02, lostHoldMs: 1500, kp: 1, kd: .1, pipelineDelayMs: 0 });
  const observation = { cx: .7, cy: .3, w: .1, h: .2, conf: .9, frameTs: 1000, state: 'tracking' };
  assert.ok(controller.update(observation, 1000).pan > 0);
  assert.equal(typeof controller.setFraming, 'function', 'framing implementation must be assembled');
  controller.setFraming(.7, .3);
  assert.deepEqual(controller.update({ ...observation, frameTs: 1050 }, 1050), { pan: 0, tilt: 0, state: 'tracking' });
  const moved = controller.update({ ...observation, cx: .8, cy: .4, frameTs: 1100 }, 1100);
  assert.ok(moved.pan > 0 && moved.tilt < 0);
  controller.reset();
  assert.deepEqual(controller.update({ ...observation, frameTs: 1150 }, 1150), { pan: 0, tilt: 0, state: 'tracking' });
});

// Regression: an unverified phone worktree replaces the exact deployed baseline.
// Run before phone framing edits; any later delta requires explicit provenance review.
test('phone baseline matches all four manager-reported deployed SHA-256 values', () => {
  const hashes = {
    'index.html': '99ddc1d123fe32e376ca594cbbbda6cfef2e513a5199681c4db39d32f018b799',
    'remote.css': 'bb8a8a7152b0b0ce555fd27cfdef5faa1af83a12415390e03bebbbabb494e782',
    'remote.js': '297f8659a3b90a390f8f37e369b71c5cfb53e35524f88f1c486eef9716e2ef36',
    'remoteModel.js': 'e99c287f1a5c6be4aec6bf3e8afb3a7928eb6f0b5a76a565d8a3b79dc3d70a16',
  };
  for (const [file, expected] of Object.entries(hashes)) {
    const bytes = fs.readFileSync(path.resolve(__dirname, '../../ui/remote/iphone', file));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), expected, file);
  }
});
