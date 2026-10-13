import assert from 'node:assert/strict';
import test from 'node:test';
import { validateImportedDevicesConfig } from '../../src/config/configLoader';

test('whole-file imports reject incomplete camera patches instead of hydrating current data', () => {
  assert.throws(() => validateImportedDevicesConfig({ atem: { ip: '127.0.0.1', defaultTransition: 'cut' }, cameras: [{ id: 'cam1' }] }));
});

test('whole-file imports preserve profiles and disable imported Sony executable and approval paths', () => {
  const imported = validateImportedDevicesConfig({
    atem: { ip: '127.0.0.1', defaultTransition: 'cut' },
    devices: { generic: { label: 'Generic fixture', protocol: 'visca', viscaIp: '127.0.0.1' } },
    profiles: { fixture: { slots: [{ device: 'generic' }] } }, activeProfile: 'fixture',
    sony: { enabled: true, apiUrl: 'http://127.0.0.1:8181', executable: '/private/never-run', stateFile: '/private/never-read' },
  });
  assert.deepEqual(imported.sony, { enabled: false, apiUrl: 'http://127.0.0.1:8181' });
  assert.equal(imported.activeProfile, 'fixture');
  assert.deepEqual(imported.profiles?.fixture.slots, [{ device: 'generic' }]);
  assert.equal(imported.devices?.generic.viscaIp, '127.0.0.1');
});
