import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { runtimeProbe, cleanupRuntime, ffmpeg, ffprobe, decodeFile } from '../broadcast/runtimeProbe';
import { runMedia } from '../broadcast/mediaProcess';
import { probeOffset } from '../broadcast/avOffsetProbe';

async function main() {
  const directory = path.resolve(process.env.BROADCAST_EVIDENCE_ROOT || 'dist/broadcast-evidence/runtime');
  const falsify = process.argv.includes('--falsify');
  try {
    const { ts, mp4, flv, evidence } = await runtimeProbe(directory, falsify ? 110 : 8);
    if (falsify) {
      const bytes = await readFile(ts);
      let pat = 0; let cut = -1;
      for (let i = Math.floor(bytes.length / 2 / 188) * 188; i + 188 <= bytes.length; i += 188) {
        const pid = ((bytes[i + 1] & 31) << 8) | bytes[i + 2];
        if (pid === 0) pat = i;
        if (pid === 256 && (bytes[i + 1] & 64) && (bytes[i + 3] & 32) && bytes[i + 4] > 0 && (bytes[i + 5] & 64)) { cut = pat; break; }
      }
      assert.ok(cut > 0, 'No fresh TS random-access point with PAT');
      const late = path.join(directory, 'falsification-late.ts');
      await writeFile(late, bytes.subarray(cut));
      const first = await runMedia(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#1', '-show_frames', '-of', 'json', late]);
      assert.equal(JSON.parse(first.stdout.toString()).frames[0].key_frame, 1);
      await decodeFile(late);
      const offsets = { mp4: await probeOffset(ffmpeg, mp4, '30000/1001', 3), flv: await probeOffset(ffmpeg, flv, '30000/1001', 3) };
      await writeFile(path.join(directory, 'falsification-evidence.json'), JSON.stringify({ cut, firstFrame: JSON.parse(first.stdout.toString()), offsets, pids: [evidence.encode.pid, evidence.recording.pid, evidence.published.pid, evidence.received.pid] }, null, 2));
    }
    console.log(`PASS real runtime capability${falsify ? ' and falsification' : ''}: ${directory}`);
  } finally { await cleanupRuntime(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
