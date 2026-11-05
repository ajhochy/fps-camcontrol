// MP4 scan + crash recovery for hybrid-fragmented recordings (issue #67 / #72 direction).
//  - scanMp4(): structural truth from the bytes (top-level boxes, complete moof+mdat fragments, per-track sample counts, trailing partial data).
//  - recoverMp4(): NEVER touches the original. Remuxes exactly the complete-fragment prefix (via ffmpeg's read-only `subfile` protocol) into a NEW file,
//    refuses to overwrite, verifies the original's SHA-256 is unchanged, and validates the result against the scan before claiming success.
//    An incomplete trailing fragment is reported (bytes, declared size) and never counted as recovered.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { runMedia } from './mediaProcess';
import { ffmpeg, ffprobe } from './runtimeProbe';

export type Box = { type: string; start: number; end: number; payload: number; children: Box[] };
const CONTAINERS = ['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mvex'];
export function parseBoxes(bytes: Buffer, start = 0, end = bytes.length): { boxes: Box[]; stoppedAt: number; torn?: { type: string; declared: number; available: number } } {
  const boxes: Box[] = []; let torn: { type: string; declared: number; available: number } | undefined;
  while (start + 8 <= end) {
    let size = bytes.readUInt32BE(start), header = 8;
    const type = bytes.toString('ascii', start + 4, start + 8);
    if (size === 1) { if (start + 16 > end) break; size = Number(bytes.readBigUInt64BE(start + 8)); header = 16; }
    if (size === 0) { torn = { type, declared: 0, available: end - start }; break; }   // open-ended box: never completed
    if (size < header) break;
    if (start + size > end) { torn = { type, declared: size, available: end - start }; break; }
    boxes.push({ type, start, end: start + size, payload: start + header, children: CONTAINERS.includes(type) ? parseBoxes(bytes, start + header, start + size).boxes : [] });
    start += size;
  }
  return { boxes, stoppedAt: start, torn };
}
const find = (items: Box[], type: string): Box[] => items.flatMap(b => [...(b.type === type ? [b] : []), ...find(b.children, type)]);

