#!/usr/bin/env node
'use strict';

// Historical filename retained for the package hook; both variants share signing
// rules without borrowing another app's identity or resources.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TEAM_ID, VARIANTS, SafeError, resolveIdentity, readAppleEnvironment,
  notaryAuth, run, notaryRequest, needsJit, fileEvidence, inspectApp } = require('./electron-signing-support.cjs');
const ROOT = path.resolve(__dirname, '..');

function options(argv) {
  const result = { variant: 'manual', signOnly: false, checkCredentials: false, dmgOnly: false };
  const values = new Map([['--variant', 'variant'], ['--app', 'app'], ['--dmg', 'dmg'],
    ['--credentials-file', 'credentialsFile'], ['--output-dir', 'outputDir']]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sign-only') result.signOnly = true;
    else if (arg === '--check-credentials') result.checkCredentials = true;
    else if (arg === '--dmg-only') result.dmgOnly = true;
    else if (arg === '--help') result.help = true;
    else if (values.has(arg) && argv[i + 1] && !argv[i + 1].startsWith('--')) result[values.get(arg)] = argv[++i];
    else throw new SafeError('Unknown or incomplete signing argument; use --help');
  }
  if (!VARIANTS[result.variant]) throw new SafeError('Variant must be manual or tracking');
  if ([result.signOnly, result.checkCredentials, result.dmgOnly].filter(Boolean).length > 1) throw new SafeError('Choose one signing operation');
  if (result.dmgOnly && !result.dmg) throw new SafeError('--dmg-only requires an existing --dmg path');
  if (result.dmg && !result.dmgOnly) throw new SafeError('--dmg requires --dmg-only; full delivery creates a new DMG from the stapled app');
  for (const key of ['app', 'dmg', 'credentialsFile', 'outputDir']) {
    if (result[key] && !path.isAbsolute(result[key])) throw new SafeError(`${key} must be an absolute path`);
  }
  return result;
}

