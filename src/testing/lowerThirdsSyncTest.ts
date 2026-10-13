import assert from 'assert';
import { FakeAtemClient } from '../atem/fakeAtemClient';
import { createInitialState } from '../app/state';
import { syncLowerThirdsFromAtem, toggleLowerThirds } from '../atem/switcherActions';

/** The slides / lower-third state mirrors the switcher (a key taken at the ATEM panel shows in the app). */
let passed = 0;
const check = (name: string, ok: boolean): void => { assert.ok(ok, `FAILED ${name}`); passed++; };

async function main(): Promise<void> {
  const config = { graphics: { type: 'dsk', dskIndex: 0, uskIndex: 0, meIndex: 0, fadeFrames: 15 } } as never;
  const state = createInitialState({} as never);
  const atem = new FakeAtemClient('127.0.0.1');
  check('before connecting the key state is unknown and nothing changes', !syncLowerThirdsFromAtem(atem, state, config) && state.lowerThirdsActive === false);
  await atem.connect();
  atem.on('stateChanged', () => syncLowerThirdsFromAtem(atem, state, config));
  atem.setKeyFromPanel(true);
  check('slides taken on at the ATEM panel show as on air in the app', state.lowerThirdsActive === true);
  atem.setKeyFromPanel(false);
  check('and taken off at the panel show as off', state.lowerThirdsActive === false);
  await toggleLowerThirds(atem, state, config);
  check('the app toggle turns the key on at the switcher', atem.graphicsOnAir() === true && state.lowerThirdsActive === true);
  atem.setKeyFromPanel(false);
  await toggleLowerThirds(atem, state, config);
  check('after a panel change the next toggle goes the right way (on, not off again)', atem.graphicsOnAir() === true && state.lowerThirdsActive === true);
  check('sync reports no change when nothing changed', syncLowerThirdsFromAtem(atem, state, config) === false);
  console.log(`lowerThirdsSync: ${passed} checks passed`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
