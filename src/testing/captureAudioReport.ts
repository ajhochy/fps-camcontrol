// Characterize the audio and picture of a kept capture (MP4 + received FLV): channel levels, L/R correlation, and any sync references.
//   node dist/testing/captureAudioReport.js <recording.mp4> [<received.flv>] [--json FILE]
import { writeFileSync } from 'node:fs';
import { audioPcm, audioOnsets, channelStats, videoCuts, videoLuma } from '../broadcast/mediaAnalysis';

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
export async function characterize(file: string) {
  const pcm = await audioPcm(file), luma = await videoLuma(file);
  const onsets = audioOnsets(pcm), cuts = videoCuts(luma);
  return { file: file.split('/').pop(), audioStartS: round(pcm.startS), videoStartS: round(luma[0]?.pts ?? NaN), audio: channelStats(pcm), videoFrames: luma.length,
    lumaRange: luma.length ? [Math.min(...luma.map(f => f.yavg)), Math.max(...luma.map(f => f.yavg))].map(v => round(v, 1)) : null,
    audioOnsetsS: onsets.map(t => round(t)), pictureCutsS: cuts.map(t => round(t)),
    pairs: cuts.flatMap(c => onsets.filter(o => Math.abs(o - c) < 0.5).map(o => ({ cutS: round(c), onsetS: round(o), audioMinusVideoMs: round((o - c) * 1000, 1) }))) };
}
async function main() {
  const files = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--json');
  const reports = []; for (const f of files) reports.push(await characterize(f));
  const j = process.argv.indexOf('--json'); if (j >= 0) writeFileSync(process.argv[j + 1], JSON.stringify(reports, null, 2) + '\n');
  console.log(JSON.stringify(reports, null, 2));
}
if (require.main === module) main().catch(e => { console.error(String(e.message ?? e)); process.exit(1); });
