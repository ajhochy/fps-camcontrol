import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadWorkingProfile, saveWorkingProfile, clearWorkingProfile, slotsEqual, describeChanges, workingProfilePath, WorkingProfile, WorkingSlot } from '../config/workingProfile';

/** The working copy of the active profile. Run: npx ts-node src/testing/workingProfileTest.ts */
let passed = 0;
const check = (name: string, condition: boolean): void => { assert.ok(condition, `FAILED ${name}`); passed++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fps-working-'));
const file = path.join(dir, 'working-profile.json');
const at = (iso: string) => () => new Date(iso);

const devices = {
  vbot: { label: 'V-BOT', protocol: 'visca', cameraType: 'vbot' },
  birddog1: { label: 'BirdDog 1', protocol: 'visca', cameraType: 'birddog' },
  rs3: { label: 'DJI RS3', protocol: 'dji-bridge' },
  fx3: { label: 'FX3A — stage right', protocol: 'sony' },
  a7s3: { label: 'a7S III — stage left', protocol: 'sony' },
};
const baseSlots: WorkingSlot[] = [{ device: 'vbot', inputId: 6, camera: 'a7s3' }, { device: 'birddog1', inputId: 7 }, { device: 'rs3', inputId: 2, camera: 'fx3' }];
const profiles = { production: { slots: baseSlots }, test: { slots: [{ device: 'vbot', inputId: 6 }] } };
const known = { profiles, devices };
const make = (overrides: Partial<WorkingProfile> = {}): WorkingProfile => ({
  version: 1, base: 'production', baseSlots, slots: [{ device: 'vbot', inputId: 9, camera: 'a7s3' }, { device: 'birddog1', inputId: 7 }, { device: 'rs3', inputId: 2, camera: 'fx3' }],
  presetsAtStart: { cam1: { A: null } }, startedAt: '2026-09-30T20:00:00.000Z', updatedAt: '2026-09-30T20:05:00.000Z', ...overrides,
});
const asideFiles = (): string[] => fs.readdirSync(dir).filter((name) => name.includes('.orphaned-'));

// ---- paths
check('the working copy lives next to the devices config', workingProfilePath('/x/config/devices.yaml') === '/x/config/working-profile.json');
process.env.WORKING_PROFILE_FILE = '/tmp/elsewhere.json';
check('WORKING_PROFILE_FILE overrides the location', workingProfilePath('/x/config/devices.yaml') === '/tmp/elsewhere.json');
delete process.env.WORKING_PROFILE_FILE;

// ---- round trip
check('no file means no working copy and nothing to report', JSON.stringify(loadWorkingProfile(file, known)) === JSON.stringify({ working: null, notice: null }));
saveWorkingProfile(file, make());
const loaded = loadWorkingProfile(file, known);
check('a saved working copy loads back with its slots, base and presets snapshot', loaded.working?.base === 'production' && loaded.working.slots[0].inputId === 9 && loaded.working.presetsAtStart?.cam1 !== undefined && loaded.notice === null);
check('saving leaves no temp file behind', fs.readdirSync(dir).every((name) => !name.endsWith('.tmp')));
check('the file is readable JSON with a version', JSON.parse(fs.readFileSync(file, 'utf8')).version === 1);
clearWorkingProfile(file);
check('clearing removes the file', !fs.existsSync(file));
clearWorkingProfile(file);
check('clearing twice is harmless', !fs.existsSync(file));

// ---- a draft that no longer fits is set aside, never deleted
fs.writeFileSync(file, '{ not json');
let result = loadWorkingProfile(file, known, at('2026-09-30T21:00:00.000Z'));
check('a corrupt file is set aside and reported', result.working === null && /could not be read/.test(result.notice ?? '') && !fs.existsSync(file) && asideFiles().length === 1);
check('the set-aside name carries the time so nothing is overwritten', asideFiles()[0].includes('2026-09-30T21-00-00-000Z'));
saveWorkingProfile(file, make({ base: 'deleted-profile' }));
result = loadWorkingProfile(file, known, at('2026-09-30T21:01:00.000Z'));
check('a draft whose profile is gone is set aside and says which profile', result.working === null && /"deleted-profile" no longer exists/.test(result.notice ?? '') && asideFiles().length === 2);
saveWorkingProfile(file, make({ slots: [{ device: 'ghost', inputId: 1 }] }));
result = loadWorkingProfile(file, known, at('2026-09-30T21:02:00.000Z'));
check('a draft using a device that is gone is set aside', result.working === null && /"ghost"/.test(result.notice ?? '') && asideFiles().length === 3);
saveWorkingProfile(file, make({ slots: [{ device: 'fx3', inputId: 1 }] }));
check('a draft that uses a Sony camera as a controller is set aside', loadWorkingProfile(file, known, at('2026-09-30T21:03:00.000Z')).working === null);
saveWorkingProfile(file, make({ slots: [{ device: 'birddog1', inputId: 7, camera: 'fx3' }] }));
check('a draft that puts a Sony camera on a BirdDog is set aside', loadWorkingProfile(file, known, at('2026-09-30T21:04:00.000Z')).working === null);
saveWorkingProfile(file, make({ slots: [{ device: 'vbot', inputId: 6, camera: 'rs3' }] }));
check('a draft whose camera is not a Sony device is set aside', loadWorkingProfile(file, known, at('2026-09-30T21:05:00.000Z')).working === null);
fs.writeFileSync(file, JSON.stringify({ version: 2, base: 'production' }));
check('a file with an unknown version is set aside', loadWorkingProfile(file, known, at('2026-09-30T21:06:00.000Z')).working === null);
fs.writeFileSync(file, JSON.stringify({ ...make(), slots: [] }));
check('a draft with no rigs is set aside', loadWorkingProfile(file, known, at('2026-09-30T21:07:00.000Z')).working === null);
check('every set-aside draft was kept, none deleted', asideFiles().length === 8 && !fs.existsSync(file));

// ---- outside edits
saveWorkingProfile(file, make());
const movedOn = { profiles: { ...profiles, production: { slots: [{ device: 'vbot', inputId: 5, camera: 'a7s3' }, ...baseSlots.slice(1)] } }, devices };
result = loadWorkingProfile(file, movedOn);
check('a profile changed outside the screen keeps the draft but warns that saving replaces it', result.working !== null && /changed outside this screen/.test(result.notice ?? ''));
clearWorkingProfile(file);

// ---- comparing rigs
check('identical rigs are equal', slotsEqual(baseSlots, baseSlots.map((s) => ({ ...s }))));
check('an input difference is a difference', !slotsEqual(baseSlots, [{ ...baseSlots[0], inputId: 9 }, baseSlots[1], baseSlots[2]]));
check('a camera difference is a difference', !slotsEqual(baseSlots, [{ device: 'vbot', inputId: 6 }, baseSlots[1], baseSlots[2]]));
check('a length difference is a difference', !slotsEqual(baseSlots, baseSlots.slice(1)));
check('an absent input equals a null one', slotsEqual([{ device: 'a' }], [{ device: 'a', inputId: undefined }]));

// ---- describing changes
const changes = (slots: WorkingSlot[]) => describeChanges(baseSlots, slots, devices);
check('no edits, no changes', changes(baseSlots).length === 0);
check('an ATEM input change is reported with before and after', JSON.stringify(changes([{ ...baseSlots[0], inputId: 9 }, baseSlots[1], baseSlots[2]])) === JSON.stringify([{ kind: 'input', label: 'V-BOT', from: 6, to: 9 }]));
check('going control-only is reported as an input change to nothing', JSON.stringify(changes([{ device: 'vbot', camera: 'a7s3' }, baseSlots[1], baseSlots[2]])) === JSON.stringify([{ kind: 'input', label: 'V-BOT', from: 6, to: null }]));
check('a camera change is reported by the cameras\' names', JSON.stringify(changes([{ ...baseSlots[0], camera: undefined }, baseSlots[1], baseSlots[2]])) === JSON.stringify([{ kind: 'camera', label: 'V-BOT', from: 'a7S III — stage left', to: null }]));
check('swapping two cameras is two camera changes', changes([{ ...baseSlots[0], camera: 'fx3' }, baseSlots[1], { ...baseSlots[2], camera: 'a7s3' }]).filter((c) => c.kind === 'camera').length === 2);
const removedMiddle = changes([baseSlots[0], baseSlots[2]]);
check('removing a middle rig reports it removed and the later rig moved up', JSON.stringify(removedMiddle) === JSON.stringify([{ kind: 'removed', label: 'BirdDog 1', position: 2 }, { kind: 'moved', label: 'DJI RS3', from: 3, to: 2 }]));
const added = changes([...baseSlots, { device: 'vbot', inputId: 12 }]);
check('adding a rig reports it added with its position', added.length === 1 && added[0].kind === 'added' && (added[0] as any).position === 4 && added[0].label === 'V-BOT');
check('a device in two rigs is tracked rig by rig', describeChanges([{ device: 'vbot', inputId: 1 }, { device: 'vbot', inputId: 2 }], [{ device: 'vbot', inputId: 1 }, { device: 'vbot', inputId: 3 }], devices).length === 1);
check('an unnamed device falls back to its key', describeChanges([{ device: 'mystery' }], [], devices)[0].label === 'mystery');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`working profile: ${passed} checks passed`);