function writeEvidence(directory, name, data) {
  fs.writeFileSync(path.join(directory, name), `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o400 });
}

async function signApp(app, inspection, identity, runner = run) {
  const entitlements = path.join(ROOT, 'electron/manual/entitlements.plist');
  for (const target of [...inspection.targets, app]) {
    const args = ['--force', '--options', 'runtime', '--timestamp', '--sign', identity];
    if (needsJit(target, app)) args.push('--entitlements', entitlements);
    await runner('/usr/bin/codesign', [...args, target], { label: 'Developer ID signing' });
    await runner('/usr/bin/codesign', ['--verify', '--strict', target], { label: 'Nested signature verification' });
  }
  await runner('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { label: 'Strict app signature verification' });
}

async function accepted(artifact, auth, evidenceDir, kind, { runner = run, delay = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const submit = await notaryRequest('submit', artifact, auth, runner);
  if (!/^[a-f0-9-]{36}$/i.test(submit.id || '')) throw new SafeError('Apple did not return a valid submission ID');
  writeEvidence(evidenceDir, `${kind}-submission.json`, { id: submit.id, submittedAt: new Date().toISOString(), archive: fileEvidence(artifact) });
  process.stdout.write(`${kind} uploaded; waiting for Apple's result.\n`);
  const deadline = now() + 30 * 60 * 1000;
  for (;;) {
    const result = await notaryRequest('info', submit.id, auth, runner);
    if (result.status === 'Accepted') {
      const evidence = { id: submit.id, status: 'Accepted', acceptedAt: new Date().toISOString() };
      writeEvidence(evidenceDir, `${kind}-accepted.json`, evidence);
      const log = await notaryRequest('log', submit.id, auth, runner);
      if (log.jobId !== submit.id || log.status !== 'Accepted') throw new SafeError('Apple completed log does not match the accepted submission; receipt preserved');
      writeEvidence(evidenceDir, `${kind}-notary-log.json`, log);
      return evidence;
    }
    if (result.status !== 'In Progress' || now() > deadline) {
      const status = result.status === 'Invalid' || result.status === 'Rejected' ? result.status : 'PENDING';
      writeEvidence(evidenceDir, `${kind}-not-accepted.json`, { id: submit.id, status });
      throw new SafeError(`Apple ${kind} has not reported Accepted (${status}); submission receipt preserved`);
    }
    await delay(30000);
  }
}

async function verifyDmg(dmg, runner = run) {
  await runner('/usr/bin/xcrun', ['stapler', 'staple', dmg], { label: 'DMG ticket stapling' });
  await runner('/usr/bin/xcrun', ['stapler', 'validate', dmg], { label: 'DMG ticket verification' });
  await runner('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', dmg], { label: 'DMG signature verification' });
  await runner('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmg], { label: 'DMG Gatekeeper assessment' });
}

async function inspectDmg(dmg, variant, runner = run) {
  const attach = await runner('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-plist', dmg], { label: 'Read-only DMG inspection mount' });
  let mount;
  try {
    const converted = await runner('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: attach.stdout, label: 'DMG mount metadata inspection' });
    const entities = JSON.parse(converted.stdout)['system-entities'];
    const mounts = entities.filter(item => item['mount-point']);
    if (mounts.length !== 1) throw new SafeError('DMG must contain exactly one mountable volume');
    mount = mounts[0]['mount-point'];
    const apps = fs.readdirSync(mount).filter(name => name.endsWith('.app'));
    if (apps.length !== 1) throw new SafeError('DMG must contain exactly one FPS app');
    const app = path.join(mount, apps[0]);
    const inspection = await inspectApp(app, variant, runner);
    await runner('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { label: 'DMG embedded app signature verification' });
    const signature = await runner('/usr/bin/codesign', ['-d', '--verbose=4', app], { label: 'DMG embedded app identity verification' });
    if (!(signature.stderr + signature.stdout).includes(`TeamIdentifier=${TEAM_ID}`)) throw new SafeError('DMG embedded app has unexpected signing team');
    await runner('/usr/bin/xcrun', ['stapler', 'validate', app], { label: 'DMG embedded app ticket verification' });
    return inspection;
  } finally {
    if (mount) await runner('/usr/bin/hdiutil', ['detach', mount], { label: 'Owned inspection volume detach' });
  }
}

async function finalizeApp(app, auth, directory, identity, inspection, runner = run) {
  const name = path.basename(app, '.app');
  const submittedZip = path.join(directory, `${name}-submitted.zip`);
  await runner('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, submittedZip], { label: 'Notary upload archive' });
  const appAcceptance = await accepted(submittedZip, auth, directory, 'app', { runner });
  await runner('/usr/bin/xcrun', ['stapler', 'staple', app], { label: 'App ticket stapling' });
  await runner('/usr/bin/xcrun', ['stapler', 'validate', app], { label: 'App ticket verification' });
  await runner('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { label: 'Stapled app signature verification' });
  await runner('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app], { label: 'App Gatekeeper assessment' });
  // Fresh filename prevents retaining the pre-stapling upload archive by mistake.
  const zip = path.join(directory, `${name}-${inspection.version}-arm64-notarized.zip`);
  await runner('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip], { label: 'Final stapled app archive' });
  const imageRoot = path.join(directory, 'dmg-root');
  fs.mkdirSync(imageRoot);
  await runner('/usr/bin/ditto', [app, path.join(imageRoot, path.basename(app))], { label: 'Stapled app DMG staging' });
  fs.symlinkSync('/Applications', path.join(imageRoot, 'Applications'));
  const dmg = path.join(directory, `${name}-${inspection.version}-arm64-notarized.dmg`);
  await runner('/usr/bin/hdiutil', ['create', '-volname', name, '-srcfolder', imageRoot, '-format', 'UDZO', dmg], { timeout: 300000, label: 'Final DMG creation' });
  await runner('/usr/bin/codesign', ['--force', '--timestamp', '--sign', identity, dmg], { label: 'DMG Developer ID signing' });
  const dmgAcceptance = await accepted(dmg, auth, directory, 'dmg', { runner });
  await verifyDmg(dmg, runner);
  return { appAcceptance, dmgAcceptance, zip: fileEvidence(zip), dmg: fileEvidence(dmg) };
}

async function main(argv = process.argv.slice(2)) {
  const args = options(argv);
  if (args.help) {
    console.log('FPS signing: [--variant manual|tracking] [--app /absolute/App.app] [--sign-only]\n' +
      'Notarize: [--credentials-file /absolute/private.env] [--output-dir /absolute/new-directory]\n' +
      'Existing DMG: --dmg-only --dmg /absolute/installer.dmg\n' +
      'Credential preflight: --check-credentials [--credentials-file /absolute/private.env]\n' +
      'No release publication or Keychain modification is performed.');
    return;
  }
  if (process.platform !== 'darwin') throw new SafeError('Signing requires macOS');
  const env = readAppleEnvironment(args.credentialsFile);
  const auth = args.signOnly ? null : notaryAuth(env);
  // Read-only Apple check precedes signing/copying. Account-agreement errors fail
  // before modifying an app or submitting any archive.
  if (auth) await notaryRequest('history', null, auth);
  if (args.checkCredentials) { console.log(`Apple notary authentication succeeded (${auth.mode}); no submission made.`); return; }
  if (env.APPLE_TEAM_ID && env.APPLE_TEAM_ID !== TEAM_ID) throw new SafeError('Unexpected Apple signing team');
  const valid = await run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { label: 'Existing signing identity inspection' });
  const identity = resolveIdentity(env.APPLE_SIGNING_IDENTITY, valid.stdout);
  const sourceCommit = (await run('/usr/bin/git', ['-C', ROOT, 'rev-parse', 'HEAD'], { label: 'Source commit inspection' })).stdout.trim();
  const sourceDirty = !!(await run('/usr/bin/git', ['-C', ROOT, 'status', '--porcelain'], { label: 'Source worktree inspection' })).stdout.trim();
  const directory = args.outputDir || path.join(ROOT, 'release', args.variant, 'signing-evidence', `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`);
  if (fs.existsSync(directory)) throw new SafeError('Output directory already exists; preserved evidence may not be overwritten');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (args.dmgOnly) {
    if (!args.dmg.endsWith('.dmg') || !fs.lstatSync(args.dmg).isFile() || fs.lstatSync(args.dmg).isSymbolicLink()) throw new SafeError('DMG must be an existing regular .dmg file');
    const inspection = await inspectDmg(args.dmg, args.variant);
    const dmg = path.join(directory, path.basename(args.dmg));
    fs.copyFileSync(args.dmg, dmg, fs.constants.COPYFILE_EXCL);
    await run('/usr/bin/codesign', ['--force', '--timestamp', '--sign', identity, dmg], { label: 'DMG Developer ID signing' });
    const acceptance = await accepted(dmg, auth, directory, 'dmg');
    await verifyDmg(dmg);
    writeEvidence(directory, 'delivery.json', { createdAt: new Date().toISOString(), team: TEAM_ID, identity, variant: args.variant,
      appId: inspection.appId, version: inspection.version, architecture: inspection.architecture, minimumMacOS: inspection.minimumMacOS,
      sourceCommit, sourceDirty, acceptance, dmg: fileEvidence(dmg), cleanOS: 'NOT_TESTED' });
    console.log(`DMG Accepted, stapled and assessed. Evidence: ${directory}`);
    return;
  }
  const inputApp = args.app || path.join(ROOT, 'release', args.variant, 'mac-arm64', `${VARIANTS[args.variant].name}.app`);
  const inputInspection = await inspectApp(inputApp, args.variant);
  let app = inputApp;
  if (!args.signOnly) {
    app = path.join(directory, path.basename(inputApp));
    await run('/usr/bin/ditto', [inputApp, app], { label: 'Isolated release app copy' });
  }
  const inspection = args.signOnly ? inputInspection : await inspectApp(app, args.variant);
  await signApp(app, inspection, identity);
  writeEvidence(directory, 'signature.json', { createdAt: new Date().toISOString(), variant: args.variant, app, sourceCommit, sourceDirty,
    identity, team: TEAM_ID, appId: inspection.appId, version: inspection.version, architecture: inspection.architecture,
    minimumMacOS: inspection.minimumMacOS, highestBinaryMinimumMacOS: inspection.highestBinaryMinimumMacOS,
    native: inspection.native, strictSignatureVerification: 'PASS', notarization: args.signOnly ? 'NOT_RUN' : 'PENDING' });
  if (args.signOnly) { console.log(`Developer ID strict verification passed (${inspection.native.length} Mach-O files); notary NOT RUN. Evidence: ${directory}`); return; }
  const artifacts = await finalizeApp(app, auth, directory, identity, inspection);
  writeEvidence(directory, 'delivery.json', { createdAt: new Date().toISOString(), variant: args.variant, sourceCommit, sourceDirty,
    appId: inspection.appId, version: inspection.version, architecture: 'arm64', minimumMacOS: inspection.minimumMacOS,
    team: TEAM_ID, identity, ...artifacts, codesign: 'PASS', appStaple: 'PASS', dmgStaple: 'PASS', gatekeeper: 'PASS',
    cleanOS: 'NOT_TESTED', physicalHID: 'NOT_TESTED' });
  console.log(`App and DMG Accepted, stapled and assessed. Final artifacts/evidence: ${directory}`);
}

if (require.main === module) main().catch(error => {
  console.error(error instanceof SafeError ? error.message : 'Signing/notarization failed; private command/error output suppressed');
  process.exitCode = 1;
});
module.exports = { options, writeEvidence, signApp, accepted, finalizeApp, verifyDmg, inspectDmg, main };
