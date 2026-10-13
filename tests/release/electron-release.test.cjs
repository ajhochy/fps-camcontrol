const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const repoRoot = path.resolve(__dirname, '../..');
const workflowPath = path.join(repoRoot, '.github/workflows/electron_release.yml');
const sourcePinsPath = path.join(repoRoot, '.github/electron-release-sources.json');
const helperPath = path.join(repoRoot, 'scripts/electron-release.cjs');
const manualSha = '133ae8d9620665b1e87b799a765a619ccae06ebc';
const trackingSha = 'b06c6d23736af2bf8b69284a9e737a17029c1b25';

function readWorkflow() {
  assert.ok(fs.existsSync(workflowPath), 'release-c1: .github/workflows/electron_release.yml must exist');
  return yaml.load(fs.readFileSync(workflowPath, 'utf8'));
}

function readSourcePins() {
  assert.ok(fs.existsSync(sourcePinsPath), 'release-c2: pinned release sources must be recorded in .github/electron-release-sources.json');
  return JSON.parse(fs.readFileSync(sourcePinsPath, 'utf8'));
}

function readHelper() {
  assert.ok(fs.existsSync(helperPath), 'release helper scripts/electron-release.cjs must exist');
  const helper = require(helperPath);
  assert.equal(typeof helper.validateReleaseInputs, 'function', 'release helper must export validateReleaseInputs(input)');
  assert.equal(typeof helper.collectReleaseAssets, 'function', 'release helper must export collectReleaseAssets(entries)');
  return helper;
}

function allText(value) {
  return JSON.stringify(value);
}

test('release-c1: dispatch, testing-tag, and read-only pull-request triggers are available', () => {
  const workflow = readWorkflow();
  const triggers = workflow.on || workflow.true;
  assert.ok(triggers, 'workflow must declare event triggers');
  assert.ok(triggers.workflow_dispatch, 'workflow must support manual dispatch');
  assert.ok(triggers.push && triggers.push.tags, 'workflow must bootstrap from testing tags');
  assert.ok(triggers.pull_request, 'workflow must validate pull requests without credentials');
  const dispatch = triggers.workflow_dispatch;
  const dispatchText = allText(dispatch);
  assert.match(dispatchText, /version/i, 'dispatch must accept a release label/version');
  assert.match(dispatchText, /qualif/i, 'dispatch must accept a qualification-only input');
  assert.doesNotMatch(allText(triggers.pull_request), /secret|sign|notariz|publish/i, 'pull-request validation must not request release credentials or publish');
});

test('release-c2: release variants use the full pinned manual and tracking source commits', () => {
  const pins = readSourcePins();
  const text = allText(pins);
  assert.match(text, new RegExp(manualSha), 'manual build source must be pinned to the supplied full SHA');
  assert.match(text, new RegExp(trackingSha), 'tracking build source must be pinned to the supplied full SHA');
  assert.match(text, /manual/i, 'manual source pin must identify its variant');
  assert.match(text, /tracking/i, 'tracking source pin must identify its variant');
  const shaValues = text.match(/[0-9a-f]{40}/g) || [];
  assert.ok(shaValues.length >= 2, 'both sources must be represented by full 40-character commits');
});

