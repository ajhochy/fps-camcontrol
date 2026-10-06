import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(__dirname, '../..');
const pathsModule = path.join(repoRoot, 'src/config/paths.ts');

function loadPaths() {
  assert.ok(fs.existsSync(pathsModule), 'issue-40: src/config/paths.ts must provide the app-home path abstraction');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(pathsModule) as {
    getAppHome(): string;
    getUserPath(relativePath: string): string;
  };
}

test('issue-40-c1: development app home defaults to the current working directory', () => {
  const previousHome = process.env.CAMCONTROL_HOME;
  delete process.env.CAMCONTROL_HOME;
  try {
    const paths = loadPaths();
    assert.equal(paths.getAppHome(), process.cwd());
  } finally {
    if (previousHome === undefined) delete process.env.CAMCONTROL_HOME;
    else process.env.CAMCONTROL_HOME = previousHome;
  }
});

test('issue-40-c2: CAMCONTROL_HOME overrides the app home', () => {
  const previousHome = process.env.CAMCONTROL_HOME;
  const override = path.resolve(process.cwd(), '.contract-camcontrol-home');
  process.env.CAMCONTROL_HOME = override;
  try {
    const paths = loadPaths();
    assert.equal(paths.getAppHome(), override);
  } finally {
    if (previousHome === undefined) delete process.env.CAMCONTROL_HOME;
    else process.env.CAMCONTROL_HOME = previousHome;
  }
});

test('issue-40-c3: mutable config resolves under app home and shipped definitions use resources', () => {
  const home = path.resolve(process.cwd(), '.contract-path-home');
  const previousHome = process.env.CAMCONTROL_HOME;
  process.env.CAMCONTROL_HOME = home;
  const cases = [
    'config/devices.yaml',
    'config/speeds.json',
    'config/mappings.yaml',
    'config/sony-state.json',
    'config/working-profile.json',
  ];

  try {
    const paths = loadPaths();
    for (const relativePath of cases) {
      const resolved = path.resolve(paths.getUserPath(relativePath));
      assert.equal(resolved, path.join(home, relativePath), `${relativePath} should resolve under CAMCONTROL_HOME`);
    }

    for (const consumer of [
      'src/config/configLoader.ts',
    ]) {
      const source = fs.readFileSync(path.join(repoRoot, consumer), 'utf8');
      assert.equal(source.includes('process.cwd()'), false, `${consumer} must use the centralized path abstraction`);
      assert.match(source, /getUserPath\(/, `${consumer} must resolve mutable files through the app home`);
    }
    const startup = fs.readFileSync(path.join(repoRoot, 'src/index.ts'), 'utf8');
    assert.match(startup, /getResourcePath\('controller-profiles'\)/, 'shipped controller definitions must come from immutable resources');
    const status = fs.readFileSync(path.join(repoRoot, 'src/ui/statusServer.ts'), 'utf8');
    assert.match(status, /getResourcePath\('controller-profiles'\)/);
    assert.match(status, /getResourcePath\('docs\/sony-sidecar-setup.md'\)/);
  } finally {
    if (previousHome === undefined) delete process.env.CAMCONTROL_HOME;
    else process.env.CAMCONTROL_HOME = previousHome;
  }
});
