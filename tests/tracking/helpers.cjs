const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
function load(name) {
  const file = path.resolve(__dirname, '../../src', name + '.ts');
  assert.ok(fs.existsSync(file), 'Contract implementation is missing: ' + name);
  return require(file);
}
const config = { enabled: true, sidecarUrl: 'ws://127.0.0.1:7900', maxSpeed: .35, deadzone: .04, lostHoldMs: 3000, reacquireMs: 1000, kp: 1.2, kd: .12, pipelineDelayMs: 300, sources: [] };
const source = { sourceId: 'rig-one', sonyCameraId: 'sony-one', device: 'rig-one', cameraId: 'cam4', invertPan: false, invertTilt: false };
const observation = (sessionId, now, overrides = {}) => ({ protocol: 1, type: 'track', sourceId: source.sourceId, sessionId, seq: 0, state: 'tracking', cx: .7, cy: .3, w: .1, h: .2, conf: .9, frameTs: now, processedAt: now, ...overrides });
class FakeDevice extends EventEmitter {
  id = 'cam4'; label = 'Virtual'; protocol = 'dji-bridge'; connected = true; gimbalAttached = true;
  capabilities = { pan: true, tilt: true, roll: false, zoom: false, position: true, moveTo: true };
  log = [];
  setPanTilt(pan, tilt) { this.log.push({ type: 'move', pan, tilt }); }
  stop() { this.log.push({ type: 'stop' }); }
  setZoom() {} connect() {} close() {}
  async getPosition() { return { kind: 'gimbal', yaw: 0, pitch: 0, roll: 0 }; }
  async moveTo() {} async probe() { return true; }
}
class FakeClient extends EventEmitter {
  connected = true; starts = 0; stops = 0; selections = []; cancellations = [];
  start() { this.starts++; } stop() { this.stops++; }
  select(...args) { this.selections.push(args); return this.connected; }
  cancel(...args) { this.cancellations.push(args); return this.connected; }
}
function managerFixture(options = {}) {
  const { TrackingManager } = load('tracking/trackingManager');
  let now = 10000, intervals = 0;
  const device = new FakeDevice(), client = new FakeClient(), changes = [];
  const manager = new TrackingManager({ config: { ...config, ...options.config }, sources: options.sources || [source], devices: new Map([['cam4', device]]), client,
    now: () => now, setInterval: () => { intervals++; return {}; }, clearInterval: () => {}, onStatus: status => changes.push(status), ...options });
  manager.start();
  const select = () => { manager.select(source.sourceId, .7, .3); return manager.getStatus()[source.sourceId].sessionId; };
  const track = (overrides = {}) => client.emit('track', observation(manager.getStatus()[source.sourceId].sessionId, now, overrides));
  return { manager, device, client, changes, select, track, setNow: value => { now = value; }, getNow: () => now, intervals: () => intervals };
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 5000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return; await delay(10); } assert.fail('Timed out waiting for owned test state'); }
module.exports = { load, config, source, observation, FakeDevice, FakeClient, managerFixture, delay, until };
