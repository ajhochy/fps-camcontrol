module.exports = {
  appId: 'com.ajhochhalter.fpscamcontrol.probe',
  productName: 'FPS CamControl Probe',
  directories: { app: 'dist/electron-probe-stage', output: 'dist/electron-probe' },
  files: ['package.json', 'main.cjs', 'utility.cjs', 'probe.html', 'node_modules/**/*', 'LICENSE'],
  asar: true, asarUnpack: ['**/*.node'], npmRebuild: false,
  mac: { target: [{ target: 'dmg', arch: ['arm64'] }], minimumSystemVersion: '13.0',
    identity: null, hardenedRuntime: true, notarize: false },
  dmg: { sign: false },
  publish: null,
  artifactName: '${productName}-${version}-${arch}.${ext}'
};