export type Mp4Scan = {
  bytes: number; atoms: { type: string; start: number; end: number }[];
  state: 'closed' | 'closed-header-unpatched' | 'fragmented-open' | 'no-media';
  moovCount: number; finalMoovSamples: { vide: number; soun: number } | null;
  /** the initial moov of a hybrid file already indexes the FIRST fragment's samples (it is followed by a plain mdat, not a moof) */
  initialMoovSamples: { vide: number; soun: number };
  /** initial moov samples + all complete moof+mdat fragments: what a recovery must reproduce exactly */
  completeSamples: { vide: number; soun: number };
  fragments: { start: number; end: number; vide: number; soun: number }[];
  fragmentSamples: { vide: number; soun: number };
  /** end offset of the last complete moof+mdat (or of the initial moov when there is none): the safe recovery prefix */
  completePrefixBytes: number;
  trailing: { bytes: number; type?: string; declaredBytes?: number; note: string } | null;
};
export function scanMp4(bytes: Buffer): Mp4Scan {
  const { boxes: top, stoppedAt, torn } = parseBoxes(bytes);
  const moovs = top.filter(b => b.type === 'moov');
  const tracks: Record<number, 'vide' | 'soun'> = {};
  const firstMoov = moovs[0];
  const sampleCounts = (moov: Box) => { const r = { vide: 0, soun: 0 }; for (const trak of find([moov], 'trak')) { const hdlr = find([trak], 'hdlr')[0]; if (!hdlr) continue; const kind = bytes.toString('ascii', hdlr.payload + 8, hdlr.payload + 12) as 'vide' | 'soun'; if (kind in r) r[kind] += find([trak], 'stsz').reduce((n, b) => n + bytes.readUInt32BE(b.payload + 8), 0); } return r; };
  if (firstMoov) for (const trak of find([firstMoov], 'trak')) {
    const tkhd = find([trak], 'tkhd')[0], hdlr = find([trak], 'hdlr')[0]; if (!tkhd || !hdlr) continue;
    tracks[bytes.readUInt32BE(tkhd.payload + (bytes[tkhd.payload] === 1 ? 20 : 12))] = bytes.toString('ascii', hdlr.payload + 8, hdlr.payload + 12) as 'vide' | 'soun';
  }
  const fragments: Mp4Scan['fragments'] = []; let prefix = 0;
  for (let i = 0; i < top.length - 1; i++) if (top[i].type === 'moof' && top[i + 1].type === 'mdat' && top[i].start >= (firstMoov?.end ?? 0)) {
    const f = { start: top[i].start, end: top[i + 1].end, vide: 0, soun: 0 };
    for (const traf of find([top[i]], 'traf')) { const tfhd = find([traf], 'tfhd')[0]; const kind = tracks[bytes.readUInt32BE(tfhd.payload + 4)]; if (kind) f[kind] += find([traf], 'trun').reduce((n, b) => n + bytes.readUInt32BE(b.payload + 4), 0); }
    fragments.push(f); prefix = Math.max(prefix, f.end);
  }
  const finalMoov = moovs.length ? moovs[moovs.length - 1] : undefined;
  const finalSamples = finalMoov ? sampleCounts(finalMoov) : null;
  const finalHasSamples = !!finalSamples && finalSamples.vide + finalSamples.soun > 0;
  // A graceful hybrid close leaves ONE moov as the very last box (the initial placeholder becomes free/mdat); a kill between "final moov written" and
  // "header patched" leaves the initial moov AND a final moov as the last box; an open file has its initial moov followed by mdat/moof/mdat.
  const finalIsLast = !!finalMoov && finalMoov.end === bytes.length;
  const initialMdat = firstMoov ? top.find(b => b.type === 'mdat' && b.start === firstMoov.end) : undefined;
  const initialSamples = firstMoov && initialMdat ? sampleCounts(firstMoov) : { vide: 0, soun: 0 };
  if (initialMdat) prefix = Math.max(prefix, initialMdat.end);
  const state: Mp4Scan['state'] = finalHasSamples && finalIsLast && moovs.length === 1 ? 'closed' : finalHasSamples && finalIsLast && moovs.length > 1 ? 'closed-header-unpatched'
    : initialMdat || fragments.length > 0 ? 'fragmented-open' : 'no-media';
  const fragSum = fragments.reduce((a, f) => ({ vide: a.vide + f.vide, soun: a.soun + f.soun }), { vide: 0, soun: 0 });
  const remaining = bytes.length - stoppedAt;
  const trailing = state === 'closed' && remaining === 0 ? null : remaining > 0 || torn ? { bytes: remaining, type: torn?.type, declaredBytes: torn?.declared, note: torn ? `incomplete ${torn.type} box (${torn.available} of ${torn.declared || 'open-ended'} bytes persisted)` : 'bytes that do not form a box' } : null;
  const cut = (state === 'closed-header-unpatched' || state === 'fragmented-open') ? prefix : bytes.length;
  return { bytes: bytes.length, atoms: top.map(({ type, start, end }) => ({ type, start, end })), state, moovCount: moovs.length, finalMoovSamples: finalSamples, initialMoovSamples: initialSamples, completeSamples: { vide: initialSamples.vide + fragSum.vide, soun: initialSamples.soun + fragSum.soun }, fragments,
    fragmentSamples: fragments.reduce((s, f) => ({ vide: s.vide + f.vide, soun: s.soun + f.soun }), { vide: 0, soun: 0 }), completePrefixBytes: cut,
    trailing: state === 'fragmented-open' || state === 'closed-header-unpatched' ? (bytes.length > prefix ? { bytes: bytes.length - prefix, type: torn?.type, declaredBytes: torn?.declared, note: torn ? `incomplete ${torn.type} box (${torn.available} of ${torn.declared || 'open-ended'} bytes persisted)` : state === 'closed-header-unpatched' ? 'final moov written but header not patched' : 'trailing bytes after the last complete fragment' } : null) : trailing };
}

export const sha256 = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');
async function exists(file: string) { try { await stat(file); return true; } catch (e: any) { if (e.code === 'ENOENT') return false; throw e; } }

