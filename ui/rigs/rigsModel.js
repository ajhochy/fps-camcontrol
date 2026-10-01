/*
 * Rigs screen: the pure part. Turns the GET /api/rigs payload into list items, inspector fields and live
 * status lines. No DOM here, so it is tested in Node (src/testing/rigsUiModelTest.ts) and reused by rigs.js
 * in the browser. See docs/ai/plans/2026-09-30-device-config-rigs-ui.md.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RigsModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CONTROLLER = { vbot: 'V-BOT', birddog: 'BirdDog', gimbal: 'DJI gimbal', generic: 'Other VISCA-IP camera' };
  var SONY_STATE = {
    discovered_unapproved: 'New camera — connect to approve',
    connecting: 'Connecting',
    connected: 'Connected',
    disconnected: 'Disconnected',
    needs_pairing: 'Needs pairing / camera setup',
    error: 'Connection error',
  };
  var RETRYABLE = { disconnected: true, error: true, needs_pairing: true };
  var SONY_TONE = { connected: 'ok', connecting: 'warn', discovered_unapproved: 'warn', needs_pairing: 'warn', error: 'bad', disconnected: 'idle' };

  function sonyStateText(state) { return state ? (SONY_STATE[state] || String(state).replace(/_/g, ' ')) : 'Not seen yet'; }
  function sonyTone(state) { return (state && SONY_TONE[state]) || 'idle'; }
  function connectedTone(value) { return value === true ? 'ok' : value === false ? 'bad' : 'idle'; }
  function connectedText(value) { return value === true ? 'Connected' : value === false ? 'Not connected' : 'Unknown'; }

  function sonyCameras(data) { return (data && data.sony && data.sony.cameras) || []; }
  function cameraStatus(data, id) {
    if (!id) return null;
    var wanted = String(id).toUpperCase();
    return sonyCameras(data).filter(function (camera) { return String(camera.id).toUpperCase() === wanted; })[0] || null;
  }
  function sonyDevice(data, key) { return ((data && data.sonyDevices) || []).filter(function (device) { return device.key === key; })[0] || null; }

  function rigTitle(rig) { return rig.label || rig.id; }

  function rigCameraChip(rig) {
    if (rig.builtInCamera) return { text: 'Built-in camera', tone: 'idle' };
    if (rig.camera) return { text: rig.cameraLabel || rig.camera, tone: 'info' };
    return { text: 'No camera assigned', tone: 'warn' };
  }

  /** One summary of every Sony camera: the named devices plus cameras found that no device is bound to. */
  function sonyOverview(data) {
    var devices = (data && data.sonyDevices) || [];
    var found = (data && data.unboundCameras) || [];
    var sidecar = data && data.sony ? data.sony.sidecar : null;
    var total = devices.length + found.length;
    var connected = devices.filter(function (d) { return d.state === 'connected'; }).length + found.filter(function (c) { return c.state === 'connected'; }).length;
    var troubled = devices.filter(function (d) { return d.state === 'error' || d.state === 'needs_pairing'; }).length
      + found.filter(function (c) { return c.state === 'error' || c.state === 'needs_pairing'; }).length;
    var service = serviceState(sidecar);
    var dot;
    if (!sidecar || service.state === 'disabled') dot = 'idle';
    else if (service.state !== 'healthy') dot = 'bad';
    else if (troubled) dot = 'bad';
    else if (total && connected === total && !found.length) dot = 'ok';
    else if (total) dot = 'warn';
    else dot = 'idle';
    var chips = [];
    if (!sidecar) chips.push({ text: 'Sony service off', tone: 'idle' });
    else if (service.state !== 'healthy') chips.push({ text: service.text, tone: service.tone });
    else {
      chips.push({ text: connected + ' of ' + total + ' connected', tone: total && connected === total ? 'ok' : total ? 'warn' : 'idle' });
      if (found.length) chips.push({ text: found.length + ' new', tone: 'warn' });
    }
    return {
      dot: dot, chips: chips, total: total, connected: connected, troubled: troubled, service: service,
      subtitle: !sidecar ? 'Not configured' : total === 1 ? '1 camera' : total + ' cameras',
    };
  }

  var SERVICE_TEXT = { healthy: 'Running', absent: 'Not running', starting: 'Starting', crashed: 'Stopped after repeated failures', disabled: 'Turned off', stopped: 'Stopped from the app (cameras disconnected)' };
  var SERVICE_TONE = { healthy: 'ok', absent: 'bad', starting: 'warn', crashed: 'bad', disabled: 'idle', stopped: 'warn' };
  function serviceState(sidecar) {
    var state = sidecar && sidecar.state;
    return { state: state || 'disabled', text: SERVICE_TEXT[state] || (state ? String(state) : 'Not configured'), tone: SERVICE_TONE[state] || 'idle' };
  }

  /** The left column: sections of selectable items, in display order. */
  function itemsOf(data, pendingKey) {
    var rigs = ((data && data.rigs) || []).map(function (rig) {
      return {
        key: 'rig:' + (rig.deviceKey || rig.id),
        kind: 'rig',
        title: rigTitle(rig),
        subtitle: CONTROLLER[rig.controller] || rig.controller,
        badge: rig.hotkey || String(rig.position),
        chips: [
          { text: rig.wired ? 'ATEM ' + rig.inputId : 'Control only', tone: rig.wired ? 'info' : 'warn' },
          rigCameraChip(rig),
        ],
        dot: connectedTone(rig.live && rig.live.connected),
      };
    });
    if (pendingKey === 'new:rig') {
      rigs.push({ key: 'new:rig', kind: 'new-rig', title: 'New rig', subtitle: 'Not added yet', badge: '+', chips: [], dot: 'idle' });
    }
    var atem = (data && data.atem) || {};
    var connections = [{
      key: 'atem',
      kind: 'atem',
      title: 'ATEM switcher',
      subtitle: atem.ip || 'Not set',
      badge: null,
      chips: [],
      dot: connectedTone(data ? data.atemConnected : null),
    }];
    var overview = sonyOverview(data);
    connections.push({
      key: 'sony',
      kind: 'sony-connections',
      title: 'Sony connections',
      subtitle: overview.subtitle,
      badge: null,
      chips: overview.chips,
      dot: overview.dot,
    });
    return [
      { id: 'rigs', title: 'Rigs', items: rigs },
      { id: 'connections', title: 'Connections', items: connections },
    ];
  }

  function flatItems(data, pendingKey) {
    return itemsOf(data, pendingKey).reduce(function (all, section) { return all.concat(section.items); }, []);
  }
  function findItem(data, key) { return flatItems(data, key).filter(function (item) { return item.key === key; })[0] || null; }

  /** Keep the selection if it still exists; otherwise the first rig, else the first item, else nothing. */
  function resolveSelection(data, key) {
    if (key === 'new:rig') return key; // the form for a rig that is being added
    var items = flatItems(data);
    if (key && items.some(function (item) { return item.key === key; })) return key;
    return items.length ? items[0].key : null;
  }

  // Declarative editable controls. `path` says where the value goes in the PATCH body ('visca.host' -> {visca:{host}}).
  function ctl(id, label, type, value, path, extra) {
    var c = { id: id, label: label, type: type, value: value, path: path };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) c[k] = extra[k];
    return c;
  }
  function readonly(id, label, value, note) { return ctl(id, label, 'readonly', value, null, note ? { note: note } : {}); }

  function field(label, value, note) { var f = { label: label, value: value }; if (note) f.note = note; return f; }

  function findRig(data, key) {
    return ((data && data.rigs) || []).filter(function (rig) { return 'rig:' + (rig.deviceKey || rig.id) === key; })[0] || null;
  }

  /** The middle column: what can be configured for the selected item (read-only in this step). */
  function inspectorFor(data, key) {
    if (!key) return null;
    if (key.indexOf('rig:') === 0) return rigInspector(data, findRig(data, key));
    if (key === 'atem') return atemInspector(data);
    if (key === 'sony') return sonyConnectionsInspector(data);
    if (key === 'new:rig') return addRigInspector(data);
    return null;
  }

  function rigInspector(data, rig) {
    if (!rig) return null;
    var fields = [
      field('Name', rigTitle(rig)),
      field('Controller', CONTROLLER[rig.controller] || rig.controller, rig.controller === 'birddog' ? 'Has a built-in camera' : null),
    ];
    if (rig.visca) {
      fields.push(field('Camera address (IP)', rig.visca.host || 'Not set'));
      fields.push(field('Port', String(rig.visca.port)));
      fields.push(field('VISCA address', String(rig.visca.address)));
    }
    if (rig.gimbal) {
      fields.push(field('Bridge host', rig.gimbal.host));
      fields.push(field('Port', String(rig.gimbal.port)));
      fields.push(field('Gimbal model', rig.gimbal.gimbalModel || 'Not set'));
    }
    fields.push(field('ATEM input', rig.wired ? String(rig.inputId) : 'None — control only', rig.wired ? null : 'Motion works, but this rig cannot be taken live'));
    if (rig.builtInCamera) fields.push(field('Sony camera', 'Built-in camera'));
    else fields.push(field('Sony camera', rig.camera ? (rig.cameraLabel || rig.camera) : 'No camera assigned'));
    fields.push(field('Position', 'Rig ' + rig.position + ' (' + rig.id + ')' + (rig.hotkey ? ' — selected with ' + rig.hotkey : '')));
    var advanced = [field('Speed multiplier', String(rig.speedScale))];
    if (rig.gimbal) {
      advanced.push(field('Safety stop timeout', rig.gimbal.safetyTimeoutMs + ' ms'));
      advanced.push(field('Roll', rig.gimbal.rollEnabled ? 'On' : 'Off'));
    }
    var notes = [];
    if (rig.usedInProfiles && rig.usedInProfiles.length > 1) {
      notes.push('Shared hardware: used in ' + rig.usedInProfiles.length + ' profiles (' + rig.usedInProfiles.join(', ') + '). Changes to its name and connection apply to all of them.');
    }
    var editable = !!rig.deviceKey;
    var controls = [ctl('label', 'Name', 'text', rigTitle(rig), 'label', { maxLength: 64, required: true }),
      controllerControl(rig)];
    if (rig.visca) {
      controls.push(ctl('visca.host', 'Camera address (IP)', 'text', rig.visca.host || '', 'visca.host', { required: true, maxLength: 253 }));
      controls.push(ctl('visca.port', 'Port', 'number', rig.visca.port, 'visca.port', { min: 1, max: 65535, integer: true }));
      controls.push(ctl('visca.address', 'VISCA address', 'number', rig.visca.address, 'visca.address', { min: 0, max: 7, integer: true }));
    }
    if (rig.gimbal) {
      controls.push(ctl('gimbal.host', 'Bridge host', 'text', rig.gimbal.host, 'gimbal.host', { required: true, maxLength: 253 }));
      controls.push(ctl('gimbal.port', 'Port', 'number', rig.gimbal.port, 'gimbal.port', { min: 1, max: 65535, integer: true }));
      controls.push(gimbalChoiceControl(data, rig));
    }
    controls.push(ctl('inputId', 'ATEM input', 'number', rig.wired ? rig.inputId : '', 'inputId', { nullable: true, min: 1, max: 99, integer: true, placeholder: 'None — control only', note: 'Leave empty for control only: motion works, but this rig cannot be taken live' }));
    if (rig.builtInCamera) controls.push(readonly('camera', 'Sony camera', 'Built-in camera'));
    else controls.push(ctl('camera', 'Sony camera', 'select', rig.camera || '', 'camera', { nullable: true, options: cameraOptions(data, rig) }));
    controls.push(readonly('position', 'Position', 'Rig ' + rig.position + ' (' + rig.id + ')' + (rig.hotkey ? ' — selected with ' + rig.hotkey : '')));
    var advancedControls = [ctl('speedScale', 'Speed multiplier', 'number', rig.speedScale, 'speedScale', { min: 0.1, max: 5, step: 0.1 })];
    if (rig.gimbal) {
      advancedControls.push(ctl('gimbal.safetyTimeoutMs', 'Safety stop timeout (ms)', 'number', rig.gimbal.safetyTimeoutMs, 'gimbal.safetyTimeoutMs', { min: 50, max: 2000, integer: true, note: 'The gimbal stops if it hears nothing for this long' }));
      advancedControls.push(ctl('gimbal.rollEnabled', 'Roll', 'toggle', !!rig.gimbal.rollEnabled, 'gimbal.rollEnabled', {}));
    }
    return {
      kind: 'rig', title: rigTitle(rig), fields: fields, advanced: advanced, notes: notes,
      endpoint: editable ? '/api/rigs/' + encodeURIComponent(rig.deviceKey) : null,
      controls: controls, advancedControls: advancedControls,
      removable: editable && data.rigs.length > 1
        ? { allowed: true, endpoint: '/api/rigs/' + encodeURIComponent(rig.deviceKey), position: rig.position }
        : { allowed: false, reason: editable ? 'A profile needs at least one rig.' : 'This config has no profiles.' },
    };
  }

  /**
   * The controller type, as a choice. Changing it rebuilds the connection on the same address, so each choice
   * that would do more than relabel the camera asks first (see `confirm`).
   */
  function controllerControl(rig) {
    var isGimbal = rig.controller === 'gimbal';
    var confirm = {};
    CONTROLLER_CHOICES.forEach(function (choice) {
      if (choice.value === rig.controller) return;
      var toGimbal = choice.value === 'gimbal';
      // V-BOT, BirdDog and other VISCA-IP cameras share one kind of connection: switching between them only relabels.
      if (toGimbal === isGimbal) return;
      var lines = ['Change "' + rigTitle(rig) + '" to ' + CONTROLLER[choice.value] + '?'];
      lines.push(toGimbal
        ? 'It will be driven through the DJI bridge on the Pi. Afterwards, choose which gimbal from the Gimbal list.'
        : 'It will be controlled over VISCA at ' + ((rig.gimbal && rig.gimbal.host) || 'the same address') + ', port 52381, VISCA address 1. Check them afterwards.');
      lines.push('Presets saved for this rig were recorded for a ' + CONTROLLER[rig.controller] + ' and will not recall until they are saved again.');
      if (rig.usedInProfiles && rig.usedInProfiles.length > 1) lines.push('This hardware is used in ' + rig.usedInProfiles.length + ' profiles; all of them change.');
      confirm[choice.value] = lines.join('\n\n');
    });
    var note = rig.controller === 'birddog' ? 'Has a built-in camera' : null;
    if (rig.camera) note = 'A BirdDog has a built-in camera: take the Sony camera off this rig before choosing BirdDog';
    return ctl('controller', 'Controller', 'select', rig.controller, 'controller', { options: CONTROLLER_CHOICES, confirm: confirm, note: note });
  }

  /**
   * Which gimbal this rig drives, chosen from the bridges the Pi runs (one bridge instance per gimbal, each on its
   * own port; GET /api/gimbals, kept in data.gimbalScan). Choosing one points the rig at that bridge. A gimbal that
   * another rig of this profile drives is shown but cannot be chosen.
   */
  function gimbalChoiceControl(data, rig) {
    var scan = data && data.gimbalScan;
    var current = rig.gimbal.host + ':' + rig.gimbal.port;
    var options = [], patches = {};
    var found = scan && scan.gimbals ? scan.gimbals : [];
    // A rig saved with another of the Pi's addresses (Wi-Fi vs Ethernet) is on that same gimbal.
    found.forEach(function (g) { if ((g.aliases || []).indexOf(current) >= 0) current = g.host + ':' + g.port; });
    function describe(g) {
      var model = g.model || (g.host + ':' + g.port === current ? rig.gimbal.reportedModel || rig.gimbal.gimbalModel : null);
      var known = (g.usedBy || []).filter(function (u) { return u.deviceKey !== rig.deviceKey; }).map(function (u) { return u.label; });
      var primary = known.length ? known.join(' / ') : g.instance || model || 'Gimbal';
      var details = [];
      if (g.instance && g.instance !== primary) details.push(g.instance);
      if (model && model !== primary) details.push(model);
      // The Bluetooth address is what tells two gimbals of the same model apart.
      if (g.gimbalAddress) details.push('BT …' + String(g.gimbalAddress).slice(-5));
      var where = 'port ' + g.port + (found.some(function (o) { return o.host !== g.host; }) ? ' on ' + g.host : '');
      var link = !g.reachable ? 'bridge not reachable' : g.gimbalConnected === true ? 'gimbal connected' : g.gimbalConnected === false ? 'no gimbal attached' : 'no gimbal reporting';
      return primary + (details.length ? ' (' + details.join(' · ') + ')' : '') + ' — ' + where + ' — ' + link;
    }
    var sawCurrent = false;
    found.forEach(function (g) {
      var value = g.host + ':' + g.port;
      if (value === current) sawCurrent = true;
      var option = { value: value, label: describe(g) };
      var others = (g.usedBy || []).filter(function (u) { return u.rig !== null && u.deviceKey !== rig.deviceKey; });
      if (others.length && value !== current) { option.disabled = true; option.label += ' — on ' + others.map(function (u) { return u.label; }).join(', '); }
      options.push(option);
      var patch = { gimbal: { host: g.host, port: g.port } };
      if (g.model) patch.gimbal.gimbalModel = g.model;
      patches[value] = patch;
    });
    if (!sawCurrent) options.unshift({ value: current, label: (rig.gimbal.gimbalModel || 'Gimbal') + ' — port ' + rig.gimbal.port + ' on ' + rig.gimbal.host + (scan && !scan.pending ? ' — not found' : '') });
    var note;
    if (!scan || scan.pending) note = 'Looking for gimbals on the Pi…';
    else if (scan.error) note = 'Could not look for gimbals: ' + scan.error;
    else if (!found.some(function (g) { return g.reachable; })) note = 'No gimbal bridges answered. Check that the Pi is on and its bridges are running.';
    else if (!sawCurrent) note = 'This rig points at a bridge that did not answer. Choose a gimbal from the list.';
    else note = 'Choose which gimbal this rig drives';
    if (current !== rig.gimbal.host + ':' + rig.gimbal.port && sawCurrent) note += ' (saved as ' + rig.gimbal.host + ', the same Pi on another network)';
    return ctl('gimbal.bridge', 'Gimbal', 'select', current, null, { options: options, patches: patches, note: note, rescan: true });
  }

  /** The Sony camera choices for a rig: None, then every named Sony camera (taken ones shown but disabled). */
  function cameraOptions(data, rig) {
    var options = [{ value: '', label: 'None' }];
    ((data && data.sonyDevices) || []).forEach(function (device) {
      var elsewhere = (device.usedByRigs || []).filter(function (r) { return r.position !== rig.position; });
      var option = { value: device.key, label: device.label };
      if (elsewhere.length) { option.disabled = true; option.hint = 'on ' + elsewhere.map(function (r) { return r.label; }).join(', '); option.label = device.label + ' — on ' + elsewhere.map(function (r) { return r.label; }).join(', '); }
      else if (!device.sonyCameraId) option.hint = 'no camera bound yet';
      options.push(option);
    });
    return options;
  }

  var CONTROLLER_CHOICES = [
    { value: 'vbot', label: 'V-BOT' },
    { value: 'birddog', label: 'BirdDog (built-in camera)' },
    { value: 'gimbal', label: 'DJI gimbal' },
    { value: 'generic', label: 'Other VISCA-IP camera (e.g. Sony)' },
  ];

  /** The form for adding a rig. Connection fields depend on the controller type chosen. */
  function addRigInspector(data) {
    var rigs = (data && data.rigs) || [];
    var max = (data && data.maxRigs) || 8;
    var taken = {};
    rigs.forEach(function (rig) { if (rig.camera) taken[rig.camera] = true; });
    var cameras = [{ value: '', label: 'None' }];
    ((data && data.sonyDevices) || []).forEach(function (device) {
      var option = { value: device.key, label: device.label };
      if (taken[device.key]) { option.disabled = true; option.label = device.label + ' — already on a rig'; }
      cameras.push(option);
    });
    return {
      kind: 'new-rig',
      title: 'Add a rig',
      endpoint: '/api/rigs',
      full: rigs.length >= max,
      fullReason: 'A profile can have at most ' + max + ' rigs.',
      nextPosition: rigs.length + 1,
      controllers: CONTROLLER_CHOICES,
      existing: ((data && data.availableControllers) || []).map(function (c) { return { value: c.key, label: c.label + ' (' + (CONTROLLER[c.controller] || c.controller) + ')' }; }),
      connection: {
        visca: [
          ctl('host', 'Camera address (IP)', 'text', '', 'host', { required: true, maxLength: 253 }),
          ctl('port', 'Port', 'number', 52381, 'port', { min: 1, max: 65535, integer: true }),
          ctl('address', 'VISCA address', 'number', 1, 'address', { min: 0, max: 7, integer: true }),
        ],
        gimbal: [
          ctl('host', 'Bridge host', 'text', '', 'host', { required: true, maxLength: 253 }),
          ctl('port', 'Port', 'number', 7878, 'port', { min: 1, max: 65535, integer: true }),
        ],
      },
      cameraOptions: cameras,
      fields: [], advanced: [], notes: ['The new rig is added at the end (position ' + (rigs.length + 1) + '), so no existing rig changes position.'],
    };
  }

  function whole(value, name, min, max) {
    var n = Number(value);
    if (value === '' || !isFinite(n) || Math.floor(n) !== n || n < min || n > max) throw new Error(name + ' must be a whole number from ' + min + ' to ' + max);
    return n;
  }

  /**
   * Turn the add-rig form's values into the POST /api/rigs body, or say what is wrong. `mode` is 'new' (new
   * hardware) or 'existing' (put a controller that is already in the inventory on a new rig).
   */
  function buildNewRigPayload(values) {
    try {
      var payload = {};
      if (values.mode === 'existing') {
        if (!values.deviceKey) throw new Error('Choose a controller');
        payload.deviceKey = values.deviceKey;
      } else {
        var label = String(values.label || '').trim();
        if (!label) throw new Error('Give the rig a name');
        if (label.length > 64) throw new Error('The name can be at most 64 characters');
        if (['vbot', 'birddog', 'gimbal', 'generic'].indexOf(values.controller) < 0) throw new Error('Choose a controller type');
        var host = String(values.host || '').trim();
        if (!host) throw new Error(values.controller === 'gimbal' ? 'Enter the bridge host' : 'Enter the camera address (IP)');
        payload.label = label;
        payload.controller = values.controller;
        if (values.controller === 'gimbal') {
          payload.gimbal = { host: host, port: whole(values.port === undefined ? 7878 : values.port, 'Port', 1, 65535) };
          var model = String(values.gimbalModel || '').trim();
          if (model) payload.gimbal.gimbalModel = model;
        } else {
          payload.visca = { host: host, port: whole(values.port === undefined ? 52381 : values.port, 'Port', 1, 65535), address: whole(values.address === undefined ? 1 : values.address, 'VISCA address', 0, 7) };
        }
      }
      if (values.inputId !== undefined && values.inputId !== '' && values.inputId !== null) payload.inputId = whole(values.inputId, 'ATEM input', 1, 99);
      var builtIn = values.mode === 'existing' ? false : values.controller === 'birddog';
      if (values.camera && !builtIn) payload.camera = values.camera;
      return { ok: true, payload: payload };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  /** The sentences shown when asking the operator to confirm removing a rig. */
  function impactLines(impact) {
    var lines = ['Remove "' + impact.label + '" (rig ' + impact.position + ', ' + impact.id + ') from the active profile.'];
    if (impact.presetsLost && impact.presetsLost.length) lines.push('Its saved presets (' + impact.presetsLost.join(', ') + ') will be deleted.');
    (impact.shifted || []).forEach(function (rig) {
      var hotkey = rig.fromHotkey || rig.toHotkey ? ' (' + (rig.fromHotkey || 'no hotkey') + ' becomes ' + (rig.toHotkey || 'no hotkey') + ')' : '';
      lines.push('"' + rig.label + '" moves from ' + rig.fromId + ' to ' + rig.toId + hotkey + (rig.presetsMoved && rig.presetsMoved.length ? '; its presets move with it' : '') + '.');
    });
    if (impact.usedInOtherProfiles && impact.usedInOtherProfiles.length) lines.push('This hardware is also used in: ' + impact.usedInOtherProfiles.join(', ') + '. It stays available there.');
    if ((impact.shifted || []).length) lines.push('The moved rigs reconnect briefly.');
    return lines;
  }

  // ---- profiles and unsaved changes
  function none(value, word) { return value === null || value === undefined ? word : String(value); }

  /** Plain sentences for what the working copy changes compared to the saved profile. */
  function changeLines(changes) {
    return (changes || []).map(function (c) {
      if (c.kind === 'added') return 'Added ' + c.label + ' as rig ' + c.position + '.';
      if (c.kind === 'removed') return 'Removed ' + c.label + ' (was rig ' + c.position + ').';
      if (c.kind === 'moved') return c.label + ' moved from rig ' + c.from + ' to rig ' + c.to + '.';
      if (c.kind === 'input') return c.label + ': ATEM input ' + none(c.from, 'none (control only)') + ' → ' + none(c.to, 'none (control only)') + '.';
      if (c.kind === 'camera') return c.label + ': Sony camera ' + none(c.from, 'none') + ' → ' + none(c.to, 'none') + '.';
      return '';
    }).filter(Boolean);
  }

  /** A default name for Save as that no profile already has. */
  function saveAsSuggestion(data) {
    var profiles = (data && data.profiles) || [];
    var active = profiles.filter(function (p) { return p.active; })[0];
    var base = (active && (active.label || active.name)) || 'Profile';
    var taken = {};
    profiles.forEach(function (p) { taken[String(p.label || p.name).toLowerCase()] = true; });
    var candidate = base + ' (edited)';
    for (var n = 2; taken[candidate.toLowerCase()]; n++) candidate = base + ' (edited ' + n + ')';
    return candidate;
  }

  /** What the profile bar shows: the choices, whether there are unsaved changes, and what they are. */
  function profileInfo(data) {
    var profiles = (data && data.profiles) || [];
    var active = profiles.filter(function (p) { return p.active; })[0] || null;
    var profile = (data && data.profile) || {};
    return {
      options: profiles.map(function (p) { return { value: p.name, label: p.label || p.name }; }),
      active: active ? active.name : null,
      activeLabel: active ? (active.label || active.name) : null,
      modified: !!profile.modified,
      changeLines: changeLines(profile.changes),
      notice: profile.notice || null,
      legacy: !!(data && data.legacy),
      canDelete: profiles.length > 1,
      saveAsSuggestion: saveAsSuggestion(data),
    };
  }

  /** What switching to another profile would change, for the confirmation: per position, plus an ATEM-program warning. */
  function switchImpact(data, targetName) {
    var target = ((data && data.profiles) || []).filter(function (p) { return p.name === targetName; })[0];
    if (!target) return null;
    var current = (data && data.rigs) || [];
    var programInput = data && data.programInput !== undefined ? data.programInput : null;
    var changed = [];
    var length = Math.max(current.length, target.rigs.length);
    for (var i = 0; i < length; i++) {
      var from = current[i] ? { deviceKey: current[i].deviceKey, label: current[i].label, inputId: current[i].wired ? current[i].inputId : null } : null;
      var to = target.rigs[i] || null;
      var kind = null;
      if (from && !to) kind = 'removed';
      else if (!from && to) kind = 'added';
      else if (from.deviceKey !== to.deviceKey) kind = 'device';
      else if (from.inputId !== to.inputId) kind = 'input';
      if (kind) changed.push({ position: i + 1, kind: kind, from: from, to: to, hotkey: i < 4 && current[i] ? current[i].hotkey : (i < 4 && data && data.rigs && data.rigs[i] ? data.rigs[i].hotkey : null) });
    }
    var programWarning = null;
    if (programInput !== null && programInput !== undefined) {
      var onAir = current.filter(function (r) { return r.wired && r.inputId === programInput; })[0];
      if (onAir && changed.some(function (c) { return c.position === onAir.position; })) {
        programWarning = 'The ATEM program output is on ' + onAir.label + ' (input ' + programInput + '), which will change.';
      }
    }
    var lines = changed.map(function (c) {
      var where = 'Rig ' + c.position + (c.hotkey ? ' (' + c.hotkey + ')' : '');
      if (c.kind === 'removed') return where + ': ' + c.from.label + ' → (no rig)';
      if (c.kind === 'added') return where + ': (no rig) → ' + c.to.label;
      if (c.kind === 'input') return where + ': ' + c.from.label + ' — ATEM input ' + none(c.from.inputId, 'none') + ' → ' + none(c.to.inputId, 'none');
      return where + ': ' + c.from.label + ' → ' + c.to.label;
    });
    return { changed: changed, lines: lines, programWarning: programWarning, name: target.label || target.name };
  }

  function atemInspector(data) {
    var atem = (data && data.atem) || {};
    var g = (data && data.graphics) || {};
    return {
      kind: 'atem',
      title: 'ATEM switcher',
      fields: [
        field('IP address', atem.ip || 'Not set'),
        field('Default transition', atem.defaultTransition === 'auto' ? 'Auto' : 'Cut'),
        field('Mix/effect index', String(atem.meIndex)),
      ],
      advanced: [
        field('Graphics keyer', String(g.type || 'dsk').toUpperCase()),
        field('DSK index', String(g.dskIndex)),
        field('USK index', String(g.uskIndex)),
        field('Graphics mix/effect', String(g.meIndex)),
        field('Key fade (frames)', String(g.fadeFrames)),
      ],
      notes: [],
      endpoint: '/api/atem',
      controls: [
        ctl('ip', 'IP address', 'text', atem.ip || '', 'ip', { required: true, maxLength: 253, note: 'Changing it reconnects the switcher' }),
        ctl('defaultTransition', 'Default transition', 'select', atem.defaultTransition === 'auto' ? 'auto' : 'cut', 'defaultTransition', { options: [{ value: 'cut', label: 'Cut' }, { value: 'auto', label: 'Auto' }] }),
        ctl('meIndex', 'Mix/effect index', 'number', atem.meIndex, 'meIndex', { min: 0, max: 3, integer: true }),
      ],
      advancedControls: [
        ctl('graphics.type', 'Graphics keyer', 'select', g.type || 'dsk', 'graphics.type', { options: [{ value: 'dsk', label: 'DSK' }, { value: 'usk', label: 'USK' }, { value: 'auto', label: 'Auto' }] }),
        ctl('graphics.dskIndex', 'DSK index', 'number', g.dskIndex, 'graphics.dskIndex', { min: 0, max: 3, integer: true }),
        ctl('graphics.uskIndex', 'USK index', 'number', g.uskIndex, 'graphics.uskIndex', { min: 0, max: 3, integer: true }),
        ctl('graphics.meIndex', 'Graphics mix/effect', 'number', g.meIndex, 'graphics.meIndex', { min: 0, max: 3, integer: true }),
        ctl('graphics.fadeFrames', 'Key fade (frames)', 'number', g.fadeFrames, 'graphics.fadeFrames', { min: 0, max: 250, integer: true }),
      ],
    };
  }

  /**
   * Everything about the Sony cameras in one place: the service, the named cameras (devices), and cameras
   * found that no device is bound to yet. Connecting, reconnecting and naming happen here.
   */
  function sonyConnectionsInspector(data) {
    var sidecar = data && data.sony ? data.sony.sidecar : null;
    var service = serviceState(sidecar);
    var devices = ((data && data.sonyDevices) || []).map(function (device) {
      var status = cameraStatus(data, device.sonyCameraId);
      return {
        key: device.key,
        label: device.label,
        sonyCameraId: device.sonyCameraId,
        model: device.model,
        state: device.state,
        stateText: device.sonyCameraId ? sonyStateText(device.state) : 'No camera bound yet',
        tone: device.sonyCameraId ? sonyTone(device.state) : 'idle',
        message: status && status.message ? status.message : null,
        approved: !!(status && status.approved),
        usedBy: (device.usedByRigs || []).map(function (r) { return r.label + ' (rig ' + r.position + ')'; }),
        // What the operator can do with this camera right now.
        canConnect: !!(device.sonyCameraId && device.state === 'discovered_unapproved'),
        // A first connect that failed leaves the camera unapproved; it must still be retryable.
        canRetry: !!(device.sonyCameraId && RETRYABLE[device.state]),
        canForget: !!(status && status.approved),
        canBind: !device.sonyCameraId,
        canDelete: !(device.usedByRigs && device.usedByRigs.length),
        deleteBlockedBy: (device.usedInProfiles || []),
      };
    });
    var found = ((data && data.unboundCameras) || []).map(function (camera) {
      return {
        id: camera.id, model: camera.model || 'Sony camera', state: camera.state, stateText: sonyStateText(camera.state), tone: sonyTone(camera.state),
        message: camera.message || null,
        canConnect: camera.state === 'discovered_unapproved',
        canRetry: !!RETRYABLE[camera.state],
        suggestedName: camera.model || 'Sony camera',
      };
    });
    return {
      kind: 'sony-connections',
      title: 'Sony connections',
      service: { state: service.state, text: service.text, tone: service.tone, message: sidecar && sidecar.message ? sidecar.message : null, mode: sidecar ? sidecar.mode : null, canRetry: !!sidecar && (service.state === 'absent' || service.state === 'crashed') },
      canRefresh: !!sidecar && service.state === 'healthy',
      devices: devices,
      found: found,
      fields: [],
      advanced: [],
      notes: [],
    };
  }

  /** Why there is no live preview for a rig (null when there is one). */
  function previewReason(rig, camera) {
    if (rig.builtInCamera) return 'No preview: a BirdDog\'s built-in camera has no preview feed here.';
    if (!rig.camera) return 'No preview: no Sony camera is assigned to this rig.';
    if (!camera || !camera.sonyCameraId) return 'No preview: this camera is not bound to a physical camera yet.';
    var why = {
      discovered_unapproved: 'has been found but is not connected yet (connect it in Sony connections)',
      connecting: 'is connecting',
      disconnected: 'is disconnected',
      needs_pairing: 'needs pairing on the camera',
      error: 'has a connection error',
    };
    if (camera.state !== 'connected') return 'No preview: the Sony camera ' + (why[camera.state] || 'has not been seen yet') + '.';
    return null;
  }

  /** A VISCA camera: UDP has no link to lose, so report whether it answered the last health check. */
  function viscaLine(live) {
    if (live.connected === false) return { label: 'Camera control', value: 'No VISCA link', tone: 'bad' };
    var ago = live.lastReplyAt ? ' (last reply ' + Math.max(0, Math.round((Date.now() - live.lastReplyAt) / 1000)) + ' s ago)' : '';
    if (live.answering === true) return { label: 'Camera control', value: 'Answering' + ago, tone: 'ok' };
    if (live.answering === false) {
      if (live.repliesHeard === false) return { label: 'Camera control', value: 'Replies not heard: port 52381 is in use by another app on this Mac', tone: 'warn' };
      return { label: 'Camera control', value: 'Not answering — check its power and network' + ago, tone: 'bad' };
    }
    return { label: 'Camera control', value: 'Checking…', tone: 'idle' };
  }

  /** An asleep (or not-moving) gimbal whose bridge can wake it (bridge 0.5.0+). */
  function gimbalWakeable(rig) {
    var live = rig.live || {};
    return !!rig.gimbal && live.canWake === true && live.connected !== false && live.gimbalAttached === true && (live.asleep === true || live.gimbalResponding === false);
  }

  /** Asked before a wake is sent: motors re-engaging on an unbalanced gimbal can jerk the camera. */
  function wakeQuestion(label) {
    return 'Wake ' + label + '? Its motors switch back on and it holds its position; if it is unbalanced it can jerk the camera. Make sure nobody is touching it.';
  }

  /** The right column: live state of the selected item. */
  function statusFor(data, key) {
    if (!key) return null;
    if (key.indexOf('rig:') === 0) {
      var rig = findRig(data, key);
      if (!rig) return null;
      var lines = [];
      if (rig.gimbal) lines.push({ label: 'Gimbal link', value: connectedText(rig.live && rig.live.connected), tone: connectedTone(rig.live && rig.live.connected) });
      else lines.push(viscaLine(rig.live || {}));
      if (rig.live && 'bridgeReachable' in rig.live) lines.push({ label: 'Bridge (Pi)', value: rig.live.bridgeReachable ? 'Reachable' : 'Not reachable', tone: rig.live.bridgeReachable ? 'ok' : 'bad' });
      if (rig.live && 'gimbalAttached' in rig.live) {
        var notMoving = rig.live.gimbalResponding === false;
        var reportsAsleep = rig.live.gimbalAttached && rig.live.asleep === true;
        lines.push({ label: 'Gimbal', value: reportsAsleep ? 'Asleep (the gimbal reports it)' : notMoving ? 'Linked but not moving — asleep, unbalanced or motors off?' : rig.live.gimbalAttached ? 'Attached' : 'Not attached', tone: reportsAsleep || notMoving ? 'warn' : rig.live.gimbalAttached ? 'ok' : 'bad' });
      }
      if (rig.live && rig.live.signal) {
        var sig = rig.live.signal;
        lines.push({ label: 'Bluetooth signal', value: sig.rating === 'good' ? 'Good' : (sig.rating === 'poor' ? 'Poor' : 'Weak') + ' — ' + sig.summary, tone: sig.rating === 'good' ? 'ok' : sig.rating === 'poor' ? 'bad' : 'warn' });
      }
      lines.push({ label: 'Video to ATEM', value: rig.wired ? 'Input ' + rig.inputId : 'Not wired (control only)', tone: rig.wired ? 'ok' : 'warn' });
      var camera = rig.camera ? sonyDevice(data, rig.camera) : null;
      if (rig.builtInCamera) lines.push({ label: 'Camera', value: 'Built in', tone: 'idle' });
      else if (!rig.camera) lines.push({ label: 'Sony camera', value: 'None assigned', tone: 'warn' });
      else lines.push({ label: 'Sony camera', value: (rig.cameraLabel || rig.camera) + ' — ' + sonyStateText(camera && camera.state), tone: sonyTone(camera && camera.state) });
      var cameraInfo = camera ? cameraStatus(data, camera.sonyCameraId) : null;
      if (cameraInfo && cameraInfo.message) lines.push({ label: 'Last message', value: cameraInfo.message, tone: camera.state === 'error' ? 'bad' : 'idle' });
      var actions = [{ id: 'reconnect-controller', label: rig.gimbal ? 'Reconnect gimbal' : 'Reconnect camera control', method: 'POST', url: '/api/reconnect/camera/' + encodeURIComponent(rig.id), progress: 'Reconnecting…', done: 'Reconnect requested' }];
      if (gimbalWakeable(rig)) actions.push({ id: 'wake-gimbal', label: 'Wake gimbal', method: 'POST', url: '/api/cameras/' + encodeURIComponent(rig.id) + '/wake', body: { confirm: true }, progress: 'Waking…', done: 'Wake sent — waiting for it to report awake', confirm: wakeQuestion(rig.label || rig.id) });
      if (camera && camera.sonyCameraId && camera.state === 'discovered_unapproved') actions.push({ id: 'connect-sony', label: 'Connect Sony camera', method: 'POST', url: '/api/sony/cameras/' + encodeURIComponent(camera.sonyCameraId) + '/connect', progress: 'Connecting…', done: 'Connected' });
      if (camera && camera.sonyCameraId && RETRYABLE[camera.state]) actions.push({ id: 'retry-sony', label: 'Retry Sony camera', method: 'POST', url: '/api/sony/cameras/' + encodeURIComponent(camera.sonyCameraId) + '/retry', progress: 'Retrying…', done: 'Retry requested' });
      return { headline: rigTitle(rig), lines: lines, actions: actions, previewCameraId: camera && camera.state === 'connected' ? camera.sonyCameraId : null, noPreviewReason: previewReason(rig, camera) };
    }
    if (key === 'atem') {
      return { headline: 'ATEM switcher', lines: [{ label: 'Connection', value: connectedText(data ? data.atemConnected : null), tone: connectedTone(data ? data.atemConnected : null) }], actions: [{ id: 'reconnect-atem', label: 'Reconnect ATEM', method: 'POST', url: '/api/reconnect/atem', progress: 'Reconnecting…', done: 'Reconnect requested' }], previewCameraId: null };
    }
    if (key === 'sony') {
      var overview = sonyOverview(data);
      var rows = [{ label: 'Sony service', value: overview.service.text, tone: overview.service.tone }];
      var sidecarInfo = data && data.sony ? data.sony.sidecar : null;
      if (sidecarInfo && sidecarInfo.message) rows.push({ label: 'Service message', value: sidecarInfo.message, tone: 'warn' });
      rows.push({ label: 'Cameras connected', value: overview.connected + ' of ' + overview.total, tone: overview.total && overview.connected === overview.total ? 'ok' : overview.total ? 'warn' : 'idle' });
      ((data && data.sonyDevices) || []).forEach(function (device) {
        rows.push({ label: device.label, value: device.sonyCameraId ? sonyStateText(device.state) : 'No camera bound yet', tone: device.sonyCameraId ? sonyTone(device.state) : 'idle' });
      });
      ((data && data.unboundCameras) || []).forEach(function (camera) {
        rows.push({ label: (camera.model || 'Sony camera') + ' (new)', value: sonyStateText(camera.state), tone: sonyTone(camera.state) });
      });
      var sonyActions = [];
      if (overview.service.state === 'stopped') sonyActions.push({ id: 'start-service', label: 'Start Sony service', method: 'POST', url: '/api/sony/service/start', progress: 'Starting…', done: 'Start requested; cameras reconnect by themselves' });
      else if (overview.service.state === 'absent' || overview.service.state === 'crashed') sonyActions.push({ id: 'retry-service', label: 'Retry Sony service', method: 'POST', url: '/api/sony/service/retry', progress: 'Retrying…', done: 'Retry requested' });
      if (overview.service.state === 'healthy') sonyActions.push({ id: 'refresh', label: 'Refresh cameras', method: 'POST', url: '/api/sony/cameras/discover', progress: 'Scanning…', done: 'Scan finished' });
      if (overview.service.state === 'healthy' || overview.service.state === 'starting') sonyActions.push({ id: 'stop-service', label: 'Stop Sony service', method: 'POST', url: '/api/sony/service/stop', progress: 'Stopping…', done: 'Sony service stopped; all Sony cameras disconnected', confirm: 'Stop the Sony service? Every Sony camera is disconnected (cleanly) until you press Start Sony service. Video through the ATEM and gimbal/VISCA control are not affected.' });
      return { headline: 'Sony connections', lines: rows, actions: sonyActions, previewCameraId: null };
    }
    return null;
  }

  return {
    itemsOf: itemsOf, flatItems: flatItems, findItem: findItem, resolveSelection: resolveSelection,
    inspectorFor: inspectorFor, statusFor: statusFor, sonyStateText: sonyStateText,
    buildNewRigPayload: buildNewRigPayload, impactLines: impactLines,
    profileInfo: profileInfo, changeLines: changeLines, switchImpact: switchImpact, saveAsSuggestion: saveAsSuggestion,
  };
});
