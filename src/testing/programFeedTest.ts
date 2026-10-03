// The program feed's parsers: MJPEG splitting across chunk boundaries, ffmpeg device/format listings, name matching,
// and the sandbox frame's lower third. Run: node dist/testing/programFeedTest.js
import assert from 'node:assert/strict';
import { MjpegSplitter, parseAvfoundationDevices, parseDecklinkDevices, parseDecklinkFormats, matchDevice, fakeProgramSvg } from '../program/programFeed';

const jpeg = (fill: number, n: number): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(n, fill), Buffer.from([0xff, 0xd9])]);
const a = jpeg(0x11, 50), b = jpeg(0x22, 70);
const stream = Buffer.concat([Buffer.from([0x00, 0x01]), a, b]);
const splitter = new MjpegSplitter();
const got: Buffer[] = [];
// Cut inside a's SOI, in a's body, between a's FF and D9, and inside b.
for (const [from, to] of [[0, 3], [3, 30], [30, 2 + a.length - 1], [2 + a.length - 1, 2 + a.length + 10], [2 + a.length + 10, stream.length]]) {
  got.push(...splitter.push(stream.subarray(from, to)));
}
assert.equal(got.length, 2, 'both frames come out');
assert.ok(got[0].equals(a) && got[1].equals(b), 'frames are byte-exact');
assert.ok(got[got.length - 1].equals(b), 'the latest frame is the second one');
assert.equal(splitter.push(Buffer.from([0xff])).length, 0, 'a lone FF waits for more');

const av = parseAvfoundationDevices(`[AVFoundation indev @ 0x1] AVFoundation video devices:
[AVFoundation indev @ 0x1] [0] FaceTime HD Camera
[AVFoundation indev @ 0x1] [1] Cam Link 4K
[AVFoundation indev @ 0x1] [2] Capture screen 0
[AVFoundation indev @ 0x1] AVFoundation audio devices:
[AVFoundation indev @ 0x1] [0] MacBook Pro Microphone`);
assert.deepEqual(av.map(d => [d.index, d.name]), [[0, 'FaceTime HD Camera'], [1, 'Cam Link 4K']], 'video devices only, screens left out');

assert.deepEqual(parseDecklinkDevices('Auto-detected sources for decklink:\n  UltraStudio Recorder 3G [UltraStudio Recorder 3G]\n').map(d => d.name), ['UltraStudio Recorder 3G'], '-sources decklink');
assert.deepEqual(parseDecklinkDevices("[decklink @ 0x2] Blackmagic DeckLink input devices:\n[decklink @ 0x2] \t'UltraStudio Recorder 3G'\n").map(d => d.name), ['UltraStudio Recorder 3G'], '-list_devices fallback');
assert.deepEqual(parseDecklinkFormats("[decklink @ 0x3] Supported formats for 'UltraStudio Recorder 3G':\n[decklink @ 0x3] \tformat_code\tdescription\n[decklink @ 0x3] \tHp30\t\t1920x1080 at 30000/1001 fps\n"), [{ code: 'Hp30', description: '1920x1080 at 30000/1001 fps' }], 'format codes');

assert.equal(matchDevice(av, 'Cam Link 4K')?.index, 1, 'exact name');
assert.equal(matchDevice(av, 'cam link')?.index, 1, 'case-insensitive substring');
assert.equal(matchDevice(av, 'Magewell'), null, 'no match');

assert.ok(fakeProgramSvg('V-BOT', true).includes('id="lower-third"') && fakeProgramSvg('V-BOT', true).includes('V-BOT'), 'the lower third is drawn when on');
assert.ok(!fakeProgramSvg('V-BOT', false).includes('lower-third'), 'and not when off');
console.log('programFeedTest: all checks passed');
