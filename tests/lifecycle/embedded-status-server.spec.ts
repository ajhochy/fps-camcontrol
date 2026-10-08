import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { ActivityLog } from '../../src/app/activityLog';
import { startStatusServer, waitForListening } from '../../src/ui/statusServer';

test('embedded lifecycle can await an OS-assigned loopback status port', async () => {
  const server = startStatusServer(express(), new ActivityLog(), 0);
  await waitForListening(server);
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  assert.equal(address.port > 0, true);
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
