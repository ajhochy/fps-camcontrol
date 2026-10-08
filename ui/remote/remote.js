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
    nameBtn: $('nameBtn'), padBtn: $('padBtn'), padDot: $('padDot'), menuBtn: $('menuBtn'), menuSheet: $('menuSheet'), menuSheetClose: $('menuSheetClose'), padSheet: $('padSheet'), padSheetClose: $('padSheetClose'), padStatus: $('padStatus'), banner: $('banner'), main: $('main'), paneEls: { pvw: $('pane-pvw'), pgm: $('pane-pgm') }, smallPanes: $('smallPanes'),
    controlInfo: $('controlInfo'), speedLine: $('speedLine'), claimBtn: $('claimBtn'),
    sheet: $('sheet'), sheetBack: $('sheetBack'), sheetTitle: $('sheetTitle'), sheetBattery: $('sheetBattery'), sheetRows: $('sheetRows'), sheetStatus: $('sheetStatus'), sheetClose: $('sheetClose'),
    releaseBtn: $('releaseBtn'), stopBtn: $('stopBtn'), hint: $('hint'), wakeHint: $('wakeHint'),
    pinRow: $('pinRow'), pinInput: $('pinInput'), pinBtn: $('pinBtn'),
    transitionBtn: $('transitionBtn'), speedBtns: $('speedBtns'), stick: $('stick'), stickKnob: $('stickKnob'), stickLabel: $('stickLabel'), dpad: $('dpad'), driveMode: $('driveMode'), zoomIn: $('zoomIn'), zoomOut: $('zoomOut'), zoomLever: $('zoomLever'), zoomLeverKnob: $('zoomLeverKnob'), zoomMode: $('zoomMode'), ltBtn: $('ltBtn'), ltState: $('ltState'),
    mapBar: $('mapBar'), mapClear: $('mapClear'), mapDone: $('mapDone'), mapBtn: $('mapBtn'), mapList: $('mapList'),
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
  var sonyStatus = null;       // GET /api/sony/status (camera connection + battery), every 10 s
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
  var stick = null;            // the joystick being held: { pointerId, rigId, x, y } (x,y: knob offset / ring radius)
  var zoom = null;             // the zoom button being held: { pointerId, rigId, dir: 'zoomIn'|'zoomOut' }
  var lever = null;            // the zoom lever being held: { pointerId, rigId, y } (y: offset / half travel, up negative)

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
    if (mapMode) { el.banner.textContent = armed ? 'Press the controller button for ' + MAP_ACTIONS[armed].label + '…' : 'Map: tap a control, then press its controller button'; el.banner.className = 'banner map'; el.banner.hidden = false; return; }
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
    var padFrame = applyPadMapping(padActive ? M.frameFromPad(padInfo.pad) : null);
    var touchFrame = null;
    if (touchSeat && stick) touchFrame = M.stickFrame(stick.x, stick.y, touchSpeedName, M.onAir(stick.rigId, status));
    else if (touchSeat && press) touchFrame = M.arrowFrame(press.dirs, touchSpeedName, M.onAir(press.rigId, status));
    if (touchSeat && zoom) { var zf = M.arrowFrame([zoom.dir], touchSpeedName, M.onAir(zoom.rigId, status)); touchFrame = touchFrame || M.neutralFrame(); touchFrame.tr = zf.tr; }
    if (touchSeat && lever) { var lf = M.leverFrame(lever.y, touchSpeedName, M.onAir(lever.rigId, status)); touchFrame = touchFrame || M.neutralFrame(); touchFrame.tr = lf.tr; }
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
    el.connText.parentNode.title = connected ? 'Connected to CamControl' + (rttMs !== null ? ', ' + rttMs + ' ms' : '') : 'Not connected to CamControl, retrying';
    el.rtt.textContent = connected && rttMs !== null ? rttMs + ' ms' : '';
    var pill = M.ownerPill(owner, connected, enabled);
    el.ownerPill.className = 'pill ' + pill.cls;
    el.ownerPill.title = pill.text; el.ownerPill.setAttribute('aria-label', pill.text);
    el.padPill.className = 'pill ' + (padInfo.kind === 'ok' ? 'pill-you' : (padInfo.kind === 'unsupported' ? 'pill-off' : 'pill-wait'));
    el.padPill.textContent = padInfo.text;
    el.padStatus.textContent = padInfo.text;
    el.padDot.className = 'dot pad-dot ' + (padInfo.kind === 'ok' ? 'dot-on' : padInfo.kind === 'unsupported' ? 'dot-off' : '');
    el.padBtn.title = padInfo.text;
    el.padStatus.className = 'pad-status ' + (padInfo.kind === 'ok' ? 'lvl-ready' : padInfo.kind === 'unsupported' ? 'lvl-down' : 'muted');

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
  function pollSony() { if (document.hidden) return; getJson('/api/sony/status').then(function (s) { sonyStatus = s; renderMultiview(); }).catch(function () { /* the panes keep the last reading */ }); }
  setInterval(pollStatus, 1000);
  setInterval(loadRigs, 15000);
  setInterval(pollSony, 10000); pollSony();
  // The live program feed (docs/program-feed.md): when it is on, the PGM pane shows the switcher's real output.
  var programStatus = null;
  function pollProgram() { if (document.hidden) return; getJson('/api/program/status').then(function (s) { programStatus = s; renderMultiview(); }).catch(function () { /* keep the last reading */ }); }
  setInterval(pollProgram, 5000); pollProgram();

  // ---- multiview: PVW and PGM large, one small pane per rig. One frame loop per Sony camera feeds every pane
  // that shows it (the large PVW/PGM and the small pane of the same camera share a single fetch).
  var plan = null;
  var fpNow = { ids: [], users: {} };
  var nodes = {};              // pane key -> DOM parts
  var smallKey = '';           // which small panes exist (rebuilt only when the rig list changes)
  var frames = {};             // Sony camera id -> { url, at, error, started, delay, running, wanted }
  var FRESH_MS = 4000;         // a picture older than this is not shown as live
  var programFrame = { url: null, at: 0, error: '', delay: 100, running: false, wanted: false }; // the program feed's loop
  function programFresh() { return !!(programFrame.url && Date.now() - programFrame.at < FRESH_MS); }

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
    var ind = div('pane-ind');
    var menu = document.createElement('button');
    menu.type = 'button'; menu.className = 'pane-menu'; menu.textContent = '⋯'; menu.setAttribute('aria-label', 'Camera menu');
    head.appendChild(ind); head.appendChild(menu);
    var foot = div('pane-foot');
    root.appendChild(pic); root.appendChild(head); root.appendChild(foot); root.appendChild(title);
    var n = { key: key, big: big, root: root, img: img, cross: cross, note: note, title: title, ind: ind, menu: menu, foot: foot, sig: '', crossTimer: null, url: '', pad: null, lock: null, track: null };
    if (big) buildTrackBar(n, pic, head);
    if (big) buildClearFocus(n, head);
    menu.addEventListener('click', function (e) { e.stopPropagation(); var pane = paneFor(key); if (pane) openSheet(pane); });
    if (big) img.addEventListener('pointerup', function (e) { onBigTap(n, e); });
    else {
      // A small pane is a button: tap, or focus it and press Enter / Space (iPad with a keyboard, VoiceOver).
      root.tabIndex = 0; root.setAttribute('role', 'button');
      root.addEventListener('click', function () { var pane = paneFor(key); if (pane && pane.rigId) onSmallTap(pane); });
      root.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); root.click(); } });
    }
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

  var SVG = 'http://www.w3.org/2000/svg';
  function icon(id, cls) {
    var s = document.createElementNS(SVG, 'svg'), u = document.createElementNS(SVG, 'use');
    s.setAttribute('class', 'ico ' + (cls || '')); u.setAttributeNS('http://www.w3.org/1999/xlink', 'href', '#' + id); u.setAttribute('href', '#' + id);
    s.appendChild(u); return s;
  }
  // Signal bars as an inline SVG (a <use> sprite can't be styled per bar): `count` lit of 3, `crossed` adds the slash.
  function barsEl(count, crossed) {
    var s = document.createElementNS(SVG, 'svg'); s.setAttribute('class', 'ico'); s.setAttribute('viewBox', '0 0 24 24');
    [[3, 15, 6], [10, 10, 11], [17, 4, 17]].forEach(function (r, i) {
      var rect = document.createElementNS(SVG, 'rect'); rect.setAttribute('x', r[0]); rect.setAttribute('y', r[1]); rect.setAttribute('width', 4); rect.setAttribute('height', r[2]); rect.setAttribute('rx', 1);
      rect.setAttribute('fill', 'currentColor'); rect.setAttribute('opacity', i < count ? '1' : '0.22'); s.appendChild(rect);
    });
    if (crossed) { var p = document.createElementNS(SVG, 'path'); p.setAttribute('d', 'M3 3l18 18'); p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '2.5'); p.setAttribute('stroke-linecap', 'round'); s.appendChild(p); }
    return s;
  }
  function batteryEl(percent) {
    var b = div('batt'), fill = div('batt-fill');
    fill.style.width = Math.max(0, Math.min(100, percent)) + '%';
    b.appendChild(fill); return b;
  }
  // One indicator: head/camera glyph, then signal bars, a battery with its percentage, or crossed bars.
  function indicatorEl(it) {
    var el = div('ind ind-' + it.level); el.title = it.text; el.setAttribute('aria-label', it.text);
    el.appendChild(icon(it.kind === 'cam' || it.kind === 'camOff' ? 'i-cam' : 'i-head'));
    if (it.kind === 'head') el.appendChild(barsEl(it.bars, it.bars === 0));
    else if (it.kind === 'camOff') el.appendChild(barsEl(0, true));
    // Unknown battery (percent null): glyph alone in the muted off colour, same for gimbal and camera.
    else if (it.percent !== null) { el.appendChild(batteryEl(it.percent)); el.appendChild(div('pct', it.percent + '%')); }
    return el;
  }

  function updatePaneText(n, pane) {
    var items = pane.rigId ? M.paneIndicators(pane.rigId, rigs, status, sonyStatus) : [];
    var sig = [pane.programFeed, pane.rigId, pane.label, pane.tags.join('+'), pane.sonyId, pane.healthLevel, pane.healthText, JSON.stringify(items)].join('|');
    if (sig === n.sig) return;
    n.sig = sig;
    n.title.textContent = pane.programFeed ? 'Program' + (pane.rigId ? ' · ' + pane.label : '') : pane.rigId ? pane.label : (n.key === 'pgm' ? 'No program camera' : 'No preview camera');
    n.ind.textContent = '';
    items.forEach(function (it) { n.ind.appendChild(indicatorEl(it)); });
    n.menu.disabled = !pane.sonyId;
    if (n.clear) n.clear.hidden = !pane.sonyId || !!pane.programFeed;
    n.foot.textContent = pane.healthText;
    n.foot.className = 'pane-foot ' + (pane.healthLevel || '');
    // Small panes: the border says what the pane is (program red, preview green); preview is always the controlled one.
    n.root.classList.toggle('is-pgm', pane.tags.indexOf('PGM') >= 0);
    n.root.classList.toggle('is-pvw', pane.tags.indexOf('PVW') >= 0);
    if (!n.big) n.root.setAttribute('aria-label', (pane.rigId ? 'Select ' + pane.label : 'Empty rig') + (pane.tags.length ? ' (' + pane.tags.join(', ') + ')' : ''));
  }

  // The picture (or the reason there is none) for one pane, from the shared frame of its Sony camera.
  function updatePaneMedia(n, pane) {
    if (pane.programFeed && programFresh()) {
      if (n.url !== programFrame.url) { n.url = programFrame.url; n.img.src = programFrame.url; }
      n.img.alt = 'Program output';
      if (n.img.hidden) n.img.hidden = false;
      n.note.textContent = ''; n.note.className = 'pane-note';
      return;
    }
    var f = pane.sonyId ? frames[pane.sonyId] : null;
    var fresh = !!(pane.wantsPicture && f && f.url && Date.now() - f.at < FRESH_MS);
    if (fresh) {
      if (n.url !== f.url) { n.url = f.url; n.img.src = f.url; }
      n.img.alt = 'Live view of ' + pane.label;
      if (n.img.hidden) n.img.hidden = false;
      // An overlay at the foot of the picture: nothing changes size when the feed drops.
      n.note.textContent = pane.programOffline ? 'Program feed offline — showing camera' : '';
      n.note.className = 'pane-note' + (pane.programOffline ? ' feed-off' : '');
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
    var programOn = !!(programStatus && programStatus.enabled);
    programFrame.wanted = programOn;
    if (programOn && !programFrame.running) runProgramLoop();
    plan = M.multiviewPlan(cameras, status, rigs, programOn ? programFresh() : null);
    var key = plan.small.map(function (p) { return p.key; }).join(',');
    if (key !== smallKey) {
      smallKey = key;
      Object.keys(nodes).forEach(function (k) { if (k !== 'pvw' && k !== 'pgm') delete nodes[k]; });
      el.smallPanes.textContent = '';
      plan.small.forEach(function (p) {
        var root = document.createElement('section');
        root.className = 'pane pane-small'; root.dataset.pane = p.key; root.dataset.map = 'rig' + (el.smallPanes.children.length + 1);
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
    return code === 503 ? 'Sony camera busy or the Sony service is off' : code === 404 ? 'Camera not sending pictures' : 'Sony camera not connected';
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

  // The program feed's frames, at its capture rate; doubling back-off on errors (the Sony loop's shape).
  function runProgramLoop() {
    var f = programFrame;
    f.running = true;
    (function step() {
      if (!f.wanted) { f.running = false; f.url = null; renderMultiview(); return; }
      if (document.hidden) { setTimeout(step, 500); return; }
      var base = Math.round(1000 / ((programStatus && programStatus.fps) || 10));
      fetch('/api/program/frame?t=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { if (r.ok) return r.blob(); throw new Error('HTTP ' + r.status); })
        .then(function (blob) {
          var old = f.url, was = programFresh();
          f.url = URL.createObjectURL(blob); f.at = Date.now(); f.error = '';
          f.delay = M.nextFrameDelay(f.delay, true, base);
          if (old) setTimeout(function () { URL.revokeObjectURL(old); }, 1500);
          if (!was) renderMultiview(); else if (plan && nodes.pgm) updatePaneMedia(nodes.pgm, plan.pgm);
        })
        .catch(function (e) { f.error = e && e.message; f.delay = M.nextFrameDelay(f.delay, false, base); })
        .then(function () { setTimeout(step, f.delay); });
    })();
  }

  // ---- touch control: the joystick in the control bar (below). `press` is kept for the shared end paths.

  // Stop at once: a neutral frame goes out here, then the heartbeat carries on neutral.
  function endPress() {
    endStick();
    endZoom();
    endLever();
    if (!press) return;
    press = null;
    Array.prototype.forEach.call(el.dpad.querySelectorAll('.arrow'), function (b) { b.classList.remove('held'); });
    if (connected && welcomed && haveOwnership()) sendFrame(M.neutralFrame());
    if (connected && welcomed && haveOwnership()) sendFrame(M.neutralFrame());
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
    var sv = M.arrowsView('pvw', plan, status, enabled, owner, pgmUnlockedUntil, now);
    if (stick && (!sv.enabled || sv.rigId !== stick.rigId)) endStick();
    if (zoom && (!sv.enabled || sv.rigId !== zoom.rigId)) endZoom();
    if (lever && (!sv.enabled || sv.rigId !== lever.rigId)) endLever();
    el.stick.classList.toggle('dim', !sv.show || sv.dim);
    el.dpad.classList.toggle('dim', !sv.show || sv.dim);
    el.zoomIn.classList.toggle('dim', !sv.show || sv.dim); el.zoomOut.classList.toggle('dim', !sv.show || sv.dim);
    el.zoomLever.classList.toggle('dim', !sv.show || sv.dim);
    el.stickLabel.textContent = sv.show && plan && plan.pvw.rigId ? plan.pvw.label : 'No preview camera';
    updateLowerThird();
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
    setSpeed(b.dataset.speed);
  });

  // ---- joystick: drives the PREVIEW camera (the same rules as the PVW arrows). The knob follows the finger inside
  // the ring; letting go, leaving the page or losing the seat recentres it and sends a neutral frame at once.
  function stickRadius() { return el.stick.clientWidth / 2; }
  function placeKnob(x, y) { var r = stickRadius() - el.stickKnob.offsetWidth / 2; el.stickKnob.style.transform = 'translate(' + (x * r) + 'px, ' + (y * r) + 'px)'; }
  function moveStick(e) {
    if (!stick || e.pointerId !== stick.pointerId) return;
    var rect = el.stick.getBoundingClientRect(), r = rect.width / 2;
    var x = (e.clientX - (rect.left + r)) / r, y = (e.clientY - (rect.top + r)) / r, len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    stick.x = x; stick.y = y;
    placeKnob(x, y);
  }
  function endStick() {
    if (!stick) return;
    stick = null;
    placeKnob(0, 0);
    el.stick.classList.remove('held');
    if (!zoom && !lever && connected && welcomed && haveOwnership()) sendFrame(M.neutralFrame());
  }
  // Permission to drive the preview camera by touch right now: { ok, rigId } or a refusal shown in the message slot.
  function previewDrive() {
    var v = M.arrowsView('pvw', plan, status, enabled, owner, pgmUnlockedUntil, Date.now());
    if (!v.show) { showBanner('No preview camera to drive.', true, 2500); return null; }
    if (!v.enabled) { showBanner(v.reason, true, 3000); return null; }
    if (!connected || !welcomed || !isVisible()) return null;
    return v;
  }
  // Zoom: hold + / −; works together with the joystick (pan/tilt on the stick, zoom on the triggers of the same frame).
  function endZoom() {
    if (!zoom) return;
    zoom = null;
    el.zoomIn.classList.remove('held'); el.zoomOut.classList.remove('held');
    if (connected && welcomed && haveOwnership()) tick();
  }
  [['zoomIn', el.zoomIn], ['zoomOut', el.zoomOut]].forEach(function (pair) {
    var dir = pair[0], b = pair[1];
    b.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button > 0) return;
      e.preventDefault();
      if (!document.hidden) focused = true;
      if (zoom || mapMode) return;
      var v = previewDrive(); if (!v) return;
      if (!stick) send({ t: 'select', camera: v.rigId, preview: false });
      zoom = { pointerId: e.pointerId, rigId: v.rigId, dir: dir };
      b.classList.add('held');
      try { b.releasePointerCapture(e.pointerId); } catch (_) { /* not captured */ } // sliding off the button ends the zoom
      tick();
    });
    ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture'].forEach(function (ev) { b.addEventListener(ev, function (e) { if (zoom && zoom.pointerId === e.pointerId) endZoom(); }); });
    ['contextmenu', 'selectstart', 'dragstart', 'gesturestart', 'click'].forEach(function (ev) { b.addEventListener(ev, function (e) { e.preventDefault(); }); });
  });
  // Zoom lever (instead of + / −, chosen in the ☰ menu): drag up to zoom in, down to zoom out, proportional; it
  // springs back to centre on release and a neutral zoom goes out at once. Works together with the joystick.
  function placeLever(y) { var half = (el.zoomLever.clientHeight - el.zoomLeverKnob.offsetHeight) / 2; el.zoomLeverKnob.style.transform = 'translateY(' + (y * half) + 'px)'; }
  function moveLever(e) {
    if (!lever || e.pointerId !== lever.pointerId) return;
    var rect = el.zoomLever.getBoundingClientRect(), half = (rect.height - el.zoomLeverKnob.offsetHeight) / 2 || 1;
    lever.y = Math.max(-1, Math.min(1, (e.clientY - (rect.top + rect.height / 2)) / half));
    placeLever(lever.y);
  }
  function endLever() {
    if (!lever) return;
    lever = null;
    placeLever(0);
    el.zoomLever.classList.remove('held');
    if (connected && welcomed && haveOwnership()) tick();
  }
  el.zoomLever.addEventListener('pointerdown', function (e) {
    if (e.button !== undefined && e.button > 0) return;
    e.preventDefault();
    if (!document.hidden) focused = true;
    if (lever || mapMode) return;
    var v = previewDrive(); if (!v) return;
    if (!stick && !press) send({ t: 'select', camera: v.rigId, preview: false });
    lever = { pointerId: e.pointerId, rigId: v.rigId, y: 0 };
    el.zoomLever.classList.add('held');
    try { el.zoomLever.setPointerCapture(e.pointerId); } catch (_) { /* keep following the finger */ }
    moveLever(e);
    tick();
  });
  el.zoomLever.addEventListener('pointermove', moveLever);
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (ev) { el.zoomLever.addEventListener(ev, function (e) { if (lever && e.pointerId === lever.pointerId) endLever(); }); });
  ['contextmenu', 'selectstart', 'dragstart', 'gesturestart'].forEach(function (ev) { el.zoomLever.addEventListener(ev, function (e) { e.preventDefault(); }); });
  var zoomMode = store('fps-remote-zoom') === 'lever' ? 'lever' : 'keys';
  function applyZoomMode() {
    el.zoomIn.hidden = el.zoomOut.hidden = zoomMode !== 'keys'; el.zoomLever.hidden = zoomMode !== 'lever';
    Array.prototype.forEach.call(el.zoomMode.querySelectorAll('.seg-btn'), function (b) { var on = b.dataset.zoom === zoomMode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
  }
  el.zoomMode.addEventListener('click', function (e) { var b = e.target.closest ? e.target.closest('.seg-btn') : null; if (!b) return; endPress(); zoomMode = b.dataset.zoom; store('fps-remote-zoom', zoomMode); applyZoomMode(); });
  applyZoomMode();
  el.stick.addEventListener('pointerdown', function (e) {
    if (e.button !== undefined && e.button > 0) return;
    e.preventDefault();
    if (!document.hidden) focused = true;
    if (press || stick || mapMode) return; // one joystick finger at a time
    var v = previewDrive(); if (!v) return;
    if (!zoom && !lever) send({ t: 'select', camera: v.rigId, preview: false });
    stick = { pointerId: e.pointerId, rigId: v.rigId, x: 0, y: 0 };
    el.stick.classList.add('held');
    try { el.stick.setPointerCapture(e.pointerId); } catch (_) { /* keep following the finger via the window */ }
    moveStick(e);
    tick();
  });
  el.stick.addEventListener('pointermove', moveStick);
  // Arrows instead of the joystick (the switch under it; remembered). Hold an arrow to move; sliding off ends it.
  var driveMode = store('fps-remote-drive') === 'arrows' ? 'arrows' : 'stick';
  function applyDriveMode() {
    el.stick.hidden = driveMode !== 'stick'; el.dpad.hidden = driveMode !== 'arrows';
    Array.prototype.forEach.call(el.driveMode.querySelectorAll('.seg-btn'), function (b) { var on = b.dataset.drive === driveMode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
  }
  el.driveMode.addEventListener('click', function (e) { var b = e.target.closest ? e.target.closest('.seg-btn') : null; if (!b) return; endPress(); driveMode = b.dataset.drive; store('fps-remote-drive', driveMode); applyDriveMode(); });
  applyDriveMode();
  Array.prototype.forEach.call(el.dpad.querySelectorAll('.arrow'), function (b) {
    b.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button > 0) return;
      e.preventDefault(); e.stopPropagation();
      if (!document.hidden) focused = true;
      if (press || stick || mapMode) return;
      var v = previewDrive(); if (!v) return;
      if (!zoom && !lever) send({ t: 'select', camera: v.rigId, preview: false });
      press = { pointerId: e.pointerId, key: 'pvw', rigId: v.rigId, dirs: [b.dataset.dir], onAir: v.onAir, startedAt: Date.now() };
      b.classList.add('held');
      try { b.releasePointerCapture(e.pointerId); } catch (_) { /* not captured */ }
      tick();
    });
    ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture'].forEach(function (ev) { b.addEventListener(ev, function (e) { if (press && press.pointerId === e.pointerId) endPress(); }); });
    ['contextmenu', 'selectstart', 'dragstart', 'gesturestart', 'click'].forEach(function (ev) { b.addEventListener(ev, function (e) { e.preventDefault(); }); });
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (ev) { el.stick.addEventListener(ev, function (e) { if (stick && e.pointerId === stick.pointerId) endStick(); }); });
  ['contextmenu', 'selectstart', 'dragstart', 'gesturestart'].forEach(function (ev) { el.stick.addEventListener(ev, function (e) { e.preventDefault(); }); });

  // ---- controller button mapping, Ableton style. Arm a control on the screen, press a pad button: that button now
  // drives the control from this page (tap controls get a click, zoom is held) and is taken out of the frames sent to
  // the desk so its desk job does not fire too. Saved per iPad (localStorage). Sticks and triggers are not remapped.
  var MAP_ACTIONS = {
    seat: { label: 'Take control / Release', tap: function () { (el.claimBtn.hidden ? el.releaseBtn : el.claimBtn).click(); } },
    transition: { label: 'TRANSITION', tap: function () { el.transitionBtn.click(); } },
    lowerThirds: { label: 'LOWER THIRD', tap: function () { el.ltBtn.click(); } },
    stop: { label: 'STOP', tap: function () { el.stopBtn.click(); } },
    zoomIn: { label: 'Zoom in', hold: 'zoomIn' },
    zoomOut: { label: 'Zoom out', hold: 'zoomOut' },
    speedSlow: { label: 'Speed: Slow', tap: function () { setSpeed('slow'); } },
    speedNormal: { label: 'Speed: Normal', tap: function () { setSpeed('normal'); } },
    speedFast: { label: 'Speed: Fast', tap: function () { setSpeed('fast'); } },
    track: { label: 'Track (preview)', tap: function () { var n = nodes.pvw; if (n && n.track && !n.track.toggle.disabled && !n.track.bar.hidden) n.track.toggle.click(); } },
  };
  for (var ri = 1; ri <= 4; ri++) (function (i) { MAP_ACTIONS['rig' + i] = { label: 'Select rig ' + i, tap: function () { var p = plan && plan.small[i - 1]; if (p && p.rigId) onSmallTap(p); } }; })(ri);
  var mapping = (function () { try { return JSON.parse(store('fps-remote-map') || '{}') || {}; } catch (_) { return {}; } })();
  var mapMode = false, armed = null, lastMask = 0, heldByPad = {};

  function mapTargets() { return Array.prototype.slice.call(document.querySelectorAll('[data-map]')); }
  function bitFor(action) { var bits = Object.keys(mapping).filter(function (k) { return mapping[k] === action; }); return bits.length ? Number(bits[0]) : null; }
  function drawMapTags() {
    mapTargets().forEach(function (t) {
      var old = t.querySelector('.map-tag'); if (old) old.remove();
      var bit = bitFor(t.dataset.map);
      if (bit === null) return;
      var tag = div('map-tag', M.buttonName(bit)); t.appendChild(tag);
    });
    el.mapList.textContent = '';
    var bits = Object.keys(mapping);
    if (!bits.length) { el.mapList.textContent = 'Nothing mapped yet.'; return; }
    bits.forEach(function (k) { var a = MAP_ACTIONS[mapping[k]]; if (a) el.mapList.appendChild(div('', M.buttonName(Number(k)) + ' → ' + a.label)); });
  }
  function saveMapping() { store('fps-remote-map', JSON.stringify(mapping)); drawMapTags(); }
  function setArmed(action) {
    armed = action;
    mapTargets().forEach(function (t) { t.classList.toggle('armed', !!action && t.dataset.map === action); });
    bannerUntil = 0; updateBanner();
  }
  function enterMapMode() { closeSheet(); mapMode = true; document.body.classList.add('mapping'); el.mapBar.hidden = false; setArmed(null); drawMapTags(); endPress(); }
  function exitMapMode() { mapMode = false; armed = null; document.body.classList.remove('mapping'); el.mapBar.hidden = true; mapTargets().forEach(function (t) { t.classList.remove('armed'); }); bannerUntil = 0; updateBanner(); }
  el.mapBtn.addEventListener('click', enterMapMode);
  el.mapDone.addEventListener('click', exitMapMode);
  el.mapClear.addEventListener('click', function () { mapping = {}; saveMapping(); setArmed(null); });
  // In map mode a tap arms the control instead of working it (capture phase, so nothing else sees the event).
  ['pointerdown', 'click'].forEach(function (ev) {
    document.addEventListener(ev, function (e) {
      if (!mapMode) return;
      if (e.target.closest && e.target.closest('#mapBar')) return;
      var t = e.target.closest ? e.target.closest('[data-map]') : null;
      e.preventDefault(); e.stopPropagation();
      if (t && ev === 'click') setArmed(t.dataset.map);
    }, true);
  });
  // Pad buttons, every tick: in map mode a rising edge binds the armed control; otherwise mapped edges drive controls.
  function applyPadMapping(frame) {
    var mask = frame ? frame.b : 0;
    var rising = M.risingBits(lastMask, mask), falling = M.fallingBits(lastMask, mask);
    lastMask = mask;
    if (mapMode) {
      if (armed && rising.length) {
        Object.keys(mapping).forEach(function (k) { if (mapping[k] === armed) delete mapping[k]; });
        mapping[rising[0]] = armed; saveMapping();
        showBanner(M.buttonName(rising[0]) + ' → ' + MAP_ACTIONS[armed].label, false, 2500);
        setArmed(null);
      }
      return frame ? { a: frame.a, tr: frame.tr, b: 0 } : frame; // nothing reaches the desk while mapping
    }
    rising.forEach(function (bit) {
      var a = MAP_ACTIONS[mapping[bit]]; if (!a) return;
      if (a.tap) a.tap();
      else if (a.hold && !zoom) { var v = previewDrive(); if (!v) return; if (!stick) send({ t: 'select', camera: v.rigId, preview: false }); zoom = { pointerId: 'pad' + bit, rigId: v.rigId, dir: a.hold }; heldByPad[bit] = true; el[a.hold].classList.add('held'); }
    });
    falling.forEach(function (bit) { if (heldByPad[bit]) { delete heldByPad[bit]; if (zoom && zoom.pointerId === 'pad' + bit) endZoom(); } });
    return frame ? { a: frame.a, tr: frame.tr, b: M.stripMapped(frame.b, mapping) } : frame;
  }
  function setSpeed(name) { touchSpeedName = M.speedLevel(name); store('fps-remote-speed', touchSpeedName); updateTouchUi(); }
  drawMapTags();

  el.ltBtn.addEventListener('click', function () {
    var block = M.sonyWriteBlock(enabled); // remote control on is enough; slides do not need the camera seat
    if (block) { showBanner(block, true, 3000); return; }
    send({ t: 'lowerThirds' }); // toggles the DSK; the 1 Hz status says what it is now
    setTimeout(pollStatus, SELECT_POLL_MS);
  });
  function updateLowerThird() {
    var on = !!(status && status.lowerThirdsActive);
    el.ltBtn.classList.toggle('on', on); el.ltBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    el.ltState.textContent = on ? 'ON AIR' : 'OFF';
    el.ltBtn.classList.toggle('dim', !(status && status.atemConnected));
  }
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
    if (!pane || !pane.sonyId || pane.programFeed) return; // the program picture is not the camera's: no touch focus
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

  // ---- clear focus: the cancel button on the camera's own screen (forget the touch point, back to the normal area)
  function buildClearFocus(n, head) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'track-btn clear-focus'; b.textContent = '\u2715 Focus';
    b.setAttribute('aria-label', 'Clear focus point'); b.hidden = true;
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      if (mapMode) return;
      var pane = paneFor(n.key);
      if (!pane || !pane.sonyId || pane.programFeed) return;
      var block = M.sonyWriteBlock(enabled);
      if (block) { showBanner(block, true, 3000); return; }
      clearTimeout(n.crossTimer);
      n.cross.classList.remove('on');
      fetch('/api/sony/cameras/' + encodeURIComponent(pane.sonyId) + '/touch-cancel', { method: 'POST', headers: REMOTE_JSON })
        .then(function (r) {
          // 409: the camera has nothing to clear (no point set, or manual focus). Not an error.
          if (r.status === 409) return r.json().catch(function () { return {}; }).then(function (b) { showBanner(b.error || 'Nothing to clear', false, 3000); });
          if (!r.ok) return apiError(r);
          showBanner('Focus point cleared', false, 1500);
        })
        .catch(function (err) { showBanner('Clear focus failed: ' + (err && err.message ? err.message : 'unknown error'), true, 3500); });
    });
    head.insertBefore(b, (n.track && n.track.bar) || n.lock || n.menu);
    n.clear = b;
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
      if (mapMode) return;
      var pane = paneFor(n.key);
      if (!pane || !pane.sonyId) return;
      trackModes[pane.sonyId] = !trackModes[pane.sonyId];
      updateTrackUi();
    });
    var stop = trackButton('Stop', 'track-stop', function () { var pane = paneFor(n.key); trackCommand(n, pane, 'cancel'); });
    var resume = trackButton('Resume', 'track-resume', function () { var pane = paneFor(n.key); trackCommand(n, pane, 'resume'); });
    var hold = trackButton('Hold this framing', 'track-hold', function () { var pane = paneFor(n.key); trackCommand(n, pane, 'hold-framing'); });
    var state = div('track-state');
    state.id = 'track-status-' + n.key;
    bar.setAttribute('role', 'group');bar.setAttribute('aria-label', n.key === 'pvw' ? 'Preview tracking' : 'Program tracking');
    hold.setAttribute('aria-describedby', state.id);resume.setAttribute('aria-describedby', state.id);
    state.setAttribute('role', 'status'); state.setAttribute('aria-live', 'polite');
    bar.appendChild(toggle); bar.appendChild(stop); bar.appendChild(resume); bar.appendChild(hold); bar.appendChild(state);
    var box = div('track-box');
    pic.appendChild(box);
    head.insertBefore(bar, n.lock || n.menu);
    if (n.key === 'pvw') toggle.dataset.map = 'track';
    n.track = { bar: bar, toggle: toggle, stop: stop, resume: resume, hold: hold, state: state, box: box, said: '' };
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
    if (action === 'hold-framing' || action === 'resume') {
      var block = M.sonyWriteBlock(enabled);
      if (block) { showBanner(block, true, 3000); return; }
    }
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
    var announced = new Set();
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
      t.hold.disabled = !ready || !src.canHoldFraming || !!M.sonyWriteBlock(enabled);
      t.hold.title = M.sonyWriteBlock(enabled) || src.holdFramingReason || 'Capture the current placement and resume tracking';
       t.resume.disabled = !ready || src.canHoldFraming === false || !!M.sonyWriteBlock(enabled);
      var state = !trackSnap.enabled ? 'disabled' : trackSnap.sidecar.state !== 'connected' ? 'sidecar_offline' : src.state;
      var showState = on || !!src.sessionId;
       var text = TRACK_LABELS[state] || 'Tracking unavailable';
       if (state === 'idle') text = 'Choose a person in Track mode';
      if (showState && src.framingHeld) text += ' — Framing held';
       if (state === 'operator_override' && src.holdFramingReason) text += ' — ' + src.holdFramingReason;
       if (M.sonyWriteBlock(enabled)) text += ' — ' + M.sonyWriteBlock(enabled);
       else if (state === 'operator_override' && !t.hold.disabled) text += ' — Hold this framing captures placement and resumes; Resume preserves placement.';
       if (on) text += ' — Select a person: tap the preview.';
       var duplicate = announced.has(src.sourceId);announced.add(src.sourceId);
       t.state.setAttribute('aria-live', duplicate ? 'off' : 'polite');t.state.setAttribute('role', duplicate ? 'note' : 'status');
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
    }).catch(function () { trackSnap.sidecar = { state: 'offline' };trackSnap.sources = trackSnap.sources.map(function (src) { return Object.assign({}, src, { canHoldFraming: false, target: null, framingHeld: false }); });trackDelay = 4000; })
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
    var st = sheetState = { id: pane.sonyId, label: pane.label, pending: {}, confirmed: {}, views: {}, props: {}, tries: 0, timers: [], holders: {} };
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
    var src = trackSource(pane.sonyId);
    if (src) addSpeedRow(st, src);
    var block = M.sonyWriteBlock(enabled);
    sheetSay(block ? block + ' Settings are read-only.' : 'Loading camera settings…', !!block);
    el.sheet.hidden = false; el.sheetBack.hidden = false;
    loadSheetProps(st);
    loadSheetBattery(st);
  }
  // Track speed: how fast the tracker may move this rig (0.05..1 of full speed). Saved to devices.yaml and applied at
  // once; a running track session picks it up on its next velocity. The slider is per rig, not per Sony camera.
  function addSpeedRow(st, src) {
    var row = div('sheet-row'), label = document.createElement('label'), holder = div('speed-holder');
    label.textContent = 'Track speed';
    var slider = document.createElement('input'), value = div('speed-value');
    slider.type = 'range'; slider.min = '5'; slider.max = '100'; slider.step = '5'; slider.className = 'speed-slider';
    slider.setAttribute('aria-label', 'Track speed for ' + st.label);
    var pct = Math.round((typeof src.maxSpeed === 'number' ? src.maxSpeed : 0.35) * 100);
    slider.value = String(pct); value.textContent = pct + '%';
    slider.addEventListener('input', function () { value.textContent = slider.value + '%'; });
    slider.addEventListener('change', function () {
      var block = M.sonyWriteBlock(enabled);
      if (block) { sheetSay(block, true); slider.value = String(pct); value.textContent = pct + '%'; return; }
      slider.disabled = true;
      fetch('/api/tracking/sources/' + encodeURIComponent(src.sourceId) + '/speed', { method: 'PUT', headers: REMOTE_JSON, body: JSON.stringify({ value: Number(slider.value) / 100 }) })
        .then(function (r) { if (!r.ok) return apiError(r); pct = Number(slider.value); sheetSay('Track speed ' + pct + '% saved.'); pollTracking(); })
        .catch(function (e) { slider.value = String(pct); value.textContent = pct + '%'; sheetSay('Track speed: ' + (e && e.message ? e.message : 'could not save'), true); })
        .then(function () { slider.disabled = false; });
    });
    holder.appendChild(slider); holder.appendChild(value);
    row.appendChild(label); row.appendChild(holder);
    el.sheetRows.appendChild(row);
  }
  function closeSheet() {
    if (sheetState) sheetState.timers.forEach(clearTimeout);
    sheetState = null;
    el.sheet.hidden = true; el.padSheet.hidden = true; el.menuSheet.hidden = true; el.sheetBack.hidden = true;
  }
  el.menuBtn.addEventListener('click', function () { closeSheet(); el.menuSheet.hidden = false; el.sheetBack.hidden = false; loadProgramRow(); });

  // Program feed row (This iPad sheet): Camera = the PGM pane shows the program camera; Live = the capture card.
  var programEls = { mode: $('programMode'), row: $('programDeviceRow'), select: $('programDevice'), note: $('programNote') };
  var programWantLive = false;
  function programSay(text, bad) { programEls.note.textContent = text; programEls.note.className = 'muted small' + (bad ? ' bad' : ''); }
  function showProgramMode(live) {
    programWantLive = live;
    Array.prototype.forEach.call(programEls.mode.querySelectorAll('.seg-btn'), function (b) { var on = (b.dataset.program === 'live') === live; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    programEls.row.hidden = !live;
  }
  function loadProgramRow() {
    Promise.all([getJson('/api/program/status'), getJson('/api/program/devices')]).then(function (r) {
      var st = r[0], devices = r[1].devices || [];
      programStatus = st;
      showProgramMode(!!st.enabled);
      programEls.select.textContent = '';
      var none = document.createElement('option'); none.value = ''; none.textContent = devices.length ? 'Choose a capture device…' : 'No capture devices found';
      programEls.select.appendChild(none);
      devices.forEach(function (d) { var o = document.createElement('option'); o.value = d.name; o.dataset.kind = d.kind || ''; o.textContent = d.name + (d.kind === 'decklink' ? ' (Blackmagic)' : ''); programEls.select.appendChild(o); });
      if (st.device && !devices.some(function (d) { return d.name === st.device; })) { var o = document.createElement('option'); o.value = st.device; o.textContent = st.device + ' (not found)'; programEls.select.appendChild(o); }
      programEls.select.value = st.device || '';
      programSay(st.enabled ? (st.error ? 'Program feed: ' + st.error : st.running ? 'Live program feed from ' + st.device + '.' : 'Program feed starting…') : 'The PGM pane shows the program camera.', !!(st.enabled && st.error));
    }).catch(function () { programSay('Could not read the program feed settings.', true); });
  }
  function saveProgram(body) {
    var block = M.sonyWriteBlock(enabled);
    if (block) { programSay(block, true); loadProgramRow(); return; }
    programSay('Saving…');
    fetch('/api/program', { method: 'PUT', headers: REMOTE_JSON, body: JSON.stringify(body) })
      .then(function (r) { if (!r.ok) return apiError(r); return r.json(); })
      .then(function (st) { programStatus = st; renderMultiview(); loadProgramRow(); })
      .catch(function (e) { programSay('Program feed: ' + (e && e.message ? e.message : 'could not save'), true); loadProgramRow(); });
  }
  function selectedProgram() { var o = programEls.select.selectedOptions[0]; return { input: programEls.select.value, kind: o && o.dataset.kind ? o.dataset.kind : null }; }
  programEls.mode.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('.seg-btn') : null; if (!b) return;
    var live = b.dataset.program === 'live';
    if (!live) { showProgramMode(false); saveProgram({ enabled: false }); return; }
    showProgramMode(true);
    var pick = selectedProgram();
    if (pick.input) saveProgram({ enabled: true, input: pick.input, kind: pick.kind });
    else programSay('Choose the capture device the switcher\'s program output is plugged into.');
  });
  programEls.select.addEventListener('change', function () {
    var pick = selectedProgram();
    if (programWantLive && pick.input) saveProgram({ enabled: true, input: pick.input, kind: pick.kind });
  });
  el.menuSheetClose.addEventListener('click', closeSheet);
  // The controller screen: pairing steps and what the page currently sees. Same backdrop and close paths as the camera menu.
  el.padBtn.addEventListener('click', function () { closeSheet(); el.padSheet.hidden = false; el.sheetBack.hidden = false; });
  el.padSheetClose.addEventListener('click', closeSheet);
  el.sheetClose.addEventListener('click', closeSheet);
  el.sheetBack.addEventListener('click', closeSheet);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });

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

  // Which settings are a slider over the camera's own list of steps (f-stops, shutter speeds, ISO values); the rest
  // are a row of buttons. An "auto" entry (ISO AUTO, AWB) becomes a button next to the slider / in the row.
  var SLIDER_PROPS = { 'aperture': true, 'shutter-speed': true, 'iso': true };
  function isAuto(o) { return /\bauto\b|^awb$/i.test(o.text); }

  function drawProp(st, name, prop) {
    st.props[name] = prop;
    var view = M.propertyView(name, prop, st.pending[name] ? st.pending[name].value : undefined);
    st.views[name] = view;
    var holder = st.holders[name];
    holder.textContent = '';
    if (view.kind !== 'select') { holder.appendChild(div('ro', view.text)); return; }
    var box = div('prop' + (st.pending[name] || M.sonyWriteBlock(enabled) ? ' busy' : ''));
    var cur = -1;
    for (var i = 0; i < view.options.length; i++) if (view.options[i].value === view.selected) cur = i;
    var pick = function (idx) { return function () { saveProp(st, name, idx); }; };
    if (SLIDER_PROPS[name]) {
      var steps = [], autoIdx = -1;
      view.options.forEach(function (o, i) { if (isAuto(o)) autoIdx = i; else steps.push(i); });
      var row = div('prop-slider'), slider = document.createElement('input'), value = div('prop-value');
      slider.type = 'range'; slider.min = '0'; slider.max = String(Math.max(0, steps.length - 1)); slider.step = '1';
      slider.setAttribute('aria-label', view.label);
      var pos = steps.indexOf(cur);
      slider.value = String(pos >= 0 ? pos : 0);
      value.textContent = cur >= 0 ? view.options[cur].text : '—';
      slider.addEventListener('input', function () { value.textContent = view.options[steps[Number(slider.value)]].text; });
      slider.addEventListener('change', function () { saveProp(st, name, steps[Number(slider.value)]); });
      row.appendChild(slider); row.appendChild(value);
      if (autoIdx >= 0) {
        var auto = document.createElement('button'); auto.type = 'button'; auto.className = 'opt-btn auto' + (cur === autoIdx ? ' on' : ''); auto.textContent = view.options[autoIdx].text;
        auto.addEventListener('click', pick(autoIdx)); row.appendChild(auto);
      }
      box.appendChild(row);
    } else {
      var opts = div('opt-row');
      view.options.forEach(function (o, i) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'opt-btn' + (i === cur ? ' on' : '') + (isAuto(o) ? ' auto' : ''); b.textContent = o.text;
        b.addEventListener('click', pick(i)); opts.appendChild(b);
      });
      box.appendChild(opts);
    }
    holder.appendChild(box);
  }

  // The camera applies a change a moment after accepting it and reports it later still, so the menu keeps the
  // chosen value as pending and re-reads that one setting a few times until the camera says the same (as the desk does).
  function saveProp(st, name, idx) {
    var view = st.views[name], option = view && view.options[idx];
    if (!option || option.value === view.selected) return;
    function redraw() { if (sheetState === st) drawProp(st, name, st.props[name]); }
    var block = M.sonyWriteBlock(enabled);
    if (block) { sheetSay(block, true); redraw(); return; }
    var token = { value: option.value };
    st.pending[name] = token;
    redraw(); // shows the chosen value, greyed, until the camera confirms
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
          st.confirmed[name] = reported;
          var shown = view.options.filter(function (o) { return o.value === reported; })[0];
          sheetSay('The camera kept ' + view.label + ' at ' + (shown ? shown.text : reported) + ' (it may not allow ' + option.text + ' right now).', true);
        } else { st.confirmed[name] = option.value; sheetSay(view.label + ' sent: ' + option.text + ' (the camera did not confirm yet).'); }
        if (st.props[name]) st.props[name].current_value = st.confirmed[name];
        redraw();
      });
    }).catch(function (e) {
      if (st.pending[name] === token) delete st.pending[name];
      redraw();
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
