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
  var SELECT_POLL_MS = 150;    // re-read the status soon after picking a camera

  function $(id) { return document.getElementById(id); }
  var el = {
    conn: $('conn'), connText: $('connText'), rtt: $('rtt'), ownerPill: $('ownerPill'), padPill: $('padPill'),
    nameBtn: $('nameBtn'), banner: $('banner'), main: $('main'), paneEls: { pvw: $('pane-pvw'), pgm: $('pane-pgm') }, smallPanes: $('smallPanes'),
    controlInfo: $('controlInfo'), speedLine: $('speedLine'), claimBtn: $('claimBtn'),
    sheet: $('sheet'), sheetBack: $('sheetBack'), sheetTitle: $('sheetTitle'), sheetBattery: $('sheetBattery'), sheetRows: $('sheetRows'), sheetStatus: $('sheetStatus'), sheetClose: $('sheetClose'),
    releaseBtn: $('releaseBtn'), stopBtn: $('stopBtn'), hint: $('hint'), wakeHint: $('wakeHint'),
    pinRow: $('pinRow'), pinInput: $('pinInput'), pinBtn: $('pinBtn'),
    transitionBtn: $('transitionBtn'), speedBtns: $('speedBtns'),
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
  var touchSpeedName = M.speedLevel(store('fps-remote-speed') || M.DEFAULT_SPEED);
  var press = null;            // the arrow being held: { pointerId, key, rigId, dirs, onAir, startedAt }
  var pgmUnlockedUntil = 0;    // ms timestamp until which moving the program camera is allowed

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
    endPress();
    if (sending) { sendFrame(M.neutralFrame()); sending = false; }
    send({ t: 'idle' });
    startHeldSince = 0;
    render();
  }

  // The pad going away: a touch user who holds the seat keeps it (the neutral heartbeat continues); otherwise idle.
  function padLost() {
    if (haveOwnership() && !document.hidden) { sendFrame(M.neutralFrame()); render(); }
    else goIdle();
  }

  function tick() {
    var pads = [];
    try { pads = navigator.getGamepads ? Array.prototype.slice.call(navigator.getGamepads()) : []; } catch (_) { /* no gamepad support */ }
    var previous = padInfo.kind;
    padInfo = M.padStatus(pads);
    if (padInfo.kind !== previous) { if (padInfo.kind !== 'ok') padLost(); else if (connected) sendHello(); render(); }
    if (press && M.pressExpired(press.startedAt, Date.now())) endPress();

    // Visible but not focused (iPadOS can take focus for a system overlay, e.g. on some controller buttons): the
    // pad can't be trusted, so hold the camera still with neutral frames but keep control. Only a page that is
    // really gone (hidden, switched away, locked) gives control back, below.
    if (!document.hidden && !focused && padInfo.kind === 'ok' && connected && welcomed && haveOwnership()) {
      endPress();
      sendFrame(M.neutralFrame());
      sending = true;
      return;
    }
    var padActive = isVisible() && padInfo.kind === 'ok' && connected && welcomed;
    // Touch: while this page holds the seat (and is not hidden) frames keep flowing, neutral unless an arrow is
    // held. They are the heartbeat that keeps the seat; losing focus drops any held arrow but not the seat.
    var touchSeat = haveOwnership() && !document.hidden && connected && welcomed;
    if (!padActive && !touchSeat) {
      if (sending) goIdle();
      return;
    }
    if (!isVisible()) endPress();
    var padFrame = padActive ? M.frameFromPad(padInfo.pad) : null;
    var touchFrame = touchSeat && press ? M.arrowFrame(press.dirs, touchSpeedName, M.onAir(press.rigId, status)) : null;
    var chosen = M.chooseFrame(padFrame, touchFrame); // the pad wins while it is being touched
    sending = true;
    sendFrame(chosen.frame);
    if (!padFrame) return;
    var frame = padFrame;

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
  // Blur alone does not give control back (see tick): the camera is held still until focus returns.
  window.addEventListener('blur', function () { focused = false; endPress(); if (!haveOwnership()) goIdle(); updateBanner(); });
  window.addEventListener('focus', function () { focused = true; updateBanner(); });
  window.addEventListener('pageshow', function () { focused = true; updateBanner(); });
  window.addEventListener('pointerdown', function () { if (!document.hidden) { focused = true; updateBanner(); } });
  window.addEventListener('gamepaddisconnected', function () { padLost(); });
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
    var canClaim = connected && welcomed && enabled !== false && isVisible();
    el.claimBtn.hidden = mine;
    el.claimBtn.disabled = !canClaim;
    el.releaseBtn.hidden = !mine;
    el.hint.textContent = mine
      ? 'You are driving. Sticks and buttons work like the desk controller; the arrows on PVW and PGM move that camera.'
      : 'Tap Take control to drive with touch, or wake the controller and hold Menu for 1 s.';
    el.controlInfo.textContent = mine ? 'Driving ' + controlledLabel() : (owner && owner.owner === 'remote' ? (owner.ownerName || 'Another iPad') + ' is driving' : '');
    el.speedLine.textContent = M.speedLine(speeds, status, mine ? pushed : null);
    updateTouchUi();
    updateBanner();
  }

  function controlledLabel() {
    var id = status && status.controlledCamera;
    for (var i = 0; i < cameras.length; i++) if (cameras[i].id === id) return cameras[i].label;
    return id || '';
  }

  // ---- data from the app (1 Hz status; config and rigs now and then)
  function getJson(url) { return fetch(url, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error(url); return r.json(); }); }
  function pollStatus() {
    if (document.hidden) return;
    getJson('/api/status').then(function (s) {
      status = s;
      if (s.remoteControl && typeof s.remoteControl.enabled === 'boolean') enabled = s.remoteControl.enabled;
      renderMultiview();
      render();
    }).catch(function () { /* the connection dot says it */ });
  }
  function loadConfig() {
    getJson('/api/config').then(function (c) { cameras = c.cameras || []; speeds = c.speeds || null; renderMultiview(); render(); }).catch(function () { setTimeout(loadConfig, 3000); });
  }
  function loadRigs() { getJson('/api/rigs').then(function (r) { rigs = r; renderMultiview(); }).catch(function () { /* keep the old one */ }); }
  setInterval(pollStatus, 1000);
  setInterval(loadRigs, 15000);

  // ---- multiview: PVW and PGM large, one small pane per rig. One frame loop per Sony camera feeds every pane
  // that shows it (the large PVW/PGM and the small pane of the same camera share a single fetch).
  var plan = null;
  var fpNow = { ids: [], users: {} };
  var nodes = {};              // pane key -> DOM parts
  var smallKey = '';           // which small panes exist (rebuilt only when the rig list changes)
  var frames = {};             // Sony camera id -> { url, at, error, started, delay, running, wanted }
  var FRESH_MS = 4000;         // a picture older than this is not shown as live

  function div(cls, text) { var d = document.createElement('div'); if (cls) d.className = cls; if (text) d.textContent = text; return d; }

  function buildPane(root, key, big) {
    root.textContent = '';
    var pic = div('pane-pic');
    var img = document.createElement('img');
    img.alt = ''; img.draggable = false; img.hidden = true;
    var cross = div('crosshair');
    var note = div('pane-note');
    pic.appendChild(img); pic.appendChild(cross); pic.appendChild(note);
    var head = div('pane-head');
    var title = div('pane-title');
    var menu = document.createElement('button');
    menu.type = 'button'; menu.className = 'pane-menu'; menu.textContent = '⋯'; menu.setAttribute('aria-label', 'Camera menu');
    head.appendChild(title); head.appendChild(menu);
    var foot = div('pane-foot');
    root.appendChild(pic); root.appendChild(head); root.appendChild(foot);
    var n = { key: key, big: big, root: root, img: img, cross: cross, note: note, title: title, menu: menu, foot: foot, sig: '', crossTimer: null, url: '', pad: null, lock: null, track: null };
    if (big) buildTouchPad(n, root, head);
    if (big) buildTrackBar(n, pic, head);
    menu.addEventListener('click', function (e) { e.stopPropagation(); var pane = paneFor(key); if (pane) openSheet(pane); });
    if (big) img.addEventListener('pointerup', function (e) { onBigTap(n, e); });
    else root.addEventListener('click', function () { var pane = paneFor(key); if (pane && pane.rigId) onSmallTap(pane); });
    nodes[key] = n;
    return n;
  }

  function paneFor(key) {
    if (!plan) return null;
    if (key === 'pvw') return plan.pvw;
    if (key === 'pgm') return plan.pgm;
    for (var i = 0; i < plan.small.length; i++) if (plan.small[i].key === key) return plan.small[i];
    return null;
  }

  function badge(text, cls) { var b = document.createElement('span'); b.className = 'badge ' + cls; b.textContent = text; return b; }
  var BADGE_CLASS = { PGM: 'badge-pgm', PVW: 'badge-pvw', CTL: 'badge-ctl' };

  function updatePaneText(n, pane) {
    var sig = [pane.rigId, pane.label, pane.tags.join('+'), pane.sonyId, pane.healthLevel, pane.healthText].join('|');
    if (sig === n.sig) return;
    n.sig = sig;
    n.title.textContent = '';
    if (n.big) n.title.appendChild(badge(n.key === 'pgm' ? 'PGM' : 'PVW', n.key === 'pgm' ? 'badge-pgm' : 'badge-pvw'));
    n.title.appendChild(document.createTextNode(pane.rigId ? pane.label : (n.key === 'pgm' ? 'No program camera' : 'No preview camera')));
    pane.tags.forEach(function (t) { if (!n.big || t === 'CTL') n.title.appendChild(badge(t, BADGE_CLASS[t])); });
    n.menu.disabled = !pane.sonyId;
    n.foot.textContent = pane.healthText;
    n.foot.className = 'pane-foot ' + (pane.healthLevel || '');
    n.root.classList.toggle('controlled', pane.tags.indexOf('CTL') >= 0);
  }

  // The picture (or the reason there is none) for one pane, from the shared frame of its Sony camera.
  function updatePaneMedia(n, pane) {
    var f = pane.sonyId ? frames[pane.sonyId] : null;
    var fresh = !!(pane.wantsPicture && f && f.url && Date.now() - f.at < FRESH_MS);
    if (fresh) {
      if (n.url !== f.url) { n.url = f.url; n.img.src = f.url; }
      n.img.alt = 'Live view of ' + pane.label;
      if (n.img.hidden) n.img.hidden = false;
      n.note.textContent = '';
      return;
    }
    n.img.hidden = true;
    var text, cls = '';
    if (!pane.rigId) text = pane.healthText || 'No camera';
    else if (!pane.wantsPicture) { text = pane.healthText; cls = pane.healthLevel; }
    else if (f && f.error) { text = f.error; cls = 'check'; }
    else text = 'Waiting for picture…';
    n.note.textContent = text;
    n.note.className = 'pane-note ' + cls;
  }

  function renderMultiview() {
    if (!nodes.pvw) { buildPane(el.paneEls.pvw, 'pvw', true); buildPane(el.paneEls.pgm, 'pgm', true); nodes.pvw.note.textContent = nodes.pgm.note.textContent = 'Waiting for the camera list…'; }
    if (!status || !rigs || !cameras.length) return;
    plan = M.multiviewPlan(cameras, status, rigs);
    var key = plan.small.map(function (p) { return p.key; }).join(',');
    if (key !== smallKey) {
      smallKey = key;
      Object.keys(nodes).forEach(function (k) { if (k !== 'pvw' && k !== 'pgm') delete nodes[k]; });
      el.smallPanes.textContent = '';
      plan.small.forEach(function (p) {
        var root = document.createElement('section');
        root.className = 'pane pane-small'; root.dataset.pane = p.key;
        el.smallPanes.appendChild(root);
        buildPane(root, p.key, false);
      });
    }
    fpNow = M.framePlan(plan);
    syncLoops();
    ['pvw', 'pgm'].concat(plan.small.map(function (p) { return p.key; })).forEach(function (k) { var pane = paneFor(k); if (pane && nodes[k]) { updatePaneText(nodes[k], pane); updatePaneMedia(nodes[k], pane); } });
    updateTouchUi();
    updateTrackUi();
  }

  function onFrame(sonyId) {
    (fpNow.users[sonyId] || []).forEach(function (k) { var pane = paneFor(k); if (pane && nodes[k]) updatePaneMedia(nodes[k], pane); });
  }

  function syncLoops() {
    Object.keys(frames).forEach(function (id) { frames[id].wanted = fpNow.ids.indexOf(id) >= 0; });
    fpNow.ids.forEach(function (id) {
      var f = frames[id];
      if (!f) f = frames[id] = { url: null, at: 0, error: '', started: false, delay: PREVIEW_MS, running: false, wanted: true };
      f.wanted = true;
      if (!f.running) runLoop(id, f);
    });
  }

  function frameError(code) {
    return code === 503 ? 'Sony camera busy or the Sony service is off' : code === 404 ? 'Sony camera not found' : 'Sony camera not connected';
  }
  function runLoop(id, f) {
    f.running = true;
    var base = '/api/sony/cameras/' + encodeURIComponent(id);
    (function step() {
      if (!f.wanted) { f.running = false; return; }
      if (document.hidden) { setTimeout(step, 500); return; }
      var begin = f.started ? Promise.resolve() : fetch(base + '/live-view/start', { method: 'POST' }).then(function (r) { if (!r.ok) throw new Error(frameError(r.status)); f.started = true; });
      begin.then(function () { return fetch(base + '/live-view/frame', { cache: 'no-store' }); })
        .then(function (r) { if (r.ok) return r.blob(); throw new Error(frameError(r.status)); })
        .then(function (blob) {
          var old = f.url;
          f.url = URL.createObjectURL(blob);
          f.at = Date.now(); f.error = ''; f.delay = M.nextFrameDelay(f.delay, true, PREVIEW_MS);
          if (old) setTimeout(function () { URL.revokeObjectURL(old); }, 1500);
          onFrame(id);
        })
        .catch(function (error) {
          f.started = false;
          f.error = 'Preview unavailable: ' + (error && error.message && error.message !== 'Failed to fetch' ? error.message : 'CamControl not reachable');
          f.delay = M.nextFrameDelay(f.delay, false, PREVIEW_MS);
          onFrame(id);
        })
        .then(function () { setTimeout(step, f.delay); });
    })();
  }

  // ---- touch control: arrows on the big panes move the camera shown there while held
  var ARROW_GLYPHS = { up: '▲', down: '▼', left: '◀', right: '▶', zoomIn: '+', zoomOut: '−' };
  var ARROW_LABELS = { up: 'Tilt up', down: 'Tilt down', left: 'Pan left', right: 'Pan right', zoomIn: 'Zoom in', zoomOut: 'Zoom out' };

  function buildTouchPad(n, root, head) {
    var pad = div('touchpad');
    var moves = div('tp-moves'), zoom = div('tp-zoom');
    ['left', 'up', 'down', 'right'].forEach(function (d) { moves.appendChild(arrowButton(n, d)); });
    ['zoomIn', 'zoomOut'].forEach(function (d) { zoom.appendChild(arrowButton(n, d)); });
    pad.appendChild(zoom); pad.appendChild(moves);
    root.appendChild(pad);
    n.pad = pad;
    // Nothing on the pad may select text, scroll, zoom, open a callout or a context menu.
    ['contextmenu', 'selectstart', 'dragstart', 'gesturestart'].forEach(function (ev) { pad.addEventListener(ev, function (e) { e.preventDefault(); }); });
    if (n.key === 'pgm') {
      var lock = document.createElement('button');
      lock.type = 'button'; lock.className = 'pgm-lock';
      lock.addEventListener('click', function (e) {
        e.stopPropagation();
        var block = M.selectBlock(enabled, owner);
        if (!M.pgmLocked(pgmUnlockedUntil, Date.now())) { pgmUnlockedUntil = 0; endPress(); }
        else if (block) showBanner(block, true, 3000);
        else pgmUnlockedUntil = M.pgmUnlockUntil(Date.now());
        updateTouchUi();
      });
      head.insertBefore(lock, n.menu);
      n.lock = lock;
    }
  }

  function arrowButton(n, dir) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'arrow arrow-' + dir; b.textContent = ARROW_GLYPHS[dir];
    b.setAttribute('aria-label', ARROW_LABELS[dir] + ' (' + n.key.toUpperCase() + ')');
    b.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button > 0) return;
      e.preventDefault(); e.stopPropagation();
      try { b.releasePointerCapture(e.pointerId); } catch (_) { /* not captured */ } // so sliding off the button ends the press
      if (!document.hidden) focused = true;
      startPress(n.key, dir, e.pointerId);
    });
    ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture'].forEach(function (ev) {
      b.addEventListener(ev, function (e) { if (press && press.pointerId === e.pointerId) endPress(); });
    });
    b.addEventListener('click', function (e) { e.stopPropagation(); });
    return b;
  }

  function startPress(key, dir, pointerId) {
    if (press) return; // one finger at a time
    var v = M.arrowsView(key, plan, status, enabled, owner, pgmUnlockedUntil, Date.now());
    if (!v.show) return;
    if (!v.enabled) { showBanner(v.reason, true, 3000); return; }
    if (!connected || !welcomed || !isVisible()) return;
    // Control this pane's camera first (control only: the ATEM preview stays where it is), then frames follow on
    // the same socket, so the server sees the select before the first move.
    send({ t: 'select', camera: v.rigId, preview: false });
    press = { pointerId: pointerId, key: key, rigId: v.rigId, dirs: [dir], onAir: v.onAir, startedAt: Date.now() };
    markPressed();
    tick(); // first frame now, not up to 33 ms later
  }

  // Stop at once: a neutral frame goes out here, then the heartbeat carries on neutral.
  function endPress() {
    if (!press) return;
    press = null;
    markPressed();
    if (connected && welcomed && haveOwnership()) sendFrame(M.neutralFrame());
  }

  function markPressed() {
    Object.keys(nodes).forEach(function (k) {
      var n = nodes[k];
      if (!n.pad) return;
      Array.prototype.forEach.call(n.pad.querySelectorAll('.arrow'), function (b) {
        b.classList.toggle('held', !!press && press.key === k && b.classList.contains('arrow-' + press.dirs[0]));
      });
    });
  }

  function updateTouchUi() {
    var now = Date.now();
    if (pgmUnlockedUntil && M.pgmLocked(pgmUnlockedUntil, now)) { pgmUnlockedUntil = 0; endPress(); }
    // A held arrow whose permission went away (seat lost, camera went on air, re-locked) stops.
    if (press) {
      var cur = M.arrowsView(press.key, plan, status, enabled, owner, pgmUnlockedUntil, now);
      if (!cur.enabled || cur.rigId !== press.rigId) endPress();
    }
    ['pvw', 'pgm'].forEach(function (k) {
      var n = nodes[k];
      if (!n || !n.pad) return;
      var v = M.arrowsView(k, plan, status, enabled, owner, pgmUnlockedUntil, now);
      n.pad.hidden = !v.show;
      n.pad.classList.toggle('dim', v.dim);
      n.pad.classList.toggle('onair', v.onAir);
      if (n.lock) {
        n.lock.hidden = !v.show;
        n.lock.textContent = M.pgmToggleText(pgmUnlockedUntil, now);
        n.lock.classList.toggle('open', !M.pgmLocked(pgmUnlockedUntil, now));
      }
    });
    var tb = M.transitionBlock(enabled, owner, status);
    el.transitionBtn.classList.toggle('dim', !!tb);
    Array.prototype.forEach.call(el.speedBtns.querySelectorAll('.seg-btn'), function (b) {
      var on = b.dataset.speed === touchSpeedName;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  setInterval(updateTouchUi, 500); // the PGM unlock counts down and re-locks

  el.speedBtns.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('.seg-btn') : null;
    if (!b) return;
    touchSpeedName = M.speedLevel(b.dataset.speed);
    store('fps-remote-speed', touchSpeedName);
    updateTouchUi();
  });

  el.transitionBtn.addEventListener('click', function () {
    var block = M.transitionBlock(enabled, owner, status);
    if (block) { showBanner(block, true, 3000); return; }
    send({ t: 'transition' }); // takes what is in PREVIEW to program; the server ignores a double tap
    setTimeout(pollStatus, SELECT_POLL_MS);
  });
  // Nothing may start a long-press menu or callout (inputs excepted).
  document.addEventListener('contextmenu', function (e) { if (!(e.target && e.target.tagName === 'INPUT')) e.preventDefault(); });

  function layout() { el.main.dataset.layout = M.layoutFor(window.innerWidth, window.innerHeight); }
  window.addEventListener('resize', layout);
  window.addEventListener('orientationchange', layout);
  layout();

  // ---- tap a camera: small pane = select it for control (needs the seat), big picture = touch focus
  function onSmallTap(pane) {
    var block = M.selectBlock(enabled, owner);
    if (block) { showBanner(block, true, 3000); return; }
    send({ t: 'preview', camera: pane.rigId }); // ATEM preview (and the controlled camera), not program
    setTimeout(pollStatus, SELECT_POLL_MS);
  }

  function apiError(r) {
    return r.json().catch(function () { return {}; }).then(function (b) { throw new Error(b.error || ('HTTP ' + r.status)); });
  }
  var REMOTE_JSON = { 'content-type': 'application/json', 'x-remote': '1' };

  function onBigTap(n, ev) {
    var pane = paneFor(n.key);
    if (!pane || !pane.sonyId) return;
    var pt = M.containedPoint(n.img.getBoundingClientRect(), n.img.naturalWidth, n.img.naturalHeight, ev.clientX, ev.clientY);
    if (!pt) return;
    if (trackModes[pane.sonyId] && trackSource(pane.sonyId)) { trackSelect(n, pane, pt); return; }
    var block = M.sonyWriteBlock(enabled);
    if (block) { showBanner(block, true, 3000); return; }
    n.cross.style.left = pt.px + 'px'; n.cross.style.top = pt.py + 'px';
    n.cross.classList.add('on');
    clearTimeout(n.crossTimer);
    n.crossTimer = setTimeout(function () { n.cross.classList.remove('on'); }, 900);
    fetch('/api/sony/cameras/' + encodeURIComponent(pane.sonyId) + '/touch', { method: 'POST', headers: REMOTE_JSON, body: JSON.stringify({ normalized: { x: pt.x, y: pt.y } }) })
      .then(function (r) { if (!r.ok) return apiError(r); })
      .catch(function (e) { showBanner('Touch focus failed: ' + (e && e.message ? e.message : 'unknown error'), true, 3500); });
  }

  // ---- person tracking (docs/tracking.md): the desk page's Focus / Track choice on the big panes. In Track mode a
  // tap on the picture picks the person to follow; Stop always works, even with remote control off.
  var trackSnap = { enabled: false, sidecar: { state: 'offline' }, sources: [] };
  var trackModes = {};         // Sony camera id -> true while that camera's taps pick a person (not saved)
  var TRACK_LABELS = { idle: 'Tap a person to track', locking: 'Locking…', tracking: 'Tracking', holding: 'Holding', lost: 'Target lost', sidecar_offline: 'Tracker offline', stale: 'Stale video', operator_override: 'Paused — stick moved', unavailable: 'Gimbal unavailable', disabled: 'Tracking is off' };

  function trackSource(sonyId) {
    if (!sonyId) return null;
    for (var i = 0; i < trackSnap.sources.length; i++) {
      var src = trackSnap.sources[i];
      if (String(src.sonyCameraId).toUpperCase() === String(sonyId).toUpperCase() && src.cameraId) return src;
    }
    return null;
  }

  function trackButton(text, cls, action) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'track-btn ' + cls; b.textContent = text;
    b.addEventListener('click', function (e) { e.stopPropagation(); action(); });
    return b;
  }

  function buildTrackBar(n, pic, head) {
    var bar = div('track-bar');
    var toggle = trackButton('Track', 'track-toggle', function () {
      var pane = paneFor(n.key);
      if (!pane || !pane.sonyId) return;
      trackModes[pane.sonyId] = !trackModes[pane.sonyId];
      updateTrackUi();
    });
    var stop = trackButton('Stop', 'track-stop', function () { var pane = paneFor(n.key); trackCommand(n, pane, 'cancel'); });
    var resume = trackButton('Resume', 'track-resume', function () { var pane = paneFor(n.key); trackCommand(n, pane, 'resume'); });
    var state = div('track-state');
    bar.appendChild(toggle); bar.appendChild(stop); bar.appendChild(resume); bar.appendChild(state);
    var box = div('track-box');
    pic.appendChild(box);
    head.insertBefore(bar, n.lock || n.menu);
    n.track = { bar: bar, toggle: toggle, stop: stop, resume: resume, state: state, box: box, said: '' };
  }

  function trackSelect(n, pane, pt) {
    var block = M.sonyWriteBlock(enabled);
    if (block) { showBanner(block, true, 3000); return; }
    var src = trackSource(pane.sonyId);
    if (!src || trackSnap.sidecar.state !== 'connected') { showBanner('Tracking is not available for this camera right now.', true, 3000); return; }
    n.cross.style.left = pt.px + 'px'; n.cross.style.top = pt.py + 'px';
    n.cross.classList.add('on');
    clearTimeout(n.crossTimer);
    n.crossTimer = setTimeout(function () { n.cross.classList.remove('on'); }, 900);
    trackCommand(n, pane, 'select', { x: pt.x, y: pt.y });
  }

  function trackCommand(n, pane, action, point) {
    var src = pane && trackSource(pane.sonyId);
    if (!src) return;
    var body = { sourceId: src.sourceId };
    if (point) { body.x = point.x; body.y = point.y; }
    // Stopping is never gated (like the emergency stop); picking and resuming need remote control on.
    var headers = action === 'cancel' ? { 'content-type': 'application/json' } : REMOTE_JSON;
    fetch('/api/tracking/' + action, { method: 'POST', headers: headers, body: JSON.stringify(body) })
      .then(function (r) { if (!r.ok) return apiError(r); })
      .then(function () {
        if (action === 'select') n.track.state.textContent = 'Locking…';
        if (action === 'cancel') { n.track.state.textContent = 'Tracking stopped'; n.track.box.classList.remove('on'); }
        pollTracking();
      })
      .catch(function (e) { showBanner('Tracking: ' + (e && e.message ? e.message : 'unavailable'), true, 3500); });
  }

  function trackBox(n, target) {
    var img = n.img, box = n.track.box;
    if (!target || img.hidden || !img.naturalWidth) { box.classList.remove('on'); return; }
    var r = img.getBoundingClientRect();
    var ratio = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
    var w = img.naturalWidth * ratio, h = img.naturalHeight * ratio;
    box.style.left = ((r.width - w) / 2 + (target.cx - target.w / 2) * w) + 'px';
    box.style.top = ((r.height - h) / 2 + (target.cy - target.h / 2) * h) + 'px';
    box.style.width = (target.w * w) + 'px';
    box.style.height = (target.h * h) + 'px';
    box.classList.add('on');
  }

  function updateTrackUi() {
    ['pvw', 'pgm'].forEach(function (k) {
      var n = nodes[k];
      if (!n || !n.track) return;
      var pane = paneFor(k);
      var src = pane && trackSource(pane.sonyId);
      var t = n.track;
      t.bar.hidden = !src;
      if (!src) { t.box.classList.remove('on'); return; }
      var on = !!trackModes[pane.sonyId];
      var ready = trackSnap.enabled && trackSnap.sidecar.state === 'connected';
      t.toggle.classList.toggle('on', on);
      t.toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
      t.toggle.disabled = !ready;
      t.stop.hidden = !src.sessionId;
      t.resume.hidden = src.state !== 'operator_override';
      var state = !trackSnap.enabled ? 'disabled' : trackSnap.sidecar.state !== 'connected' ? 'sidecar_offline' : src.state;
      var showState = on || !!src.sessionId;
      var text = showState ? (TRACK_LABELS[state] || 'Tracking unavailable') : '';
      if (t.said !== text) { t.said = text; t.state.textContent = text; }
      t.state.className = 'track-state ' + state;
      n.root.classList.toggle('tracking-mode', on);
      trackBox(n, src.sessionId ? src.target : null);
    });
  }

  var trackDelay = 1000;
  function pollTracking() {
    if (document.hidden) return;
    getJson('/api/tracking/status').then(function (t) {
      if (!t || !Array.isArray(t.sources) || !t.sidecar) throw new Error();
      trackSnap = t;
      // Poll fast only while a session is running here; slow when nothing is tracked.
      trackDelay = t.sources.some(function (src) { return src.sessionId; }) ? 250 : 1000;
    }).catch(function () { trackSnap = { enabled: false, sidecar: { state: 'offline' }, sources: [] }; trackDelay = 4000; })
      .then(updateTrackUi);
  }
  (function trackLoop() { pollTracking(); setTimeout(trackLoop, trackDelay); })();

  // ---- camera menu: the desk card's Sony settings in a sheet
  var sheetState = null;       // { id, label, pending, confirmed, views, tries, timers, holders }
  function sheetSay(text, bad) { el.sheetStatus.textContent = text; el.sheetStatus.className = 'sheet-status' + (bad ? ' bad' : ''); }
  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  function openSheet(pane) {
    if (!pane.sonyId) return;
    closeSheet();
    var st = sheetState = { id: pane.sonyId, label: pane.label, pending: {}, confirmed: {}, views: {}, tries: 0, timers: [], holders: {} };
    el.sheetTitle.textContent = pane.label + ' camera';
    el.sheetBattery.textContent = ''; el.sheetBattery.className = 'muted';
    el.sheetRows.textContent = '';
    M.PROPERTY_NAMES.forEach(function (name) {
      var row = div('sheet-row'), label = document.createElement('label');
      label.textContent = M.propertyView(name, null).label;
      var holder = div('');
      holder.style.flex = '1'; holder.style.display = 'flex';
      row.appendChild(label); row.appendChild(holder);
      el.sheetRows.appendChild(row);
      st.holders[name] = holder;
      holder.appendChild(div('ro', 'Loading…'));
    });
    var block = M.sonyWriteBlock(enabled);
    sheetSay(block ? block + ' Settings are read-only.' : 'Loading camera settings…', !!block);
    el.sheet.hidden = false; el.sheetBack.hidden = false;
    loadSheetProps(st);
    loadSheetBattery(st);
  }
  function closeSheet() {
    if (sheetState) sheetState.timers.forEach(clearTimeout);
    sheetState = null;
    el.sheet.hidden = true; el.sheetBack.hidden = true;
  }
  el.sheetClose.addEventListener('click', closeSheet);
  el.sheetBack.addEventListener('click', closeSheet);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && sheetState) closeSheet(); });

  function loadSheetBattery(st) {
    getJson('/api/sony/status').then(function (s) {
      if (sheetState !== st) return;
      var entry = M.sonyCameraEntry(s, st.id);
      var info = entry ? M.batteryInfo(entry) : { text: 'Battery unknown', level: 'idle' };
      el.sheetBattery.textContent = info.text;
      el.sheetBattery.className = 'muted lvl-' + info.level;
    }).catch(function () { /* the line just stays empty */ })
      .then(function () { if (sheetState === st) st.timers.push(setTimeout(function () { loadSheetBattery(st); }, 10000)); });
  }

  function loadSheetProps(st) {
    getJson('/api/sony/cameras/' + encodeURIComponent(st.id) + '/properties').then(function (body) {
      if (sheetState !== st) return;
      var props = (body.data && body.data.properties) || body.properties || {};
      var incomplete = false;
      M.PROPERTY_NAMES.forEach(function (name) {
        if (st.pending[name]) return; // never redraw a setting that is mid-change
        var p = props[name];
        if (!p || !Array.isArray(p.available_values)) incomplete = true;
        else st.confirmed[name] = p.current_value;
        drawProp(st, name, p);
      });
      if (incomplete && st.tries++ < 6) st.timers.push(setTimeout(function () { loadSheetProps(st); }, 2000));
      else if (incomplete) sheetSay('Some settings are not reported by this camera.', false);
      else if (!M.sonyWriteBlock(enabled)) sheetSay('Settings loaded.');
    }).catch(function () {
      if (sheetState !== st) return;
      sheetSay('Could not read camera settings yet; retrying…', true);
      if (st.tries++ < 6) st.timers.push(setTimeout(function () { loadSheetProps(st); }, 2000));
    });
  }

  function drawProp(st, name, prop) {
    var view = M.propertyView(name, prop, st.pending[name] ? st.pending[name].value : undefined);
    st.views[name] = view;
    var holder = st.holders[name];
    holder.textContent = '';
    if (view.kind !== 'select') { holder.appendChild(div('ro', view.text)); return; }
    var sel = document.createElement('select');
    sel.style.flex = '1';
    view.options.forEach(function (o, i) { var opt = document.createElement('option'); opt.value = String(i); opt.textContent = o.text; sel.appendChild(opt); });
    for (var i = 0; i < view.options.length; i++) if (view.options[i].value === view.selected) sel.value = String(i);
    sel.disabled = !!M.sonyWriteBlock(enabled);
    sel.addEventListener('change', function () { saveProp(st, name, sel); });
    holder.appendChild(sel);
  }

  // The camera applies a change a moment after accepting it and reports it later still, so the menu keeps the
  // chosen value as pending and re-reads that one setting a few times until the camera says the same (as the desk does).
  function saveProp(st, name, sel) {
    var view = st.views[name], option = view && view.options[Number(sel.value)];
    if (!option) return;
    function revert() { var c = st.confirmed[name]; for (var i = 0; i < view.options.length; i++) if (view.options[i].value === c) sel.value = String(i); }
    var block = M.sonyWriteBlock(enabled);
    if (block) { sheetSay(block, true); revert(); return; }
    var token = { value: option.value };
    st.pending[name] = token;
    sel.disabled = true;
    var url = '/api/sony/cameras/' + encodeURIComponent(st.id) + '/properties/' + name;
    var attempt = 0;
    function put() {
      return fetch(url, { method: 'PUT', headers: REMOTE_JSON, body: JSON.stringify({ value: M.sendValue(option) }) }).then(function (r) {
        if (r.status === 503 && attempt < 3) { attempt++; return sleep(400 * attempt).then(put); } // the camera is handling another action
        if (!r.ok) return apiError(r);
      });
    }
    sheetSay('Applying ' + view.label + ' ' + option.text + '…');
    put().then(function () {
      sel.disabled = !!M.sonyWriteBlock(enabled);
      var waits = [300, 500, 700, 1000, 1500], reported = null, i = 0;
      function poll() {
        if (i >= waits.length) return Promise.resolve();
        return sleep(waits[i++]).then(function () {
          if (st.pending[name] !== token || sheetState !== st) return 'gone';
          return fetch(url, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (b) { if (b) reported = M.sonyReported(b); }).catch(function () { /* keep waiting */ })
            .then(function () { return reported === option.value ? undefined : poll(); });
        });
      }
      return poll().then(function (gone) {
        if (gone === 'gone' || st.pending[name] !== token) return;
        delete st.pending[name];
        if (reported === option.value) { st.confirmed[name] = reported; sheetSay(view.label + ' saved: ' + option.text + '.'); }
        else if (reported !== null) {
          st.confirmed[name] = reported; revert();
          var shown = view.options.filter(function (o) { return o.value === reported; })[0];
          sheetSay('The camera kept ' + view.label + ' at ' + (shown ? shown.text : reported) + ' (it may not allow ' + option.text + ' right now).', true);
        } else { st.confirmed[name] = option.value; sheetSay(view.label + ' sent: ' + option.text + ' (the camera did not confirm yet).'); }
      });
    }).catch(function (e) {
      if (st.pending[name] === token) delete st.pending[name];
      sel.disabled = !!M.sonyWriteBlock(enabled);
      revert();
      sheetSay(view.label + ' save failed (' + (e && e.message ? e.message : 'unknown error') + '); restored confirmed value.', true);
    });
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
  renderMultiview();
  lockScreen();
  connect();
})();
