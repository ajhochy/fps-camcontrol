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

  var CONTROLLER = { vbot: 'V-BOT', birddog: 'BirdDog', gimbal: 'DJI gimbal', generic: 'VISCA camera' };
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

  var SERVICE_TEXT = { healthy: 'Running', absent: 'Not running', starting: 'Starting', crashed: 'Stopped after repeated failures', disabled: 'Turned off' };
  var SERVICE_TONE = { healthy: 'ok', absent: 'bad', starting: 'warn', crashed: 'bad', disabled: 'idle' };
  function serviceState(sidecar) {
    var state = sidecar && sidecar.state;
    return { state: state || 'disabled', text: SERVICE_TEXT[state] || (state ? String(state) : 'Not configured'), tone: SERVICE_TONE[state] || 'idle' };
  }

  /** The left column: sections of selectable items, in display order. */
  function itemsOf(data) {
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

  function flatItems(data) {
    return itemsOf(data).reduce(function (all, section) { return all.concat(section.items); }, []);
  }
  function findItem(data, key) { return flatItems(data).filter(function (item) { return item.key === key; })[0] || null; }

  /** Keep the selection if it still exists; otherwise the first rig, else the first item, else nothing. */
  function resolveSelection(data, key) {
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
      readonly('controller', 'Controller', CONTROLLER[rig.controller] || rig.controller, rig.controller === 'birddog' ? 'Has a built-in camera' : null)];
    if (rig.visca) {
      controls.push(ctl('visca.host', 'Camera address (IP)', 'text', rig.visca.host || '', 'visca.host', { required: true, maxLength: 253 }));
      controls.push(ctl('visca.port', 'Port', 'number', rig.visca.port, 'visca.port', { min: 1, max: 65535, integer: true }));
      controls.push(ctl('visca.address', 'VISCA address', 'number', rig.visca.address, 'visca.address', { min: 0, max: 7, integer: true }));
    }
    if (rig.gimbal) {
      controls.push(ctl('gimbal.host', 'Bridge host', 'text', rig.gimbal.host, 'gimbal.host', { required: true, maxLength: 253 }));
      controls.push(ctl('gimbal.port', 'Port', 'number', rig.gimbal.port, 'gimbal.port', { min: 1, max: 65535, integer: true }));
      controls.push(ctl('gimbal.gimbalModel', 'Gimbal model', 'text', rig.gimbal.gimbalModel || '', 'gimbal.gimbalModel', { nullable: true, maxLength: 32 }));
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
    };
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

  /** The right column: live state of the selected item. */
  function statusFor(data, key) {
    if (!key) return null;
    if (key.indexOf('rig:') === 0) {
      var rig = findRig(data, key);
      if (!rig) return null;
      var lines = [{ label: rig.gimbal ? 'Gimbal link' : 'Camera control', value: connectedText(rig.live && rig.live.connected), tone: connectedTone(rig.live && rig.live.connected) }];
      if (rig.live && 'bridgeReachable' in rig.live) lines.push({ label: 'Bridge (Pi)', value: rig.live.bridgeReachable ? 'Reachable' : 'Not reachable', tone: rig.live.bridgeReachable ? 'ok' : 'bad' });
      if (rig.live && 'gimbalAttached' in rig.live) lines.push({ label: 'Gimbal', value: rig.live.gimbalAttached ? 'Attached' : 'Not attached', tone: rig.live.gimbalAttached ? 'ok' : 'bad' });
      lines.push({ label: 'Video to ATEM', value: rig.wired ? 'Input ' + rig.inputId : 'Not wired (control only)', tone: rig.wired ? 'ok' : 'warn' });
      var camera = rig.camera ? sonyDevice(data, rig.camera) : null;
      if (rig.builtInCamera) lines.push({ label: 'Camera', value: 'Built in', tone: 'idle' });
      else if (!rig.camera) lines.push({ label: 'Sony camera', value: 'None assigned', tone: 'warn' });
      else lines.push({ label: 'Sony camera', value: (rig.cameraLabel || rig.camera) + ' — ' + sonyStateText(camera && camera.state), tone: sonyTone(camera && camera.state) });
      var cameraInfo = camera ? cameraStatus(data, camera.sonyCameraId) : null;
      if (cameraInfo && cameraInfo.message) lines.push({ label: 'Last message', value: cameraInfo.message, tone: camera.state === 'error' ? 'bad' : 'idle' });
      var actions = [{ id: 'reconnect-controller', label: rig.gimbal ? 'Reconnect gimbal' : 'Reconnect camera control', method: 'POST', url: '/api/reconnect/camera/' + encodeURIComponent(rig.id), progress: 'Reconnecting…', done: 'Reconnect requested' }];
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
      if (overview.service.state === 'absent' || overview.service.state === 'crashed') sonyActions.push({ id: 'retry-service', label: 'Retry Sony service', method: 'POST', url: '/api/sony/service/retry', progress: 'Retrying…', done: 'Retry requested' });
      if (overview.service.state === 'healthy') sonyActions.push({ id: 'refresh', label: 'Refresh cameras', method: 'POST', url: '/api/sony/cameras/discover', progress: 'Scanning…', done: 'Scan finished' });
      return { headline: 'Sony connections', lines: rows, actions: sonyActions, previewCameraId: null };
    }
    return null;
  }

  return {
    itemsOf: itemsOf, flatItems: flatItems, findItem: findItem, resolveSelection: resolveSelection,
    inspectorFor: inspectorFor, statusFor: statusFor, sonyStateText: sonyStateText,
  };
});
