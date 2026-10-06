// Explicit lifecycle, running under Electron's own Node ABI.
const path = require('node:path');
process.chdir(process.env.CAMCONTROL_HOME);
const { acquire } = require(path.join(process.env.CAMCONTROL_RESOURCES, 'electron/production-lock.cjs'));
acquire(path.dirname(process.env.CAMCONTROL_HOME), 'backend').then(() =>
  require(path.join(process.env.CAMCONTROL_RESOURCES, 'dist/embed.js')).runEmbedded()
).catch(() => {
  // Never relay arbitrary backend/config/credential-bearing errors to the renderer.
  console.error('The local control service could not start.');
  process.exit(1);
});