test('release-c3: hosted builds run on native Apple Silicon and install dependencies before scoped signing credentials', () => {
  const workflow = readWorkflow();
  const jobs = Object.values(workflow.jobs || {});
  assert.ok(jobs.length > 0, 'workflow must define jobs');
  const buildJobs = jobs.filter((job) => /macos/i.test(allText(job['runs-on'])) && /arm64|aarch64/i.test(allText(job)));
  assert.ok(buildJobs.length > 0, 'build must target a native Apple Silicon macOS runner');
  for (const job of buildJobs) {
    const jobText = allText(job);
    assert.match(allText(job.if), /workflow_dispatch|push/i, 'release builds must be limited to explicit release dispatch or testing tags');
    assert.doesNotMatch(allText(job.if), /pull_request/i, 'pull requests must not run release build/signing jobs');
    assert.doesNotMatch(jobText, /macos-.*-x64|architecture\s*:\s*["']?x64/i, 'release matrix must not build x64');
    assert.equal(Boolean(job.env && /APPLE_|CERTIFICATE|NOTARY|KEYCHAIN/i.test(allText(job.env))), false, 'signing credentials must not be job-wide environment');
    const steps = job.steps || [];
    const serialized = steps.map(allText);
    const dependencyIndex = serialized.findIndex((step) => /pnpm (?:install|fetch)|npm ci|pip install|stage-tracking-runtime/i.test(step));
    const credentialIndex = serialized.findIndex((step) => /security import|notarytool|create-keychain|keychain.*import/i.test(step));
    assert.ok(dependencyIndex >= 0, 'build job must install or stage dependencies');
    assert.ok(credentialIndex > dependencyIndex, 'signing setup must follow dependency installation and staging');
    for (let index = 0; index <= dependencyIndex; index += 1) {
      assert.doesNotMatch(serialized[index], /\$\{\{\s*secrets\./, 'secrets must not be exposed to dependency steps');
    }
  }
});

test('release-c4: temporary signing keychains are removed by unconditional cleanup', () => {
  const workflow = readWorkflow();
  const steps = Object.values(workflow.jobs || {}).flatMap((job) => job.steps || []);
  const text = allText(workflow);
  assert.match(text, /security (?:create-keychain|import)/i, 'workflow must create or import a temporary signing keychain');
  const cleanup = steps.find((step) => /security delete-keychain/i.test(allText(step)));
  assert.ok(cleanup, 'workflow must delete the temporary keychain');
  assert.match(allText(cleanup.if), /always\(\)/i, 'keychain cleanup must run after failed as well as successful steps');
});

test('release-c5: both verified installer artifacts feed one prerelease publication job', () => {
  const workflow = readWorkflow();
  const jobs = Object.entries(workflow.jobs || {});
  const publishers = jobs.filter(([, job]) => /release create|softprops\/action-gh-release|create-release/i.test(allText(job)));
  assert.equal(publishers.length, 1, 'a single job must publish the release');
  const [publishName, publisher] = publishers[0];
  const needs = Array.isArray(publisher.needs) ? publisher.needs : [publisher.needs];
  assert.ok(needs.length > 0, 'publication must depend on completed build jobs');
  assert.ok(needs.every((name) => jobs.some(([jobName]) => jobName === name)), 'publication dependencies must exist');
  const beforePublish = jobs.filter(([name]) => needs.includes(name));
  const buildText = allText(beforePublish);
  assert.match(buildText, /manual/i, 'manual installer must be built and verified before publication');
  assert.match(buildText, /tracking/i, 'tracking installer must be built and verified before publication');
  assert.match(allText(publisher), /prerelease\s*:\s*true|--prerelease/i, 'publication must be a prerelease');
  assert.match(allText(publisher), /not_latest|make_latest\s*:\s*false|--latest=false/i, 'publication must not become the latest release');
  assert.ok(publishName, 'publisher job must have an identity');
});

test('release-c6: qualification-only runs skip publication and existing releases/assets are never overwritten', () => {
  const workflow = readWorkflow();
  const publishers = Object.values(workflow.jobs || {}).filter((job) => /release create|softprops\/action-gh-release|create-release/i.test(allText(job)));
  assert.equal(publishers.length, 1, 'a single job must publish the release');
  assert.match(allText(publishers[0].if), /qualif/i, 'qualification-only must gate the publication job');
  const text = allText(workflow);
  assert.match(text, /gh release create|softprops\/action-gh-release|create-release/i, 'workflow must use release creation that refuses an existing tag');
  assert.doesNotMatch(text, /--clobber|overwrite\s*:\s*true|delete-release/i, 'workflow must not replace an existing release or asset');
});

test('release-c7: invalid release versions and non-full source SHAs are rejected before build', () => {
  const { validateReleaseInputs } = readHelper();
  const valid = validateReleaseInputs({ version: 'testing-2026.10.01', manualSourceSha: manualSha, trackingSourceSha: trackingSha, qualificationOnly: false });
  assert.equal(valid.tag, 'electron-testing-2026.10.01', 'validation must produce the deterministic release tag');
  assert.ok(Array.isArray(valid.matrix), 'validation must produce the build matrix');
  assert.deepEqual(valid.matrix.map((entry) => [entry.variant, entry.sourceSha]), [['manual', manualSha], ['tracking', trackingSha]], 'matrix entries must preserve each full source SHA');
  assert.throws(() => validateReleaseInputs({ version: '../latest', manualSourceSha: manualSha, trackingSourceSha: trackingSha, qualificationOnly: false }), /version|label|invalid/i);
  assert.throws(() => validateReleaseInputs({ version: 'testing-2026.10.01', manualSourceSha: 'b06c6d2', trackingSourceSha: trackingSha, qualificationOnly: false }), /sha|commit|source/i);
});

test('release-c8: asset receipts include byte count, SHA-256, source, app version and minimum OS without paths or secrets', () => {
  const { collectReleaseAssets } = readHelper();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-release-contract-'));
  const secretNames = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'P12_PASSWORD'];
  const previousSecrets = Object.fromEntries(secretNames.map((name) => [name, process.env[name]]));
  const sentinels = secretNames.map((name) => `CONTRACT_ONLY_${name}_DO_NOT_PUBLISH`);
  try {
    secretNames.forEach((name, index) => { process.env[name] = sentinels[index]; });
    const manualPath = path.join(tempDir, 'manual.dmg');
    const trackingPath = path.join(tempDir, 'tracking.dmg');
    const manualBytes = Buffer.from('manual installer fixture');
    const trackingBytes = Buffer.from('tracking installer fixture');
    fs.writeFileSync(manualPath, manualBytes);
    fs.writeFileSync(trackingPath, trackingBytes);
    const assets = collectReleaseAssets([
      { variant: 'manual', path: manualPath, sourceSha: manualSha, releaseLabel: 'testing-2026.10.01', appVersion: '0.1.0', minimumOs: '13.0' },
      { variant: 'tracking', path: trackingPath, sourceSha: trackingSha, releaseLabel: 'testing-2026.10.01', appVersion: '0.1.0', minimumOs: '14.0' },
    ]);
    assert.equal(assets.length, 2, 'both variants need a receipt');
    for (const [variant, bytes, sourceSha, minimumOs] of [['manual', manualBytes, manualSha, '13.0'], ['tracking', trackingBytes, trackingSha, '14.0']]) {
      const asset = assets.find((entry) => entry.variant === variant);
      assert.ok(asset, `${variant} receipt must be present`);
      assert.equal(asset.bytes, bytes.length, 'receipt must record exact asset byte count');
      assert.equal(asset.sha256, crypto.createHash('sha256').update(bytes).digest('hex'), 'receipt must record exact SHA-256');
      assert.equal(asset.sourceSha, sourceSha, 'receipt must identify exact source commit');
      assert.equal(asset.releaseLabel, 'testing-2026.10.01', 'receipt must identify the release label');
      assert.equal(asset.appVersion, '0.1.0', 'receipt must identify the embedded app version');
      assert.equal(asset.minimumOs, minimumOs, 'receipt must identify minimum macOS version');
    }
    const publicText = JSON.stringify(assets);
    assert.equal(publicText.includes(tempDir), false, 'public receipts must not expose local paths');
    for (const sentinel of sentinels) assert.equal(publicText.includes(sentinel), false, 'public receipts must not expose signing secret values');
    assert.doesNotMatch(publicText, /APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD|P12_PASSWORD|BEGIN PRIVATE KEY/i, 'public receipts must not expose credentials');
  } finally {
    for (const name of secretNames) {
      if (previousSecrets[name] === undefined) delete process.env[name];
      else process.env[name] = previousSecrets[name];
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
