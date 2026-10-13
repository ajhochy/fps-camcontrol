const path = require('node:path');
const stage = process.env.FPS_TRACKING_STAGE;
module.exports = {
  appId: 'com.ajhochhalter.fpscamcontrol.tracking', productName: 'FPS CamControl Tracking',
  electronVersion: require('./package.json').devDependencies.electron,
  directories: { app: stage, output: path.join(__dirname, 'release/tracking') },
  files: ['package.json', 'electron/**/*.cjs', 'electron/**/*.html', 'electron/**/*.js', 'LICENSE'],
  extraResources: [
    { from: `${stage}/backend`, to: 'backend' },
    { from: `${stage}/backend/node_modules`, to: 'backend/node_modules', filter: ['**/*'] },
    { from: path.join(__dirname, 'resources/defaults'), to: 'defaults' },
    { from: `${stage}/THIRD-PARTY-NOTICES.txt`, to: 'THIRD-PARTY-NOTICES.txt' },
    { from: `${stage}/tracking-runtime/python`, to: 'python' },
    { from: `${stage}/tracking-runtime/models`, to: 'models' },
    { from: `${stage}/tracking-runtime/notices`, to: 'notices' },
    { from: `${stage}/tracking-runtime/runtime-manifest.json`, to: 'runtime-manifest.json' },
    { from: `${stage}/tracker-sidecar`, to: 'tracker-sidecar' },
  ],
  asar: true, npmRebuild: false,
  mac: {
    target: [{ target: 'dmg', arch: ['arm64'] }], minimumSystemVersion: '14.0', identity: null, hardenedRuntime: true, notarize: false,
    extendInfo: { NSLocalNetworkUsageDescription: 'Connect to your configured cameras, gimbal bridges, and ATEM switcher on your local network.' },
  },
  dmg: { sign: false }, publish: null,
  artifactName: '${productName}-tracking-${version}-${arch}.${ext}',
};
