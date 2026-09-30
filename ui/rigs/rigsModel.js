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
    return { kind: 'rig', title: rigTitle(rig), fields: fields, advanced: advanced, notes: notes };
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
      };
    });
    var found = ((data && data.unboundCameras) || []).map(function (camera) {
      return { id: camera.id, model: camera.model || 'Sony camera', state: camera.state, stateText: sonyStateText(camera.state), tone: sonyTone(camera.state), message: camera.message || null };
    });
    return {
      kind: 'sony-connections',
      title: 'Sony connections',
      service: { state: service.state, text: service.text, tone: service.tone, message: sidecar && sidecar.message ? sidecar.message : null, mode: sidecar ? sidecar.mode : null },
      devices: devices,
      found: found,
      fields: [],
      advanced: [],
      notes: [],
    };
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
      return { headline: rigTitle(rig), lines: lines, previewCameraId: camera && camera.state === 'connected' ? camera.sonyCameraId : null };
    }
    if (key === 'atem') {
      return { headline: 'ATEM switcher', lines: [{ label: 'Connection', value: connectedText(data ? data.atemConnected : null), tone: connectedTone(data ? data.atemConnected : null) }], previewCameraId: null };
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
      return { headline: 'Sony connections', lines: rows, previewCameraId: null };
    }
    return null;
  }

  return {
    itemsOf: itemsOf, flatItems: flatItems, findItem: findItem, resolveSelection: resolveSelection,
    inspectorFor: inspectorFor, statusFor: statusFor, sonyStateText: sonyStateText,
  };
});
