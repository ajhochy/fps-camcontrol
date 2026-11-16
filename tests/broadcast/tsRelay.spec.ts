import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';

// Regression: a blocked subscriber stalls or retains unbounded media for healthy peers.
test('S1 stalled subscriber fails alone at 16MiB', () => {
  const source = path.resolve(__dirname, '../../src/broadcast/tsRelay.ts');
  assert.ok(existsSync(source), 'S1 bounded TS relay is not implemented');
  const { TsRelay, MAX_SUBSCRIBER_BYTES } = require(source);
  assert.equal(MAX_SUBSCRIBER_BYTES, 16 * 1024 * 1024);
  const relay = new TsRelay();
  const stalled = new PassThrough({ highWaterMark: 188 });
  const healthy = new PassThrough();
  let consumed = 0;
  healthy.on('data', (data: Buffer) => { consumed += data.length; });
  stalled.on('error', () => {});
  relay.subscribe(stalled);
  relay.subscribe(healthy);
  // Real stream backpressure, not a mocked relay or fake write implementation.
  const pat = Buffer.alloc(188, 255); pat.set([0x47, 0x40, 0, 0x10, 0, 0, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0]);
  const pmt = Buffer.alloc(188, 255); pmt.set([0x47, 0x50, 0, 0x10, 0, 2, 0xb0, 18, 0, 1, 0xc1, 0, 0, 0xe1, 0, 0xf0, 0, 0x1b, 0xe1, 0, 0xf0, 0]);
  relay.push(pat); relay.push(pmt);
  const packet = Buffer.alloc(188); packet[0] = 0x47; packet[1] = 0x41; packet[3] = 0x30;
  packet[4] = 1; packet[5] = 0x40;
  for (let i = 0; i < 100000; i++) relay.push(packet);
  assert.ok(stalled.destroyed);
  assert.ok(!healthy.destroyed);
  assert.ok(consumed > MAX_SUBSCRIBER_BYTES);
  assert.ok(relay.bufferedBytes <= MAX_SUBSCRIBER_BYTES);
  relay.end();
});
