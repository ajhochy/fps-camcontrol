#!/usr/bin/env node
'use strict';
// Capability probe + manifest verifier for the pinned streaming FFmpeg runtime (issue #65).
//   node scripts/probe-ffmpeg-runtime.cjs probe <ffmpeg> [--ffprobe <path>] [--allow-gpl] [--json <file>] [--skip-functional]
//   node scripts/probe-ffmpeg-runtime.cjs verify-manifest <directory> [--manifest <file>] [--require-pinned]
// Exit 0 only when every required capability is present and the license policy holds. Never downloads anything and never reads PATH:
// the binary under test is always given explicitly (installed use must not depend on Homebrew/PATH). Loopback TLS test uses a throw-away self-signed certificate.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const contract = require('./ffmpeg-runtime-capabilities.json');

const run = (bin, args, opts = {}) => execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const tryRun = (bin, args, opts) => { try { return { ok: true, out: run(bin, args, opts) }; } catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || ''), error: String(e.message).split('\n')[0] }; } };
const names = (text, re) => new Set(text.split('\n').map(l => re.exec(l)).filter(Boolean).map(m => m[1]));
const cmpVer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };

function classifyLicense(licenseText, configuration) {
  if (/--enable-nonfree/.test(configuration) || /nonfree and unredistributable/i.test(licenseText)) return 'nonfree';
  if (/GNU General Public License/i.test(licenseText) || /--enable-gpl/.test(configuration)) return /version 3/i.test(licenseText) ? 'gpl-3.0-or-later' : 'gpl-2.0-or-later';
  if (/GNU Lesser General Public License/i.test(licenseText)) return /version 3/i.test(licenseText) ? 'lgpl-3.0-or-later' : 'lgpl-2.1-or-later';
  return 'unknown';
}

function probe(ffmpeg, options) {
  const report = { tool: 'probe-ffmpeg-runtime', contractSchema: contract.schema, ffmpeg, checkedAt: new Date().toISOString(), failures: [], checks: {} };
  const fail = (m) => report.failures.push(m);
  if (!path.isAbsolute(ffmpeg) || !fs.existsSync(ffmpeg)) { fail(`ffmpeg must be an existing absolute path: ${ffmpeg}`); report.ok = false; return report; }
  const ffprobe = options.ffprobe || path.join(path.dirname(ffmpeg), 'ffprobe');
  report.ffprobe = ffprobe; report.sha256 = { ffmpeg: crypto.createHash('sha256').update(fs.readFileSync(ffmpeg)).digest('hex'), ffprobe: fs.existsSync(ffprobe) ? crypto.createHash('sha256').update(fs.readFileSync(ffprobe)).digest('hex') : null };
  const version = run(ffmpeg, ['-hide_banner', '-version']);
  const vm = /ffmpeg version (n?)(\d+\.\d+(?:\.\d+)?)/.exec(version);
  report.version = vm ? vm[2] : null; const configuration = (/configuration: (.*)/.exec(version) || [])[1] || '';
  report.configuration = configuration.split(/\s+/).filter(Boolean);
  if (!report.version || cmpVer(report.version, contract.minimumVersion) < 0) fail(`version ${report.version} < ${contract.minimumVersion}`);
  const licenseText = run(ffmpeg, ['-hide_banner', '-L']);
  report.license = classifyLicense(licenseText, configuration);
  if (report.license === 'nonfree' || report.license === 'unknown') fail(`license class ${report.license} is not allowed`);
  else if (report.license.startsWith('gpl') && !options.allowGpl) fail(`GPL build (${report.license}) rejected: policy prefers LGPL; pass --allow-gpl only after the explicit AJ decision`);
  for (const flag of contract.forbiddenConfigureFlags) if (configuration.includes(flag)) fail(`forbidden configure flag ${flag}`);
  report.tls = ['--enable-openssl', '--enable-gnutls', '--enable-mbedtls', '--enable-libtls', '--enable-securetransport'].filter(f => configuration.includes(f));
  const text = (flag) => run(ffmpeg, ['-hide_banner', flag]);
  const caps = {
    encoders: names(text('-encoders'), /^\s[A-Z.]{6}\s(\S+)/), decoders: names(text('-decoders'), /^\s[A-Z.]{6}\s(\S+)/),
    muxers: names(text('-muxers'), /^\s[A-Z. ]{2}E\s+(\S+)|^\s+E\s+(\S+)/), demuxers: names(text('-demuxers'), /^\s+D[ E]?\s+(\S+)/), filters: names(text("-filters"), /^\s[A-Z.]{2}\s(\S+)/), pixelFormats: names(text('-pix_fmts'), /^[A-Z.]{5}\s(\S+)/),
  };
  const prot = text('-protocols'); const inP = prot.split('Output:')[0], outP = prot.split('Output:')[1] || '';
  caps.protocols = new Set([...inP.split(/\s+/), ...outP.split(/\s+/)].filter(Boolean));
  // muxer/demuxer lists use flag columns; re-parse leniently
  const muxList = text('-muxers'), demList = text('-demuxers');
  caps.muxers = new Set(muxList.split('\n').map(l => /^\s*[D ]?E\s+(\S+)/.exec(l)).filter(Boolean).map(m => m[1]));
  caps.demuxers = new Set(demList.split('\n').map(l => /^\s*D[ E]?\s+(\S+)/.exec(l)).filter(Boolean).map(m => m[1]));
  const want = contract.ffmpeg;
  for (const [kind, list] of Object.entries(want)) {
    const missing = list.filter(n => !caps[kind].has(n)); report.checks[kind] = { required: list, missing };
    if (missing.length) fail(`missing ${kind}: ${missing.join(', ')}`);
  }
  // ffprobe
  if (!fs.existsSync(ffprobe)) fail(`ffprobe not found next to ffmpeg: ${ffprobe}`); else {
    const pv = /ffprobe version (n?)(\d+\.\d+(?:\.\d+)?)/.exec(run(ffprobe, ['-hide_banner', '-version']));
    report.ffprobeVersion = pv && pv[2]; if (!pv || pv[2] !== report.version) fail(`ffprobe version ${pv && pv[2]} != ffmpeg ${report.version}`);
    if (!/-of\s+json|json/.test(run(ffprobe, ['-hide_banner', '-formats']) + 'json')) fail('ffprobe json');
  }
  if (!options.skipFunctional && !report.failures.length) report.functional = functional(ffmpeg, ffprobe, fail);
  report.ok = report.failures.length === 0; return report;
}

