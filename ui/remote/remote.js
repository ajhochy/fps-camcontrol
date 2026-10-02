/*
 * iPad remote: reads an Xbox (or other standard-mapping) controller with the browser Gamepad API and streams it
 * to CamControl over /ws/remote-controller, so the iPad drives the cameras the way the desk controller does.
 *
 * Safety lives mostly on the server (a remote that goes silent for 250 ms stops the camera; 1000 ms loses the
 * seat), because Safari suspends scripts when the page is hidden or the iPad locks. This page does what it can
 * on its way out: when the page is hidden, blurred or the pad disappears it sends a neutral frame and {t:'idle'},
 * stops sending, and does NOT resume control by itself: control has to be taken again (button or Menu held 1 s).
 *
 * Plain JS with no build step. Pure helpers (deadzone, frame mask, wording) are in remoteModel.js.
 */
(function () {
  'use strict';

  var M = window.RemoteModel;
  var FRAME_MS = 33;           // 30 Hz: the stream itself is the heartbeat
  var CLAIM_HOLD_MS = 1000;    // hold Menu this long to take control from the pad
  var CLAIM_RETRY_MS = 1500;
  var PREVIEW_MS = 200;        // 5 fps, matching the Sony service

  function $(id) { return document.getElementById(id); }
  var el = {
    conn: $('conn'), connText: $('connText'), rtt: $('rtt'), ownerPill: $('ownerPill'), padPill: $('padPill'),
    nameBtn: $('nameBtn'), banner: $('banner'), previewImg: $('previewImg'), previewNote: $('previewNote'),
    controlInfo: $('controlInfo'), cams: $('cams'), speedLine: $('speedLine'), claimBtn: $('claimBtn'),
    releaseBtn: $('releaseBtn'), stopBtn: $('stopBtn'), hint: $('hint'), wakeHint: $('wakeHint'),
    pinRow: $('pinRow'), pinInput: $('pinInput'), pinBtn: $('pinBtn'),
  };

  var ws = null;
  var connected = false;
  var welcomed = false;
  var seq = 0;
  var owner = null;            // last { owner, you, ownerName } from the server
  var enabled = null;          // remote control switched on at the desk? (null = not known yet)
  var sending = false;
  var focused = true;
  var startHeldSince = 0;
  var lastClaimAt = 0;
  var padInfo = M.padStatus([]);
  var pushed = null;           // last {t:'state'} the server pushed while we own
  var status = null;           // GET /api/status
  var cameras = [];
  var speeds = null;
  var rigs = null;
  var rttMs = null;
  var needsPin = false;        // the server wants a PIN before this page may take control
  var bannerTimer = null;
  var bannerUntil = 0;         // a message (denied, lost control, STOP) stays up until then

  // ---- small helpers
  function store(key, value) { try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value); } catch (_) { /* private mode */ } return null; }
  function session(key, value) { try { if (value === undefined) return sessionStorage.getItem(key); sessionStorage.setItem(key, value); } catch (_) { /* private mode */ } return null; }
  var name = store('fps-remote-name') || 'iPad';
  el.nameBtn.textContent = name;

  function isVisible() { return !document.hidden && focused; }
  function haveOwnership() { return !!(owner && owner.owner === 'remote' && owner.you); }

  function showBanner(text, bad, holdMs) {
    clearTimeout(bannerTimer);
    el.banner.textContent = text;
    el.banner.className = 'banner' + (bad ? ' bad' : '');
    el.banner.hidden = false;
    bannerUntil = Date.now() + (holdMs || 0);
    if (holdMs) bannerTimer = setTimeout(function () { bannerUntil = 0; updateBanner(); }, holdMs);
  }
  function updateBanner() {
    if (Date.now() < bannerUntil) return;
    var text = null;
    var bad = false;
    if (!connected) { text = 'Not connected to CamControl. Retrying…'; bad = true; }
    else if (padInfo.kind === 'unsupported') { text = padInfo.text + '. Motion is not sent.'; bad = true; }
    else if (!isVisible()) text = 'Paused. Control must be taken again when you come back.';
    else if (padInfo.kind === 'none') text = 'Press any button on the controller.';
    if (text) { el.banner.textContent = text; el.banner.className = 'banner' + (bad ? ' bad' : ''); el.banner.hidden = false; }
    else el.banner.hidden = true;
  }

  function send(obj) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch (_) { return false; }
  }
  function sendFrame(frame) {
    return send({ t: 'in', s: ++seq, a: frame.a, tr: frame.tr, b: frame.b });
  }

  // ---- connection
  function connect() {
    var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/remote-controller';
    try { ws = new WebSocket(url); } catch (_) { setTimeout(connect, 1500); return; }
    var mine = ws;
    ws.onopen = function () {
      if (ws !== mine) return;
      connected = true; welcomed = false; seq = 0;
      sendHello();
      render();
    };
    ws.onmessage = function (e) { if (ws === mine) onMessage(e.data); };
    ws.onclose = function () {
      if (ws !== mine) return;
      connected = false; welcomed = false; sending = false; owner = null; rttMs = null;
      render();
      setTimeout(connect, 1000);
    };
    ws.onerror = function () { /* onclose follows */ };
  }

  function sendHello() {
    var hello = { t: 'hello', v: 1, name: name, pad: padInfo.pad ? { id: padInfo.pad.id, mapping: padInfo.pad.mapping } : null };
    var pin = session('fps-remote-pin');
    if (pin) hello.pin = pin;
    send(hello);
  }

  function onMessage(data) {
    var m;
    try { m = JSON.parse(data); } catch (_) { return; }
    if (m.t === 'welcome') {
      welcomed = true;
      needsPin = !!m.needsPin;
      enabled = m.enabled;
      owner = { owner: m.owner, you: false };
    } else if (m.t === 'owner') {
      var hadIt = haveOwnership();
      owner = { owner: m.owner, you: !!m.you, ownerName: m.ownerName };
      if (typeof m.enabled === 'boolean') enabled = m.enabled;
      if (hadIt && !owner.you) {
        var why = M.lostText(m.reason);
        if (why) showBanner(why, true, 6000);
      }
      if (!owner.you) pushed = null;
    } else if (m.t === 'denied') {
      if (m.reason === 'pin') { needsPin = true; if (session('fps-remote-pin')) session('fps-remote-pin', ''); }
      showBanner(m.reason === 'pin' && m.locked ? 'Too many wrong PINs. Wait a minute and try again.' : M.deniedText(m.reason), true, 5000);
    } else if (m.t === 'pong') {
      rttMs = Math.max(0, Math.round(performance.now() - m.ts));
    } else if (m.t === 'state') {
      pushed = m;
    }
    render();
  }

  setInterval(function () { send({ t: 'ping', ts: performance.now() }); }, 2000);

  // ---- the control loop
  function goIdle() {
    if (sending) { sendFrame(M.neutralFrame()); sending = false; }
    send({ t: 'idle' });
    startHeldSince = 0;
    render();
  }

  function tick() {
    var pads = [];
    try { pads = navigator.getGamepads ? Array.prototype.slice.call(navigator.getGamepads()) : []; } catch (_) { /* no gamepad support */ }
    var previous = padInfo.kind;
    padInfo = M.padStatus(pads);
    if (padInfo.kind !== previous) { if (padInfo.kind !== 'ok') goIdle(); else if (connected) sendHello(); render(); }

    var active = isVisible() && padInfo.kind === 'ok' && connected && welcomed;
    if (!active) {
      if (sending) goIdle();
      return;
    }
    sending = true;
    var frame = M.frameFromPad(padInfo.pad);
    sendFrame(frame);

    // Menu held for a second takes control from the pad itself.
    var now = Date.now();
    if (M.startHeld(frame)) {
      if (!startHeldSince) startHeldSince = now;
      if (!haveOwnership() && now - startHeldSince >= CLAIM_HOLD_MS && now - lastClaimAt >= CLAIM_RETRY_MS) { lastClaimAt = now; send({ t: 'claim' }); }
    } else startHeldSince = 0;
  }
  setInterval(tick, FRAME_MS);

  // ---- leaving the page: stop first, ask questions later
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { focused = false; goIdle(); }
    else { focused = true; lockScreen(); }
    updateBanner();
  });
  window.addEventListener('pagehide', function () { focused = false; goIdle(); });
  window.addEventListener('blur', function () { focused = false; goIdle(); updateBanner(); });
  window.addEventListener('focus', function () { focused = true; updateBanner(); });
  window.addEventListener('pageshow', function () { focused = true; updateBanner(); });
  window.addEventListener('pointerdown', function () { if (!document.hidden) { focused = true; updateBanner(); } });
  window.addEventListener('gamepaddisconnected', function () { goIdle(); });
  window.addEventListener('gamepadconnected', function () { render(); });

  // ---- buttons
  el.claimBtn.addEventListener('click', function () { lastClaimAt = Date.now(); send({ t: 'claim' }); });
  el.releaseBtn.addEventListener('click', function () { send({ t: 'release' }); });
  el.stopBtn.addEventListener('click', function () {
    // Both paths: the socket (instant, also releases the seat) and plain HTTP (works if the socket is down).
    send({ t: 'stop' });
    try { fetch('/api/emergency-stop', { method: 'POST', keepalive: true }); } catch (_) { /* best effort */ }
    showBanner('STOP sent: all cameras stopped.', true, 4000);
  });
  function submitPin() {
    var pin = el.pinInput.value.replace(/[^0-9]/g, '');
    if (!pin) return;
    session('fps-remote-pin', pin);
    el.pinInput.value = '';
    sendHello();
  }
  el.pinBtn.addEventListener('click', submitPin);
  el.pinInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitPin(); });
  el.nameBtn.addEventListener('click', function () {
    var next = window.prompt('Name shown on the desk', name);
    if (next === null) return;
    next = next.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 40);
    if (!next) return;
    name = next; store('fps-remote-name', name); el.nameBtn.textContent = name;
    if (connected) sendHello();
  });

  // ---- rendering
  function render() {
    el.conn.className = 'dot ' + (connected ? 'dot-on' : 'dot-off');
    el.connText.textContent = connected ? 'Connected' : 'Connecting…';
    el.rtt.textContent = connected && rttMs !== null ? rttMs + ' ms' : '';
    var pill = M.ownerPill(owner, connected, enabled);
    el.ownerPill.className = 'pill ' + pill.cls;
    el.ownerPill.textContent = pill.text;
    el.padPill.className = 'pill ' + (padInfo.kind === 'ok' ? 'pill-you' : (padInfo.kind === 'unsupported' ? 'pill-off' : 'pill-wait'));
    el.padPill.textContent = padInfo.text;

    el.pinRow.hidden = !(connected && welcomed && needsPin);
    var mine = haveOwnership();
    var canClaim = connected && welcomed && enabled !== false && padInfo.kind === 'ok' && isVisible();
    el.claimBtn.hidden = mine;
    el.claimBtn.disabled = !canClaim;
    el.releaseBtn.hidden = !mine;
    el.hint.textContent = mine
      ? 'You are driving. Sticks and buttons work like the desk controller. Menu is unused.'
      : 'Press any button on the controller to wake it. Hold Menu for 1 s to take control.';
    el.controlInfo.textContent = mine ? 'Driving ' + controlledLabel() : (owner && owner.owner === 'remote' ? (owner.ownerName || 'Another iPad') + ' is driving' : '');
    el.speedLine.textContent = M.speedLine(speeds, status, mine ? pushed : null);
    updateBanner();
  }

  function controlledLabel() {
    var id = status && status.controlledCamera;
    for (var i = 0; i < cameras.length; i++) if (cameras[i].id === id) return cameras[i].label;
    return id || '';
  }

  function renderCameras() {
    var rows = M.camerasView(cameras, status);
    el.cams.textContent = '';
    rows.forEach(function (row) {
      var li = document.createElement('li');
      li.className = 'cam' + (row.controlled ? ' controlled' : '');
      var title = document.createElement('div');
      title.className = 'cam-name';
      title.appendChild(document.createTextNode(row.label));
      [['controlled', 'CTL', 'badge-ctl'], ['program', 'PGM', 'badge-pgm'], ['preview', 'PVW', 'badge-pvw']].forEach(function (b) {
        if (!row[b[0]]) return;
        var span = document.createElement('span');
        span.className = 'badge ' + b[2];
        span.textContent = b[1];
        title.appendChild(span);
      });
      li.appendChild(title);
      if (row.healthText) {
        var h = document.createElement('div');
        h.className = 'cam-health ' + row.healthLevel;
        h.textContent = row.healthText;
        li.appendChild(h);
      }
      el.cams.appendChild(li);
    });
  }

  // ---- data from the app (1 Hz status; config and rigs now and then)
  function getJson(url) { return fetch(url, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error(url); return r.json(); }); }
  var lastControlled = null;
  function pollStatus() {
    if (document.hidden) return;
    getJson('/api/status').then(function (s) {
      status = s;
      if (s.remoteControl && typeof s.remoteControl.enabled === 'boolean') enabled = s.remoteControl.enabled;
      renderCameras();
      if (s.controlledCamera !== lastControlled) { lastControlled = s.controlledCamera; previewTarget = undefined; }
      render();
    }).catch(function () { /* the connection dot says it */ });
  }
  function loadConfig() {
    getJson('/api/config').then(function (c) { cameras = c.cameras || []; speeds = c.speeds || null; renderCameras(); render(); }).catch(function () { setTimeout(loadConfig, 3000); });
  }
  function loadRigs() { getJson('/api/rigs').then(function (r) { rigs = r; previewTarget = undefined; }).catch(function () { /* keep the old one */ }); }
  setInterval(pollStatus, 1000);
  setInterval(loadRigs, 15000);

  // ---- live preview of the controlled camera's Sony camera (only while the page is visible)
  var previewTarget;           // undefined = recompute; null = no preview for this rig; string = Sony camera id
  var previewStartedFor = null;
  var previewUrl = null;
  var previewDelay = PREVIEW_MS;
  function setNote(text) { el.previewNote.textContent = text; el.previewImg.hidden = true; }
  function previewLoop() {
    if (document.hidden) { setTimeout(previewLoop, 500); return; }
    if (previewTarget === undefined) {
      previewTarget = (status && rigs) ? M.previewCameraId(rigs, status.controlledCamera) : undefined;
      if (previewTarget === null) setNote('No preview for this rig');
      else if (previewTarget === undefined) setNote('Waiting for the camera list…');
    }
    if (!previewTarget) { setTimeout(previewLoop, 500); return; }
    var id = previewTarget;
    var begin = previewStartedFor === id ? Promise.resolve() : fetch('/api/sony/cameras/' + encodeURIComponent(id) + '/live-view/start', { method: 'POST' }).then(function (r) { if (r.ok) previewStartedFor = id; });
    begin.then(function () { return fetch('/api/sony/cameras/' + encodeURIComponent(id) + '/live-view/frame', { cache: 'no-store' }); })
      .then(function (r) { if (!r.ok) throw new Error('frame'); return r.blob(); })
      .then(function (blob) {
        if (id !== previewTarget) return;
        var next = URL.createObjectURL(blob);
        var old = previewUrl;
        previewUrl = next;
        el.previewImg.onload = function () { if (old) URL.revokeObjectURL(old); };
        el.previewImg.src = next;
        el.previewImg.hidden = false;
        previewDelay = PREVIEW_MS;
      })
      .catch(function () { setNote('Preview unavailable'); previewDelay = Math.min(previewDelay * 2, 4000); })
      .then(function () { setTimeout(previewLoop, previewDelay); });
  }

  // ---- keep the screen on (needs https; see docs/ipad-remote.md)
  var wake = null;
  function lockScreen() {
    if (!window.isSecureContext || !navigator.wakeLock) {
      el.wakeHint.textContent = 'Screen may auto-lock: set Auto-Lock to Never (Settings > Display & Brightness) or open the https link.';
      el.wakeHint.hidden = false;
      return;
    }
    if (wake || document.hidden) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      wake = lock;
      lock.addEventListener('release', function () { wake = null; });
    }).catch(function () { /* low battery or denied: the hint is not needed, the server dead-man still protects */ });
  }

  // ---- go
  render();
  loadConfig();
  pollStatus();
  loadRigs();
  previewLoop();
  lockScreen();
  connect();
})();
