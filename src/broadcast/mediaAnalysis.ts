// Content-level media analysis for the #64/#67/#68 proofs: decoded per-frame luma, decoded PCM, flash/click event times and
// channel statistics. Everything is measured from DECODED content on the original timeline (-copyts), never from first PTS or padding.
import { runMedia } from './mediaProcess';
import { ffmpeg } from './runtimeProbe';

export type LumaFrame = { pts: number; yavg: number; ydif: number };
export async function videoLuma(file: string, bin = ffmpeg): Promise<LumaFrame[]> {
  const r = await runMedia(bin, ['-hide_banner', '-nostdin', '-v', 'error', '-copyts', '-i', file, '-an', '-vf',
    'scale=96:54:flags=area,signalstats,metadata=mode=print:file=-', '-f', 'null', '-'], 120000);
  const out: LumaFrame[] = []; let cur: Partial<LumaFrame> = {};
  for (const line of r.stdout.toString().split('\n')) {
    let m = /pts_time:([-\d.]+)/.exec(line); if (m) { if (cur.pts !== undefined && cur.yavg !== undefined) out.push({ ydif: 0, ...cur } as LumaFrame); cur = { pts: Number(m[1]) }; continue; }
    m = /YAVG=([\d.]+)/.exec(line); if (m) cur.yavg = Number(m[1]);
    m = /YDIF=([\d.]+)/.exec(line); if (m) cur.ydif = Number(m[1]);
  }
  if (cur.pts !== undefined && cur.yavg !== undefined) out.push({ ydif: 0, ...cur } as LumaFrame);
  return out;
}

/** Decoded 48 kHz stereo (or mono duplicated) PCM as float [-1,1] per channel, with the pts of its first sample (decoder timeline, -copyts). */
export type Pcm = { startS: number; rate: number; left: Float32Array; right: Float32Array };
export async function audioPcm(file: string, bin = ffmpeg): Promise<Pcm> {
  let first = NaN;
  const r = await runMedia(bin, ['-hide_banner', '-nostdin', '-v', 'info', '-copyts', '-i', file, '-vn', '-map', '0:a:0', '-af', 'ashowinfo', '-ac', '2', '-ar', '48000', '-f', 's16le', 'pipe:1'], 120000,
    (c: Buffer) => { if (Number.isNaN(first)) { const m = /pts_time:([-\d.]+)/.exec(c.toString()); if (m) first = Number(m[1]); } });
  const b = r.stdout; const n = Math.floor(b.length / 4);
  const left = new Float32Array(n), right = new Float32Array(n);
  for (let i = 0; i < n; i++) { left[i] = b.readInt16LE(i * 4) / 32768; right[i] = b.readInt16LE(i * 4 + 2) / 32768; }
  return { startS: Number.isNaN(first) ? 0 : first, rate: 48000, left, right };
}