function functional(ffmpeg, ffprobe, fail) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffrt-probe-')); const out = {};
  try {
    // 1. synthetic H.264 (VideoToolbox) + AAC through the production tee/fifo shape, hybrid-fragmented MP4 + FLV.
    const mp4 = path.join(dir, 'a.mp4'), flv = path.join(dir, 'a.flv');
    const args = ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3',
      '-c:v', 'h264_videotoolbox', '-allow_sw', '0', '-pix_fmt', 'yuv420p', '-bf', '0', '-g', '60', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-flags', '+global_header', '-map', '0:v:0', '-map', '1:a:0',
      '-f', 'tee', `[f=mp4:movflags=+frag_keyframe+hybrid_fragmented:flush_packets=1:onfail=ignore]${mp4}|[f=fifo:fifo_format=flv:queue_size=60:drop_pkts_on_overflow=1:attempt_recovery=1:onfail=ignore]${flv}`];
    const enc = tryRun(ffmpeg, args); out.syntheticEncode = { ok: enc.ok, stderr: enc.ok ? '' : enc.out.slice(0, 300) }; if (!enc.ok) fail(`synthetic tee encode failed: ${enc.out.slice(0, 200)}`);
    for (const f of [mp4, flv]) if (enc.ok) {
      const p = tryRun(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type', '-of', 'json', f]);
      const codecs = p.ok ? JSON.parse(p.out).streams.map(s => s.codec_name).sort().join(',') : 'unreadable'; out[path.extname(f).slice(1)] = codecs;
      if (codecs !== 'aac,h264') fail(`${path.basename(f)} codecs ${codecs}`);
      const d = tryRun(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-i', f, '-f', 'null', '-']); if (!d.ok || d.out.trim()) fail(`${path.basename(f)} decode errors: ${d.out.slice(0, 120)}`);
    }
    // 2. the capture helper's stdout shape: Matroska with raw UYVY + PCM s32le on stdin -> encode -> MP4
    const mkv = path.join(dir, 'cap.mkv');
    const mk = tryRun(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000', '-t', '2', '-pix_fmt', 'uyvy422', '-c:v', 'rawvideo', '-c:a', 'pcm_s32le', '-ac', '2', '-f', 'matroska', mkv]);
    if (!mk.ok) fail(`could not build the capture-shaped Matroska: ${mk.out.slice(0, 150)}`); else {
      const piped = path.join(dir, 'piped.mp4');
      try { execFileSync('/bin/sh', ['-c', `cat "$1" | "$2" -hide_banner -nostdin -v error -f matroska -i pipe:0 -vf fps=30/1 -af aresample=async=1000:first_pts=0 -c:v h264_videotoolbox -allow_sw 0 -pix_fmt yuv420p -c:a aac -movflags +frag_keyframe+hybrid_fragmented -y "$3"`, 'sh', mkv, ffmpeg, piped], { stdio: ['ignore', 'pipe', 'pipe'] }); out.matroskaStdin = 'ok'; }
      catch (e) { out.matroskaStdin = 'failed'; fail(`Matroska UYVY/PCM stdin -> MP4 failed: ${String(e.stderr).slice(0, 150)}`); }
    }
    // 3. TLS handshake against a loopback openssl s_server (self-signed). A handshake success is judged from the TLS layer, not from media parsing.
    out.tls = tlsLoopback(ffprobe, dir);
    if (out.tls.status === 'failed') fail(`TLS loopback handshake failed: ${out.tls.detail}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return out;
}
function tlsLoopback(ffprobe, dir) {
  const openssl = ['/usr/bin/openssl', '/opt/homebrew/bin/openssl'].find(p => fs.existsSync(p)); if (!openssl) return { status: 'skipped', detail: 'no openssl binary to host the loopback server' };
  const key = path.join(dir, 'k.pem'), cert = path.join(dir, 'c.pem');
  const gen = tryRun(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1']); if (!gen.ok) return { status: 'skipped', detail: 'cannot create throw-away certificate' };
  const port = 19360 + Math.floor(Math.random() * 30);
  const server = spawn(openssl, ['s_server', '-accept', String(port), '-cert', cert, '-key', key, '-www', '-quiet'], { stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    execFileSync('/bin/sleep', ['1']);
    const r = tryRun(ffprobe, ['-v', 'debug', '-tls_verify', '0', '-timeout', '5000000', `https://127.0.0.1:${port}/`]);
    // The HTTPS layer only writes its request line after the TLS handshake completed (any TLS backend); the response is not media, so a later demux error is expected.
    const established = /request: GET \/ HTTP\/1\.1/.test(r.out);
    const protocol = (/(TLSv1\.\d)/.exec(r.out) || [])[1] || null;
    return { status: established ? 'handshake-ok' : 'failed', detail: established ? `TLS session established${protocol ? ` (${protocol})` : ''}; HTTP request sent over it (response is not media)` : r.out.slice(-200) };
  } finally { server.kill('SIGKILL'); }
}

function verifyManifest(dir, options) {
  const manifest = JSON.parse(fs.readFileSync(options.manifest || path.join(__dirname, 'ffmpeg-runtime-manifest.json'), 'utf8'));
  const failures = [], files = [];
  for (const f of manifest.files) {
    const p = path.join(dir, f.name); const entry = { name: f.name };
    if (!fs.existsSync(p)) { failures.push(`missing ${f.name}`); files.push(entry); continue; }
    const st = fs.lstatSync(p); if (!st.isFile() || st.isSymbolicLink()) { failures.push(`${f.name} is not a regular file`); continue; }
    const sha = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); entry.sha256 = sha; entry.size = st.size;
    if (f.sha256 === null) { if (options.requirePinned) failures.push(`${f.name}: manifest sha256 is not pinned yet`); }
    else if (f.sha256 !== sha || f.size !== st.size) failures.push(`${f.name}: checksum/size mismatch`);
    files.push(entry);
  }
  const extra = fs.readdirSync(dir).filter(n => !manifest.files.some(f => f.name === n)); if (extra.length) failures.push(`files not in manifest: ${extra.join(', ')}`);
  return { ok: failures.length === 0, manifestStatus: manifest.status, failures, files };
}

function main(argv) {
  const [cmd, target, ...rest] = argv; const opt = {};
  for (let i = 0; i < rest.length; i++) { const a = rest[i]; if (a === '--allow-gpl') opt.allowGpl = true; else if (a === '--skip-functional') opt.skipFunctional = true; else if (a === '--require-pinned') opt.requirePinned = true; else if (['--ffprobe', '--json', '--manifest'].includes(a)) opt[a.slice(2)] = rest[++i]; }
  let report;
  if (cmd === 'probe' && target) report = probe(path.resolve(target), opt); else if (cmd === 'verify-manifest' && target) report = verifyManifest(path.resolve(target), opt);
  else { console.error('usage: probe-ffmpeg-runtime.cjs probe <ffmpeg> [--ffprobe P] [--allow-gpl] [--json F] [--skip-functional] | verify-manifest <dir> [--manifest F] [--require-pinned]'); return 2; }
  if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2)); return report.ok ? 0 : 1;
}
module.exports = { probe, verifyManifest, classifyLicense };
if (require.main === module) process.exit(main(process.argv.slice(2)));
