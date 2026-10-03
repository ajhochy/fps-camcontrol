const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const stage = path.join(root, 'dist/electron-probe-stage');
fs.mkdirSync(stage, {recursive:true});
const pkg = require('../package.json');
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({name:'fps-camcontrol-probe',
  version:pkg.version, private:true, main:'main.cjs', license:'MIT', author:pkg.author,
  description:'Non-shipping native feasibility probe', dependencies:{'node-hid':'3.3.0'}},null,2));
for (const file of ['main.cjs','utility.cjs','probe.html']) fs.copyFileSync(path.join(root,'electron/probe',file),path.join(stage,file));
fs.copyFileSync(path.join(root,'LICENSE'),path.join(stage,'LICENSE'));
fs.writeFileSync(path.join(stage,'.npmrc'),'node-linker=hoisted\n');
fs.writeFileSync(path.join(stage,'pnpm-workspace.yaml'),'packages: []\nnodeLinker: hoisted\n');
// ponytail: isolated staging install, never rebuild the Node-side node_modules for Electron.
execFileSync('pnpm', ['install','--ignore-scripts','--no-frozen-lockfile'], {cwd:stage,stdio:'inherit'});
execFileSync(path.join(root,'node_modules/.bin/electron-rebuild'), ['--force','--version',pkg.devDependencies.electron,
  '--arch','arm64','--module-dir',stage,'--only','node-hid'], {cwd:root,stdio:'inherit'});
execFileSync(path.join(root,'node_modules/.bin/electron-builder'), ['--config','electron-builder.probe.cjs',
  '--mac','--arm64','--dir','--publish','never'], {cwd:root,stdio:'inherit',env:{...process.env,CSC_IDENTITY_AUTO_DISCOVERY:'false'}});
execFileSync(process.execPath,[path.join(root,'scripts/sign-electron-probe.cjs')],{cwd:root,stdio:'inherit'});
execFileSync(path.join(root,'node_modules/.bin/electron-builder'), ['--config','electron-builder.probe.cjs',
  '--mac','dmg','--arm64','--prepackaged',path.join(root,'dist/electron-probe/mac-arm64/FPS CamControl Probe.app'),
  '--publish','never'], {cwd:root,stdio:'inherit',env:{...process.env,CSC_IDENTITY_AUTO_DISCOVERY:'false'}});
