// Distinct identity/data directory, with the same verified production shell.
require('../main.cjs').createShell(require('electron'), {
  userDataName: 'FPS CamControl Tracking', tracking: true,
}).start();