const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -120);
const r1 = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
export function channelStats(p: Pcm) {
  const n = p.left.length; let lp = 0, rp = 0, ls = 0, rs = 0, lr = 0, maxDiff = 0, mid = 0, side = 0;
  for (let i = 0; i < n; i++) {
    const l = p.left[i], r = p.right[i]; lp = Math.max(lp, Math.abs(l)); rp = Math.max(rp, Math.abs(r));
    ls += l * l; rs += r * r; lr += l * r; maxDiff = Math.max(maxDiff, Math.abs(l - r)); const m = (l + r) / 2, s = (l - r) / 2; mid += m * m; side += s * s;
  }
  const lrms = Math.sqrt(ls / n), rrms = Math.sqrt(rs / n); const corr = lrms > 0 && rrms > 0 ? lr / n / (lrms * rrms) : null;
  const win = 4800; let silent = 0, windows = 0; const lw: number[] = [], rw: number[] = [];
  for (let w = 0; w + win <= n; w += win) {
    let a = 0, b = 0; for (let i = w; i < w + win; i++) { a += p.left[i] ** 2; b += p.right[i] ** 2; }
    lw.push(db(Math.sqrt(a / win))); rw.push(db(Math.sqrt(b / win))); windows++; if (Math.max(lw[lw.length - 1], rw[rw.length - 1]) < -80) silent++;
  }
  const lrDiffDb = lw.length ? lw.reduce((s, v, i) => s + Math.abs(v - rw[i]), 0) / lw.length : 0;
  return { samplesPerChannel: n, seconds: r1(n / p.rate, 3), leftPeakDbfs: r1(db(lp)), rightPeakDbfs: r1(db(rp)), leftRmsDbfs: r1(db(lrms)), rightRmsDbfs: r1(db(rrms)),
    correlation: corr === null ? null : r1(corr, 4), maxAbsLeftMinusRight: r1(maxDiff, 5), sideToMidDb: mid > 0 ? r1(db(Math.sqrt(side / mid))) : null,
    windows100ms: windows, silentWindows: silent, meanAbsLevelDiffLR_dB: r1(lrDiffDb),
    verdict: Math.max(lp, rp) < 10 ** (-80 / 20) ? 'silent' : maxDiff < 1 / 32768 ? 'identical (dual mono)' : corr !== null && corr > 0.98 && Math.abs(db(lrms) - db(rrms)) < 1 ? 'near-mono (very high correlation)' : corr !== null && corr < -0.5 ? 'phase-inverted risk' : 'distinct stereo' };
}
/** RMS per hop (default 10 ms) in dBFS of the mono sum, for onset (clap/cut) detection. */
export function levelTrack(p: Pcm, hopS = 0.01): { t: number; db: number }[] {
  const hop = Math.round(hopS * p.rate), out: { t: number; db: number }[] = [];
  for (let i = 0; i + hop <= p.left.length; i += hop) { let a = 0; for (let k = i; k < i + hop; k++) { const m = (p.left[k] + p.right[k]) / 2; a += m * m; } out.push({ t: p.startS + i / p.rate, db: db(Math.sqrt(a / hop)) }); }
  return out;
}
/** Sharp onsets: a hop at least `riseDb` louder than the previous 100 ms mean and louder than `floorDb`. */
export function audioOnsets(p: Pcm, riseDb = 18, floorDb = -45): number[] {
  const lv = levelTrack(p), out: number[] = [];
  for (let i = 10; i < lv.length; i++) {
    const prev = lv.slice(i - 10, i).reduce((s, v) => s + 10 ** (v.db / 20), 0) / 10;
    if (lv[i].db > floorDb && lv[i].db - db(prev) > riseDb && (!out.length || lv[i].t - out[out.length - 1] > 0.3)) out.push(lv[i].t);
  }
  return out;
}
/** Hard picture cuts: YDIF (mean absolute luma change between consecutive frames) above a threshold. */
export function videoCuts(frames: LumaFrame[], ydif = 25): number[] {
  const out: number[] = []; for (const f of frames) if (f.ydif > ydif && (!out.length || f.pts - out[out.length - 1] > 0.3)) out.push(f.pts); return out;
}
/** First sample of each click (impulse-mode audio): rising edge above `thr` after >= 0.5 s of quiet; returns decoded-timeline seconds (sub-sample exact). */
export function clickTimes(p: Pcm, thr = 0.3): number[] {
  const out: number[] = []; let quietUntil = -1;
  for (let i = 0; i < p.left.length; i++) if (i >= quietUntil && Math.abs(p.left[i]) > thr) { out.push(p.startS + i / p.rate); quietUntil = i + Math.round(0.5 * p.rate); }
  return out;
}
export function flashTimes(frames: LumaFrame[], yavgThreshold = 100): { pts: number; index: number }[] {
  return frames.flatMap((f, index) => (f.yavg > yavgThreshold && (index === 0 || frames[index - 1].yavg <= yavgThreshold) ? [{ pts: f.pts, index }] : []));
}
/** Decode the burnt-in 24-bit frame counter (impulse mode) of every video frame; bits are 32 blocks across the top 48 rows. */
export async function frameCounters(file: string, bin = ffmpeg): Promise<{ pts: number; n: number }[]> {
  let err = '';
  const r = await runMedia(bin, ['-hide_banner', '-nostdin', '-v', 'info', '-copyts', '-i', file, '-an', '-vf', 'crop=iw:48:0:0,scale=32:1:flags=area,format=gray,showinfo', '-f', 'rawvideo', 'pipe:1'], 120000, (c: Buffer) => { err += c.toString(); });
  // showinfo goes to stderr; pts per frame is parsed from it, pixels (32 bytes/frame) from stdout.
  const pts = [...err.matchAll(/pts_time:\s*([-\d.]+)/g)].map(m => Number(m[1]));
  const px = r.stdout, out: { pts: number; n: number }[] = [];
  for (let f = 0; f < px.length / 32 && f < pts.length; f++) { const flash = px[f * 32 + 28] > 120; /* flash frames are inverted: dark bits on a white picture */ let n = 0; for (let bit = 0; bit < 24; bit++) n = (n << 1) | ((px[f * 32 + bit] > 120) !== flash ? 1 : 0); out.push({ pts: pts[f], n }); }
  return out;
}
