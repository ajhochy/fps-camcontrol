/*
 * iPad remote: the pure part. Turns a browser Gamepad into the frame the server expects, and server state into
 * the words and badges the page shows. No DOM here, so it is tested in Node (src/testing/remoteUiModelTest.ts)
 * and reused by remote.js in the browser. The server side of the same mapping is src/input/browserGamepad.ts.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RemoteModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Sticks drifting a little must not keep the camera creeping, nor count as "the desk is busy".
  var STICK_DEADZONE = 0.12;
  var STICK_FLOOR = 0.02;
  // Standard-mapping buttons sent in the mask. 6/7 are the triggers (sent as analog values); 16 is Guide/Home,
  // which iPadOS owns, so it is never read.
  var MASK_BITS = [0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15];
  var START_BIT = 9;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }

  /** Radial deadzone for one stick: inside the circle it is dead, outside it is rescaled so full push is still 1. */
  function stick(x, y) {
    x = clamp(num(x), -1, 1); y = clamp(num(y), -1, 1);
    var mag = Math.sqrt(x * x + y * y);
    if (mag < STICK_DEADZONE) return [0, 0];
    var scale = Math.min(1, (mag - STICK_DEADZONE) / (1 - STICK_DEADZONE)) / mag;
    var ox = x * scale, oy = y * scale;
    return [Math.abs(ox) < STICK_FLOOR ? 0 : ox, Math.abs(oy) < STICK_FLOOR ? 0 : oy];
  }

  /** A standard-mapping gamepad (or anything shaped like one) -> { a:[4], tr:[2], b } without the sequence number. */
  function frameFromPad(pad) {
    var axes = pad && pad.axes ? pad.axes : [];
    var buttons = pad && pad.buttons ? pad.buttons : [];
    var l = stick(axes[0], axes[1]);
    var r = stick(axes[2], axes[3]);
    var b = 0;
    for (var i = 0; i < MASK_BITS.length; i++) {
      var btn = buttons[MASK_BITS[i]];
      if (btn && btn.pressed) b |= (1 << MASK_BITS[i]);
    }
    var lt = buttons[6] ? clamp(num(buttons[6].value), 0, 1) : 0;
    var rt = buttons[7] ? clamp(num(buttons[7].value), 0, 1) : 0;
    return { a: [l[0], l[1], r[0], r[1]], tr: [lt, rt], b: b };
  }

  function neutralFrame() { return { a: [0, 0, 0, 0], tr: [0, 0], b: 0 }; }

  function startHeld(frame) { return (frame.b & (1 << START_BIT)) !== 0; }

  /** The first connected pad, with what the page should say about it. */
  function padStatus(pads) {
    var list = pads || [];
    var first = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].connected) { first = list[i]; break; }
    }
    if (!first) return { kind: 'none', text: 'Press any button on the controller', pad: null };
    if (first.mapping !== 'standard') {
      return { kind: 'unsupported', text: "Controller not recognised (mapping: '" + (first.mapping || '') + "')", pad: first };
    }
    return { kind: 'ok', text: shortName(first.id) + ' · standard', pad: first };
  }

  function shortName(id) {
    var s = String(id || 'Controller').replace(/\s*\((?:STANDARD GAMEPAD\s*)?Vendor:.*\)\s*$/i, '').trim();
    return s.length > 28 ? s.slice(0, 27) + '…' : s;
  }

  var DENIED = {
    disabled: 'Remote control is switched off. Turn it on from the desk page.',
    'desk-active': 'The desk controller is in use. Try again when it is quiet.',
    'other-remote': 'Another iPad has control.',
    pin: 'Wrong PIN.',
  };
  function deniedText(reason) { return DENIED[reason] || 'Control was refused.'; }

  /** { cls, text } for the owner pill. `owner` is the latest owner message (or null before one). */
  function ownerPill(owner, connected, enabled) {
    if (!connected) return { cls: 'pill-wait', text: 'Not connected' };
    if (enabled === false) return { cls: 'pill-off', text: 'Remote control is off' };
    if (!owner) return { cls: 'pill-wait', text: 'Waiting' };
    if (owner.owner === 'remote' && owner.you) return { cls: 'pill-you', text: 'You have control' };
    if (owner.owner === 'remote') return { cls: 'pill-other', text: 'Another iPad has control' };
    return { cls: 'pill-desk', text: 'Desk has control' };
  }

  var LOST = {
    'desk-override': 'The desk took control',
    'taken-back': 'The desk took control back',
    timeout: 'Control timed out (no input reached the server)',
    disabled: 'Remote control was switched off',
    stop: 'STOP pressed',
    idle: null,
    release: null,
  };
  function lostText(reason) { return Object.prototype.hasOwnProperty.call(LOST, reason) ? LOST[reason] : null; }

  /** One row per camera for the side list: badges and the health line. */
  function camerasView(cameras, status) {
    var st = status || {};
    var rigs = (st.health && st.health.rigs) || {};
    return (cameras || []).map(function (c) {
      var h = rigs[c.id] || null;
      return {
        id: c.id,
        label: c.label,
        controlled: st.controlledCamera === c.id,
        program: st.programCamera === c.id,
        preview: st.previewCamera === c.id,
        healthLevel: h ? h.level : '',
        healthText: h ? h.text : '',
      };
    });
  }

  /** The Sony camera id on the controlled rig (for the live preview), or null when the rig has none. */
  function previewCameraId(rigsPayload, controlledId) {
    if (!rigsPayload || !rigsPayload.rigs) return null;
    var rig = null;
    for (var i = 0; i < rigsPayload.rigs.length; i++) if (rigsPayload.rigs[i].id === controlledId) rig = rigsPayload.rigs[i];
    if (!rig || !rig.camera) return null;
    var devices = rigsPayload.sonyDevices || [];
    for (var j = 0; j < devices.length; j++) if (devices[j].key === rig.camera) return devices[j].sonyCameraId || null;
    return null;
  }

  // ---- multiview: which camera is in which pane, the tags and health on each, one frame loop per Sony camera

  var PROPERTY_NAMES = ['aperture', 'shutter-speed', 'iso', 'white-balance', 'focus-mode', 'focus-area'];
  var PROPERTY_LABELS = { 'aperture': 'Aperture', 'shutter-speed': 'Shutter', 'iso': 'ISO', 'white-balance': 'White balance', 'focus-mode': 'Focus mode', 'focus-area': 'Focus area' };

  /** 'wide' (iPad landscape, phone on its side): PVW and PGM side by side; 'tall' (phone upright): stacked. */
  function layoutFor(width, height) { return width >= 700 && width > height * 1.1 ? 'wide' : 'tall'; }

  function tagsFor(id, status) {
    var st = status || {}, tags = [];
    if (id && st.programCamera === id) tags.push('PGM');
    if (id && st.previewCamera === id) tags.push('PVW');
    if (id && st.controlledCamera === id) tags.push('CTL');
    return tags;
  }

  /**
   * What one pane shows. `rigId` is the rig (cam1..) in the pane, null for an empty pane. Health: the Sony camera's
   * verdict wins when it is not ready (it says why there is no picture), else the rig's own verdict. A Sony camera
   * the health tracker calls "down" gets no frame loop: its text is shown instead of a picture.
   */
  function paneView(key, rigId, cameras, status, rigsPayload) {
    var st = status || {}, health = st.health || {};
    var cam = null;
    for (var i = 0; i < (cameras || []).length; i++) if (cameras[i].id === rigId) cam = cameras[i];
    if (!rigId || !cam) return { key: key, rigId: null, label: '', tags: [], sonyId: null, wantsPicture: false, healthLevel: '', healthText: rigId ? 'Unknown camera' : '' };
    var rigH = (health.rigs && health.rigs[rigId]) || null;
    var camH = (health.cameras && health.cameras[rigId]) || null;
    var sonyId = previewCameraId(rigsPayload, rigId);
    var shown = camH && camH.level !== 'ready' ? camH : (rigH || camH);
    var text = shown ? shown.text : '';
    if (!sonyId && (!text || (rigH && rigH.level === 'ready'))) text = 'No camera on this rig';
    return {
      key: key, rigId: rigId, label: cam.label, tags: tagsFor(rigId, st), sonyId: sonyId,
      wantsPicture: !!sonyId && !(camH && camH.level === 'down'),
      healthLevel: shown ? shown.level : '', healthText: text,
    };
  }

  /** { pvw, pgm, small:[one per rig in rig order] }. PVW = ATEM preview camera, PGM = program camera. */
  function multiviewPlan(cameras, status, rigsPayload) {
    var st = status || {};
    var small = (cameras || []).slice(0, 4).map(function (c) { return paneView(c.id, c.id, cameras, st, rigsPayload); });
    return {
      pvw: paneView('pvw', st.previewCamera || null, cameras, st, rigsPayload),
      pgm: paneView('pgm', st.programCamera || null, cameras, st, rigsPayload),
      small: small,
    };
  }

  /** The Sony cameras to fetch frames for: each once, however many panes show it. { ids:[...], users:{id:[paneKeys]} }. */
  function framePlan(plan) {
    var panes = [plan.pvw, plan.pgm].concat(plan.small || []);
    var ids = [], users = {};
    panes.forEach(function (p) {
      if (!p || !p.wantsPicture || !p.sonyId) return;
      if (!users[p.sonyId]) { users[p.sonyId] = []; ids.push(p.sonyId); }
      users[p.sonyId].push(p.key);
    });
    return { ids: ids, users: users };
  }

  /** Next delay for a frame loop: the base (200 ms) when healthy, doubling to 4 s on errors. */
  function nextFrameDelay(current, ok, base) {
    base = base || 200;
    return ok ? base : Math.min(Math.max((current || base) * 2, 250), 4000);
  }

  /**
   * Where a tap landed inside a letterboxed (object-fit: contain) picture, as 0..1 of the picture itself.
   * `box` = the <img> element's rect {left, top, width, height}; the picture is centred in it. null = outside it.
   * Same maths as the desk's sonyContainedPoint, plus px/py (relative to the box) for drawing the crosshair.
   */
  function containedPoint(box, naturalW, naturalH, clientX, clientY) {
    if (!naturalW || !naturalH || !box || !box.width || !box.height) return null;
    var imageRatio = naturalW / naturalH, boxRatio = box.width / box.height;
    var w = boxRatio > imageRatio ? box.height * imageRatio : box.width;
    var h = boxRatio > imageRatio ? box.height : box.width / imageRatio;
    var left = box.left + (box.width - w) / 2, top = box.top + (box.height - h) / 2;
    if (clientX < left || clientX > left + w || clientY < top || clientY > top + h) return null;
    return { x: (clientX - left) / w, y: (clientY - top) / h, px: clientX - box.left, py: clientY - box.top };
  }

  /** null when the iPad may change Sony settings / touch focus, else the sentence to show. Needs remote control on, not the seat. */
  function sonyWriteBlock(enabled) {
    if (enabled === false) return 'Remote control is off. Turn it on from the desk page.';
    if (enabled !== true) return 'Not connected yet.';
    return null;
  }

  /** null when this page may change the controlled camera (it holds control), else the sentence to show. */
  function selectBlock(enabled, owner) {
    if (enabled === false) return 'Remote control is off. Turn it on from the desk page.';
    if (!(owner && owner.owner === 'remote' && owner.you)) return 'Take control first';
    return null;
  }

  /** What the Sony service returns for one setting -> the number it holds (hex strings and numbers), or null. */
  function sonyReported(body) {
    var d = (body && body.data) || body || {};
    var raw = d.value !== undefined ? d.value : d.current_value;
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string' && /^0x[0-9a-f]+$/i.test(raw)) return parseInt(raw, 16);
    if (typeof raw === 'string' && /^-?[0-9]+$/.test(raw)) return Number(raw);
    return null;
  }

  /**
   * One setting for the menu. kind: 'select' (writable, with options), 'readonly' (greyed: nothing to pick, shows the
   * current value) or 'unavailable'. `pending` (value the operator just chose, not yet reported) wins over the camera's
   * own value so the menu does not snap back while the camera catches up. Options carry the hex string to PUT.
   */
  function propertyView(name, prop, pending) {
    var label = PROPERTY_LABELS[name] || name;
    if (!prop || !Array.isArray(prop.available_values)) return { name: name, label: label, kind: 'unavailable', options: [], selected: null, text: 'Unavailable' };
    if (prop.available_values.length === 0) {
      return { name: name, label: label, kind: 'readonly', options: [], selected: null, text: (prop.current_formatted != null ? String(prop.current_formatted) : '—') + ' (read-only)' };
    }
    var options = prop.available_values.map(function (item) {
      return { value: item.value, hex: typeof item.hex_value === 'string' ? item.hex_value : null, text: String(item.formatted != null ? item.formatted : item.value) };
    });
    var selected = pending !== undefined && pending !== null ? pending : prop.current_value;
    return { name: name, label: label, kind: prop.writable === true ? 'select' : 'readonly', options: options, selected: selected, text: prop.current_formatted != null ? String(prop.current_formatted) : '' };
  }

  /** The value to send for a chosen option: the hex string when the camera gave one (raw numbers are rejected). */
  function sendValue(option) { return option && option.hex ? option.hex : (option ? option.value : undefined); }

  /** Battery and overheat line for one Sony camera (an entry of /api/sony/status cameras). { text, level }. */
  function batteryInfo(camera) {
    var b = camera && camera.battery, pct = b && typeof b.percent === 'number' ? b.percent : null;
    var hot = camera && camera.overheat && camera.overheat.state;
    var text = pct === null ? 'Battery unknown' : 'Battery ' + pct + '%' + (b.stale ? ' (old reading)' : '');
    var level = pct === null || (b && b.stale) ? 'idle' : (pct >= 40 ? 'ready' : pct >= 20 ? 'check' : 'down');
    if (hot === 'over') { text += ' · Overheating'; level = 'down'; }
    else if (hot === 'pre') { text += ' · Getting hot'; if (level !== 'down') level = 'check'; }
    return { text: text, level: level };
  }

  /** The Sony status entry for a Sony camera id (ids compare case-insensitively). */
  function sonyCameraEntry(sonyStatus, sonyId) {
    var list = (sonyStatus && sonyStatus.cameras) || [];
    for (var i = 0; i < list.length; i++) if (String(list[i].id).toUpperCase() === String(sonyId).toUpperCase()) return list[i];
    return null;
  }

  function speedLine(speeds, status, pushed) {
    var st = status || {};
    var name = pushed && pushed.speedName ? pushed.speedName : ((speeds && speeds.presets && speeds.presets[st.speedPreset]) ? speeds.presets[st.speedPreset].name : '');
    var precision = pushed ? !!pushed.precision : !!st.precisionMode;
    return name ? 'Speed: ' + name + (precision ? ' · precision' : '') : '';
  }

  return {
    STICK_DEADZONE: STICK_DEADZONE,
    MASK_BITS: MASK_BITS,
    stick: stick, frameFromPad: frameFromPad, neutralFrame: neutralFrame, startHeld: startHeld,
    padStatus: padStatus, deniedText: deniedText, ownerPill: ownerPill, lostText: lostText,
    camerasView: camerasView, previewCameraId: previewCameraId, speedLine: speedLine,
    PROPERTY_NAMES: PROPERTY_NAMES, layoutFor: layoutFor, tagsFor: tagsFor, paneView: paneView, multiviewPlan: multiviewPlan,
    framePlan: framePlan, nextFrameDelay: nextFrameDelay, containedPoint: containedPoint, sonyWriteBlock: sonyWriteBlock,
    selectBlock: selectBlock, sonyReported: sonyReported, propertyView: propertyView, sendValue: sendValue,
    batteryInfo: batteryInfo, sonyCameraEntry: sonyCameraEntry,
  };
});
