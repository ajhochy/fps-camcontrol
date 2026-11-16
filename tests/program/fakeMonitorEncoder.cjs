#!/usr/bin/env node
// Stand-in for the monitor FFmpeg (tests only): drains the input after `-i` and writes a tiny JPEG-shaped frame
// (FFD8 ... FFD9) to stdout every 100 ms until the input ends.
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = args[args.indexOf('-i') + 1];
const frame = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
const timer = setInterval(() => { try { fs.writeSync(1, frame); } catch { process.exit(0); } }, 100);
const stream = fs.createReadStream(input);
stream.on('data', () => {}); stream.on('end', () => { clearInterval(timer); process.exit(0); }); stream.on('error', () => process.exit(1));
