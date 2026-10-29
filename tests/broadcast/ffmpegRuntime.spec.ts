import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { probe, verifyManifest, classifyLicense } = require('../../scripts/probe-ffmpeg-runtime.cjs');
const contract = require('../../scripts/ffmpeg-runtime-capabilities.json');
const manifest = require('../../scripts/ffmpeg-runtime-manifest.json');
const DEV = '/opt/homebrew/bin/ffmpeg';

test('runtime contract: DeckLink is not required of FFmpeg, nonfree is forbidden, every streaming capability is listed', () => {
  assert.ok(contract.forbiddenConfigureFlags.includes('--enable-nonfree') && contract.forbiddenConfigureFlags.includes('--enable-decklink'));
  const f = contract.ffmpeg;
  for (const need of ['h264_videotoolbox', 'aac']) assert.ok(f.encoders.includes(need));
  for (const need of ['tee', 'fifo', 'flv', 'mp4']) assert.ok(f.muxers.includes(need));
  for (const need of ['rtmp', 'rtmps', 'tls']) assert.ok(f.protocols.includes(need));
  assert.ok(f.demuxers.includes('matroska,webm') && f.pixelFormats.includes('uyvy422'));
});

test('manifest: LGPL path, no GPL/nonfree/DeckLink configure flags, sources pinned to verified checksums', () => {
  assert.equal(manifest.architecture, 'arm64'); assert.equal(manifest.licenseClass, 'lgpl-3.0-or-later');
  assert.ok(manifest.configure.includes('--disable-gpl') && manifest.configure.includes('--disable-nonfree') && manifest.configure.includes('--enable-version3'));
  for (const bad of ['--enable-gpl', '--enable-nonfree', '--enable-decklink', '--enable-libx264', '--enable-libx265']) assert.ok(!manifest.configure.includes(bad), bad);
  assert.ok(manifest.configure.includes('--enable-videotoolbox') && manifest.configure.includes('--enable-openssl'));
  // Sources were downloaded with approval and verified (PGP for FFmpeg, published .sha256 for OpenSSL) before pinning.
  assert.ok(['PINNED-SOURCE', 'PINNED-BUILD'].includes(manifest.status), manifest.status);
  for (const s of manifest.source) {
    assert.match(String(s.sha256), /^[0-9a-f]{64}$/, `${s.filename} must be pinned to a SHA-256`);
    assert.ok(Number.isInteger(s.size) && s.size > 0, `${s.filename} must record its size`);
    assert.match(String(s.sha256Provenance), /verified/i, `${s.filename} must say how the checksum was verified`);
  }
  assert.ok(manifest.installedUse.forbidden.some((x: string) => /PATH/.test(x)));
});

test('license classification', () => {
  const gpl3 = 'ffmpeg is free software; ... GNU General Public License as published by the Free Software Foundation; either version 3 of the License';
  const lgpl3 = 'ffmpeg is free software; ... GNU Lesser General Public License as published by ... either version 3 of the License';
  assert.equal(classifyLicense(gpl3, '--enable-gpl --enable-version3'), 'gpl-3.0-or-later');
  assert.equal(classifyLicense(lgpl3, '--enable-version3 --enable-openssl'), 'lgpl-3.0-or-later');
  assert.equal(classifyLicense(lgpl3, '--enable-nonfree'), 'nonfree');
  assert.equal(classifyLicense('', ''), 'unknown');
});

test('manifest verification: unpinned fails when pinning is required, mismatches and extra files always fail', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ffrt-man-'));
  try {
    const file = path.join(dir, 'm.json'); const content = Buffer.from('hello');
    const m = (sha: string | null, size: number | null) => ({ status: 'T', files: [{ name: 'ffmpeg', sha256: sha, size }] });
    const bin = path.join(dir, 'bin'); require('node:fs').mkdirSync(bin); writeFileSync(path.join(bin, 'ffmpeg'), content);
    const sha = createHash('sha256').update(content).digest('hex');
    writeFileSync(file, JSON.stringify(m(null, null)));
    assert.equal(verifyManifest(bin, { manifest: file }).ok, true);
    assert.equal(verifyManifest(bin, { manifest: file, requirePinned: true }).ok, false);
    writeFileSync(file, JSON.stringify(m(sha, content.length))); assert.equal(verifyManifest(bin, { manifest: file, requirePinned: true }).ok, true);
    writeFileSync(file, JSON.stringify(m('0'.repeat(64), content.length))); assert.match(verifyManifest(bin, { manifest: file }).failures[0], /mismatch/);
    writeFileSync(file, JSON.stringify(m(sha, content.length))); writeFileSync(path.join(bin, 'extra'), 'x'); assert.match(verifyManifest(bin, { manifest: file }).failures[0], /not in manifest/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('probe: relative or missing binaries fail, a fake binary cannot pass', () => {
  assert.equal(probe('ffmpeg', {}).ok, false);
  assert.equal(probe('/nonexistent/ffmpeg', {}).ok, false);
});

// Developer binary only (skipped where Homebrew FFmpeg is absent): proves the probe both passes a capable binary and discriminates on license policy.
test('probe against the developer Homebrew FFmpeg: capabilities pass; GPL rejected unless explicitly allowed', { skip: !existsSync(DEV) }, () => {
  const strict = probe(DEV, { skipFunctional: true });
  assert.equal(strict.ok, false); assert.ok(strict.failures.some((f: string) => /GPL build/.test(f)));
  assert.deepEqual(Object.values(strict.checks).flatMap((c: any) => c.missing), [], 'every required capability is present');
  const allowed = probe(DEV, { allowGpl: true, skipFunctional: true });
  assert.equal(allowed.ok, true, JSON.stringify(allowed.failures));
  assert.ok(allowed.tls.includes('--enable-openssl'));
});
