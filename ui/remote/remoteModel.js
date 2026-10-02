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
  };
});
