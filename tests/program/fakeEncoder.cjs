#!/usr/bin/env node
// Stand-in for the session FFmpeg (tests only): reads the input after `-i` to end of stream, writes the recording path
// (the last tee slave path) as a marker file, exits 0. Never encodes anything.
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = args[args.indexOf('-i') + 1];
const tee = args[args.length - 1];
const out = tee.slice(tee.lastIndexOf(']') + 1);
const fd = fs.openSync(input, 'r'); const buf = Buffer.alloc(65536); let bytes = 0, n;
while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) bytes += n;
fs.writeFileSync(out, `fake recording: ${bytes} bytes\n`);