type Pkt = { codec_type: string; pts_time: string; flags: string };
async function packets(src: string, opts: string[] = []): Promise<Pkt[]> {
  const r = await runMedia(ffprobe, ['-v', 'error', ...opts, '-show_packets', '-show_entries', 'packet=codec_type,pts_time,flags', '-of', 'json', src], 120000);
  return (JSON.parse(r.stdout.toString()).packets ?? []) as Pkt[];
}
const firstTime = (p: Pkt[], type: string) => Math.min(...p.filter(x => x.codec_type === type).map(x => Number(x.pts_time)));

export type RecoveryResult =
  | { status: 'NOT_NEEDED'; scan: Mp4Scan; originalSha256: string }
  | { status: 'NO_RECOVERABLE_MEDIA'; scan: Mp4Scan; originalSha256: string; reason: string }
  | { status: 'RECOVERED'; scan: Mp4Scan; originalSha256: string; recovered: string; recoveredBytes: number; video: number; audio: number; durationS: number; avOriginS: { original: number; recovered: number };
      decodeErrors: string; recoverMs: number; discardedTrailingBytes: number; originalUnchanged: true }
  | { status: 'FAILED'; scan: Mp4Scan; originalSha256: string; reason: string };

export async function recoverMp4(original: string, recovered: string, bin = ffmpeg): Promise<RecoveryResult> {
  if (original === recovered) throw new Error('recovery destination must differ from the original');
  if (await exists(recovered)) throw new Error(`recovery destination already exists, refusing to overwrite: ${recovered}`);
  const bytes = await readFile(original); const before = createHash('sha256').update(bytes).digest('hex'); const scan = scanMp4(bytes);
  const check = async () => { if (await sha256(original) !== before) throw new Error('ORIGINAL MODIFIED during recovery'); };
  try {
    if (scan.state === 'closed') return { status: 'NOT_NEEDED', scan, originalSha256: before };
    if (scan.state === 'no-media' || scan.completeSamples.vide + scan.completeSamples.soun === 0) return { status: 'NO_RECOVERABLE_MEDIA', scan, originalSha256: before, reason: 'no complete fragment persisted (header/initialization only)' };
    if (/[,:\s]/.test(original)) throw new Error('subfile recovery needs a path without commas, colons or spaces');
    const t0 = Date.now();
    const sub = `subfile,,start,0,end,${scan.completePrefixBytes},,:${original}`;
    const r = await runMedia(bin, ['-hide_banner', '-nostdin', '-v', 'error', '-advanced_editlist', '0', '-i', sub, '-c', 'copy', '-n', recovered], 300000).catch(e => ({ failed: String(e.message) }));
    if ('failed' in r) return { status: 'FAILED', scan, originalSha256: before, reason: r.failed };
    const recoverMs = Date.now() - t0;
    const out = await packets(recovered), src = await packets(sub, ['-advanced_editlist', '0']);
    const video = out.filter(p => p.codec_type === 'video').length, audio = out.filter(p => p.codec_type === 'audio').length;
    const problems: string[] = [];
    if (video !== scan.completeSamples.vide) problems.push(`video ${video} != complete samples ${scan.completeSamples.vide}`);
    if (audio !== scan.completeSamples.soun) problems.push(`audio ${audio} != complete samples ${scan.completeSamples.soun}`);
    const originRec = firstTime(out, 'video') - firstTime(out, 'audio'), originSrc = firstTime(src, 'video') - firstTime(src, 'audio');
    if (Math.abs(originRec - originSrc) > 0.0005) problems.push(`A/V origin changed ${originSrc} -> ${originRec}`);
    const dec = await runMedia(bin, ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-i', recovered, '-f', 'null', '-'], 300000).then(x => x.stderr.trim(), e => String(e.message));
    if (dec) problems.push(`decode errors: ${dec.slice(0, 200)}`);
    const dur = Number(JSON.parse((await runMedia(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', recovered])).stdout.toString()).format.duration);
    if (problems.length) return { status: 'FAILED', scan, originalSha256: before, reason: problems.join('; ') };
    return { status: 'RECOVERED', scan, originalSha256: before, recovered, recoveredBytes: (await stat(recovered)).size, video, audio, durationS: dur, avOriginS: { original: originSrc, recovered: originRec },
      decodeErrors: dec, recoverMs, discardedTrailingBytes: bytes.length - scan.completePrefixBytes, originalUnchanged: true };
  } finally { await check(); }
}
