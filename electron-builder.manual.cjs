const path = require('node:path');
module.exports = {
  appId: 'com.ajhochhalter.fpscamcontrol', productName: 'FPS CamControl',
  electronVersion: require('./package.json').devDependencies.electron,
  directories: { app: process.env.FPS_MANUAL_STAGE, output: path.join(__dirname, 'release/manual') },
  files: ['package.json', 'electron/**/*.cjs', 'electron/**/*.html', 'electron/**/*.js', 'LICENSE'],
  extraResources: [
    { from: `${process.env.FPS_MANUAL_STAGE}/backend`, to: 'backend' },
    { from: `${process.env.FPS_MANUAL_STAGE}/backend/node_modules`, to: 'backend/node_modules', filter: ['**/*'] },
    { from: path.join(__dirname, 'resources/defaults'), to: 'defaults' },
    { from: `${process.env.FPS_MANUAL_STAGE}/THIRD-PARTY-NOTICES.txt`, to: 'THIRD-PARTY-NOTICES.txt' },
  ],
  asar: true, npmRebuild: false,
  mac: {
    target: [{ target: 'dmg', arch: ['arm64'] }], minimumSystemVersion: '13.0', identity: null, hardenedRuntime: true, notarize: false,
    extendInfo: { NSLocalNetworkUsageDescription: 'Connect to your configured cameras, gimbal bridges, and ATEM switcher on your local network.' },
  },
  dmg: { sign: false }, publish: null,
  artifactName: '${productName}-manual-${version}-${arch}.${ext}',
};
