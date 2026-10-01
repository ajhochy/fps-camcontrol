/*
 * Rigs screen (three columns): list | inspector | live status. The logic lives in rigsModel.js (tested in Node);
 * this file only draws it. Everything is built with textContent, never innerHTML, because names come from config.
 * See docs/ai/plans/2026-09-30-device-config-rigs-ui.md.
 */
(function () {
  'use strict';
  var model = window.RigsModel;
  var root = document.getElementById('rigs-root');
  if (!model || !root) return;

  var POLL_MS = 5000;
  var STORE_KEY = 'rigs.selected';
  var app = { data: null, selected: null, error: null, pane: 'list', inspectorSig: '', timer: null, flash: null, messages: {}, dialog: null };

  function remember(key) { if (key && key.indexOf('new:') === 0) return; try { window.localStorage.setItem(STORE_KEY, key || ''); } catch (e) { /* storage may be blocked */ } }
  function recall() { try { return window.localStorage.getItem(STORE_KEY) || null; } catch (e) { return null; } }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // ---- skeleton (built once; columns are refilled, never replaced)
  var shell = el('div', 'rigs-shell');
  shell.setAttribute('data-pane', 'list');
  var notice = el('div', 'rigs-notice');
  notice.setAttribute('role', 'status');
  notice.hidden = true;

  var listCol = el('section', 'rigs-col rigs-list');
  listCol.setAttribute('aria-label', 'Rigs and connections');
  var listBox = el('div', 'rigs-listbox');
  listBox.setAttribute('role', 'listbox');
  listBox.setAttribute('aria-label', 'Rigs and connections');
  var profileBar = el('div', 'rigs-profilebar');
  var addButton = el('button', 'rigs-add', '+');
  addButton.type = 'button';
  addButton.title = 'Add a rig or a connection';
  addButton.setAttribute('aria-label', 'Add');
  addButton.setAttribute('aria-haspopup', 'menu');
  addButton.setAttribute('aria-expanded', 'false');
  var addMenu = el('div', 'rigs-menu');
  addMenu.setAttribute('role', 'menu');
  addMenu.hidden = true;
  var listHead = el('div', 'rigs-list-head');
  listHead.appendChild(el('div', 'rigs-profile', 'Rigs & connections'));
  var addWrap = el('div', 'rigs-add-wrap');
  addWrap.appendChild(addButton);
  addWrap.appendChild(addMenu);
  listHead.appendChild(addWrap);
  listCol.appendChild(profileBar);
  listCol.appendChild(listHead);
  listCol.appendChild(listBox);

  var inspectCol = el('section', 'rigs-col rigs-inspector');
  inspectCol.setAttribute('aria-label', 'Inspector');
  var backButton = el('button', 'rigs-back', '← Back to list');
  backButton.type = 'button';
  var inspectBody = el('div', 'rigs-inspector-body');
  inspectCol.appendChild(backButton);
  inspectCol.appendChild(inspectBody);

  var statusCol = el('section', 'rigs-col rigs-status');
  statusCol.setAttribute('aria-label', 'Live status');
  // The preview box is not part of what redraws every poll, so the picture does not flicker.
  var previewBox = el('div', 'rigs-preview');
  previewBox.hidden = true;
  var previewImg = el('img', 'rigs-preview-img');
  previewImg.alt = 'Live preview';
  var previewBadge = el('span', 'rigs-preview-badge', 'STALE');
  previewBadge.hidden = true;
  var previewCaption = el('div', 'rigs-preview-caption');
  previewBox.appendChild(previewImg);
  previewBox.appendChild(previewBadge);
  var statusBody = el('div', 'rigs-status-body');
  statusBody.setAttribute('aria-live', 'polite');
  statusCol.appendChild(previewBox);
  statusCol.appendChild(previewCaption);
  statusCol.appendChild(statusBody);

  shell.appendChild(listCol);
  shell.appendChild(inspectCol);
  shell.appendChild(statusCol);
  root.appendChild(notice);
  root.appendChild(shell);

  // ---- drawing
  function tone(className, text) { return el('span', 'rigs-chip rigs-tone-' + className, text); }

  function drawList() {
    var hadFocus = listBox.contains(document.activeElement);
    var scroll = listCol.scrollTop;
    clear(listBox);
    var data = app.data;
    if (!data) return;

    model.itemsOf(data, app.selected).forEach(function (section) {
      var group = el('div', 'rigs-group');
      group.setAttribute('role', 'group');
      var headingId = 'rigs-section-' + section.id;
      var heading = el('div', 'rigs-section', section.title);
      heading.id = headingId;
      group.setAttribute('aria-labelledby', headingId);
      group.appendChild(heading);
      if (!section.items.length) group.appendChild(el('div', 'rigs-empty', section.id === 'sony' ? 'No Sony cameras yet' : 'None'));
      section.items.forEach(function (item) {
        var row = el('div', 'rigs-item' + (item.key === app.selected ? ' is-selected' : ''));
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', item.key === app.selected ? 'true' : 'false');
        row.tabIndex = item.key === app.selected ? 0 : -1;
        row.setAttribute('data-key', item.key);
        var dot = el('span', 'rigs-dot rigs-dot-' + item.dot);
        dot.setAttribute('aria-hidden', 'true');
        row.appendChild(dot);
        if (item.badge) row.appendChild(el('span', 'rigs-badge', item.badge));
        var text = el('span', 'rigs-item-text');
        text.appendChild(el('span', 'rigs-item-title', item.title));
        text.appendChild(el('span', 'rigs-item-sub', item.subtitle));
        row.appendChild(text);
        if (item.chips.length) {
          var chips = el('span', 'rigs-chips');
          item.chips.forEach(function (chip) { chips.appendChild(tone(chip.tone, chip.text)); });
          row.appendChild(chips);
        }
        group.appendChild(row);
      });
      listBox.appendChild(group);
    });
    listCol.scrollTop = scroll;
    if (hadFocus) { var selectedRow = rowFor(app.selected); if (selectedRow) selectedRow.focus(); }
  }

  function rowFor(key) {
    if (!key) return null;
    var rows = listBox.querySelectorAll('[data-key]');
    for (var i = 0; i < rows.length; i++) if (rows[i].getAttribute('data-key') === key) return rows[i];
    return null;
  }

  function fieldList(fields) {
    var dl = el('dl', 'rigs-fields');
    fields.forEach(function (f) {
      dl.appendChild(el('dt', null, f.label));
      var dd = el('dd', null, f.value);
      if (f.note) dd.appendChild(el('span', 'rigs-note', f.note));
      dl.appendChild(dd);
    });
    return dl;
  }

  // ---- talking to the server
  async function call(method, url, body) {
    var init = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    var response = await fetch(url, init);
    var json = null;
    try { json = await response.json(); } catch (e) { /* no body */ }
    return { ok: response.ok && !(json && json.ok === false), status: response.status, body: json || {} };
  }
  // ---- which gimbals the Pi offers (one bridge per port); looked up when a gimbal rig is shown
  function inspectorData() {
    return app.data ? Object.assign({}, app.data, { gimbalScan: app.gimbalScan || null }) : null;
  }
  async function scanGimbals() {
    if (app.gimbalScan && app.gimbalScan.pending) return;
    app.gimbalScan = { pending: true, gimbals: app.gimbalScan ? app.gimbalScan.gimbals : [] };
    drawInspector();
    try {
      var result = await call('GET', '/api/gimbals');
      app.gimbalScan = result.ok ? { gimbals: result.body.gimbals || [], at: Date.now() } : { gimbals: [], error: failureText(result), at: Date.now() };
    } catch (error) {
      app.gimbalScan = { gimbals: [], error: String(error && error.message ? error.message : error), at: Date.now() };
    }
    // Redraw with the results unless someone is in the middle of choosing or typing in the inspector.
    var active = document.activeElement;
    var busy = inspectBody.contains(active) && active.tagName !== 'BUTTON';
    drawInspector(!busy);
  }
  function failureText(result) {
    if (result.body && result.body.conflict) return 'The config changed since this page loaded; it has been reloaded. Please redo the change.';
    return (result.body && (result.body.error || result.body.message)) || ('Failed (HTTP ' + result.status + ')');
  }
  // 'visca.host' + value -> { visca: { host: value } }
  function patchFor(path, value) {
    var out = {}, node = out, parts = path.split('.');
    for (var i = 0; i < parts.length - 1; i++) { node[parts[i]] = {}; node = node[parts[i]]; }
    node[parts[parts.length - 1]] = value;
    return out;
  }
  function adopt(body) {
    // Edits answer with the new rig view; keep it and redraw everything but the inspector you are in.
    if (body && body.rigs) { app.data = body; app.error = null; var keep = model.resolveSelection(app.data, app.selected); if (keep !== app.selected) { app.selected = keep; remember(keep); } drawNotice(); drawProfileBar(); drawList(); drawStatus(); }
  }

  // ---- one editable control: text, number, select or toggle; saves by itself when committed
  function controlRow(info, control) {
    var row = el('div', 'rigs-row');
    var labelId = 'rigs-ctl-' + control.id.replace(/[^a-z0-9]/gi, '-');
    var label = el('label', 'rigs-row-label', control.label);
    label.setAttribute('for', labelId);
    row.appendChild(label);
    var box = el('div', 'rigs-row-control');
    var input;
    if (control.type === 'readonly') {
      box.appendChild(el('span', 'rigs-readonly-value', control.value));
      if (control.note) box.appendChild(el('span', 'rigs-note', control.note));
      row.appendChild(box);
      return row;
    }
    if (control.type === 'select') {
      input = el('select', 'cfg-input rigs-input');
      control.options.forEach(function (o) {
        var option = el('option', null, o.label);
        option.value = o.value;
        if (o.disabled) option.disabled = true;
        input.appendChild(option);
      });
      input.value = control.value === null ? '' : String(control.value);
    } else if (control.type === 'toggle') {
      input = el('input', 'rigs-check');
      input.type = 'checkbox';
      input.checked = !!control.value;
    } else {
      input = el('input', 'cfg-input rigs-input');
      input.type = control.type === 'number' ? 'number' : 'text';
      if (control.type === 'number') { if (control.min !== undefined) input.min = control.min; if (control.max !== undefined) input.max = control.max; input.step = control.step || (control.integer ? 1 : 'any'); }
      if (control.maxLength) input.maxLength = control.maxLength;
      if (control.placeholder) input.placeholder = control.placeholder;
      input.value = control.value === null || control.value === undefined ? '' : String(control.value);
    }
    input.id = labelId;
    input.setAttribute('data-control', control.id);
    box.appendChild(input);
    var status = el('span', 'rigs-inline');
    status.setAttribute('role', 'status');
    box.appendChild(status);
    if (control.note) box.appendChild(el('span', 'rigs-note', control.note));
    if (control.rescan) {
      var again = el('button', 'rigs-btn', app.gimbalScan && app.gimbalScan.pending ? 'Looking…' : 'Scan again');
      again.type = 'button';
      if (app.gimbalScan && app.gimbalScan.pending) again.disabled = true;
      again.addEventListener('click', function () { again.disabled = true; again.textContent = 'Looking…'; scanGimbals(); });
      box.appendChild(again);
    }
    row.appendChild(box);

    var saved = control.value === null || control.value === undefined ? '' : (control.type === 'toggle' ? !!control.value : String(control.value));
    var saving = false, queued = false, clearTimer = null;
    var say;
    function sayNow(text, kind) {
      status.textContent = text;
      status.className = 'rigs-inline' + (kind ? ' is-' + kind : '');
      if (clearTimer) window.clearTimeout(clearTimer);
      if (kind === 'ok') clearTimer = window.setTimeout(function () { status.textContent = ''; status.className = 'rigs-inline'; }, 2500);
    }
    say = sayNow;
    if (app.flash && app.flash.id === control.id) { sayNow(app.flash.text, 'ok'); app.flash = null; }
    function read() {
      if (control.type === 'toggle') return input.checked;
      return input.value;
    }
    function toPayload(raw) {
      if (control.type === 'toggle') return raw;
      if (control.type === 'number') {
        if (raw === '') { if (control.nullable) return null; throw new Error('Enter a number'); }
        var n = Number(raw);
        if (!isFinite(n)) throw new Error('Enter a number');
        if (control.integer && Math.floor(n) !== n) throw new Error('Enter a whole number');
        if (control.min !== undefined && n < control.min) throw new Error('At least ' + control.min);
        if (control.max !== undefined && n > control.max) throw new Error('At most ' + control.max);
        return n;
      }
      var text = String(raw).trim();
      if (text === '') { if (control.nullable) return null; if (control.required) throw new Error('Cannot be empty'); }
      if (control.type === 'select' && text === '') return null;
      return text;
    }
    async function commit() {
      var raw = read();
      if (raw === saved) return;
      if (saving) { queued = true; return; }
      var payload;
      try { payload = toPayload(raw); } catch (error) { say(error.message, 'err'); return; }
      // A change that rebuilds hardware (e.g. the controller type) asks first; cancelling puts the old value back.
      var question = control.confirm && typeof payload === 'string' ? control.confirm[payload] : null;
      if (question && !window.confirm(question)) { input.value = saved === '' ? '' : String(saved); say(''); return; }
      saving = true; say('Saving…');
      try {
        var body = control.patches ? JSON.parse(JSON.stringify(control.patches[payload] || {})) : patchFor(control.path, payload);
        body.expectedVersion = app.data && app.data.version;
        var result = await call('PATCH', info.endpoint, body);
        if (result.ok) {
          saved = raw; say('Saved', 'ok');
          adopt(result.body);
          if (control.patches || control.id === 'controller') app.gimbalScan = null; // which gimbals are free has changed: look again
          if (control.type === 'select' || control.id === 'inputId') {
            // Other controls depend on this one (camera choices); redraw unless the operator has moved on.
            var stayed = document.activeElement === input || !inspectBody.contains(document.activeElement);
            if (stayed) { app.flash = { id: control.id, text: 'Saved' }; drawInspector(true); var again = inspectBody.querySelector('[data-control="' + control.id + '"]'); if (again && document.activeElement === document.body) again.focus(); }
          }
        } else {
          say(failureText(result), 'err');
          if (control.type === 'toggle') input.checked = !!saved; else input.value = saved === '' ? '' : String(saved);
          if (result.status === 409 && result.body && result.body.conflict) { await load(); drawInspector(true); }
        }
      } catch (error) {
        say('Could not save (' + (error && error.message ? error.message : error) + ')', 'err');
        if (control.type === 'toggle') input.checked = !!saved; else input.value = saved === '' ? '' : String(saved);
      } finally {
        saving = false;
        if (queued) { queued = false; commit(); }
      }
    }
    input.addEventListener('change', commit);
    if (control.type === 'text' || control.type === 'number') {
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') { event.preventDefault(); commit(); }
        else if (event.key === 'Escape') { input.value = saved === '' ? '' : String(saved); say(''); }
      });
    }
    return row;
  }

  function controlList(info, controls) {
    var form = el('div', 'rigs-form');
    controls.forEach(function (control) { form.appendChild(controlRow(info, control)); });
    return form;
  }

  function drawInspector(force) {
    var info = app.data ? model.inspectorFor(inspectorData(), app.selected) : null;
    if (info && info.kind === 'rig' && (info.controls || []).some(function (c) { return c.rescan; }) && (!app.gimbalScan || app.gimbalScanFor !== app.selected)) {
      app.gimbalScanFor = app.selected;
      window.setTimeout(scanGimbals, 0);
    }
    var signature = JSON.stringify(info);
    // Never redraw under someone who is using the inspector; only when something actually changed.
    if (!force && signature === app.inspectorSig) return;
    if (!force && inspectBody.contains(document.activeElement)) return;
    app.inspectorSig = signature;
    clear(inspectBody);
    if (!info) { inspectBody.appendChild(el('p', 'rigs-empty', 'Select a rig or connection on the left.')); return; }
    var heading = el('h2', 'rigs-heading', info.title);
    heading.tabIndex = -1;
    heading.id = 'rigs-inspector-heading';
    inspectBody.appendChild(heading);
    if (info.kind === 'sony-connections') { drawSonyConnections(info); return; }
    if (info.kind === 'new-rig') { drawAddRig(info); return; }
    if (!info.endpoint) {
      inspectBody.appendChild(el('p', 'rigs-readonly', 'Read-only: this config has no profiles (it uses a flat cameras: list).'));
      inspectBody.appendChild(fieldList(info.fields));
    } else {
      inspectBody.appendChild(el('p', 'rigs-readonly', 'Changes save as you make them.'));
      inspectBody.appendChild(controlList(info, info.controls));
    }
    if (info.endpoint && info.advancedControls && info.advancedControls.length) {
      var details = el('details', 'rigs-advanced');
      details.appendChild(el('summary', null, 'Advanced'));
      details.appendChild(controlList(info, info.advancedControls));
      inspectBody.appendChild(details);
    } else if (info.advanced && info.advanced.length) {
      var readOnlyDetails = el('details', 'rigs-advanced');
      readOnlyDetails.appendChild(el('summary', null, 'Advanced'));
      readOnlyDetails.appendChild(fieldList(info.advanced));
      inspectBody.appendChild(readOnlyDetails);
    }
    (info.notes || []).forEach(function (note) { inspectBody.appendChild(el('p', 'rigs-info', note)); });
    if (info.removable) drawRemove(info);
  }

  // ---- the Sony connections screen
  function button(text, className, handler) {
    var b = el('button', 'rigs-btn' + (className ? ' ' + className : ''), text);
    b.type = 'button';
    b.addEventListener('click', function () { handler(b); });
    return b;
  }
  // A message shown beside an action; it survives the redraw that follows the action.
  function messageNode(key) {
    var node = el('span', 'rigs-inline');
    node.setAttribute('role', 'status');
    var kept = app.messages[key];
    if (kept) { node.textContent = kept.text; node.className = 'rigs-inline is-' + kept.kind; }
    return node;
  }
  // Run an action on a button: disable it, show progress, then ALWAYS reload the screen (a failed connect still
  // changes the camera's state) and say how it went.
  async function act(b, progress, run, success, key) {
    b.disabled = true;
    if (b.tagName === 'BUTTON') b.textContent = progress; // a dropdown must keep its options
    var result;
    try { result = await run(); } catch (error) { result = { ok: false, status: 0, body: { error: String(error && error.message ? error.message : error) } }; }
    if (result.ok) { app.messages[key] = success ? { text: success, kind: 'ok' } : null; if (result.body && result.body.rigs) adopt(result.body); }
    else app.messages[key] = { text: failureText(result), kind: 'err' };
    await load();
    drawInspector(true);
    return result.ok;
  }
  function sonyCall(method, url) { return call(method, url); }

  function cameraCard(head, lines, stateText, toneName, attribute) {
    var card = el('div', 'rigs-camera');
    if (attribute) card.setAttribute(attribute[0], attribute[1]);
    var top = el('div', 'rigs-camera-head');
    top.appendChild(head);
    top.appendChild(tone(toneName, stateText));
    card.appendChild(top);
    lines.forEach(function (line) { if (line) card.appendChild(el('div', 'rigs-camera-line', line)); });
    return card;
  }

  function nameInput(value, label) {
    var input = el('input', 'cfg-input rigs-input rigs-name');
    input.type = 'text'; input.maxLength = 64; input.value = value;
    input.setAttribute('aria-label', label);
    return input;
  }

  function drawSonyConnections(info) {
    var service = el('div', 'rigs-service');
    service.appendChild(el('span', 'rigs-service-label', 'Sony service'));
    service.appendChild(tone(info.service.tone, info.service.text));
    if (info.service.message) service.appendChild(el('span', 'rigs-note', info.service.message));
    var serviceMsg = messageNode('service');
    if (info.service.canRetry) service.appendChild(button('Retry Sony service', '', function (b) { act(b, 'Retrying…', function () { return sonyCall('POST', '/api/sony/service/retry'); }, 'Retry requested', 'service'); }));
    if (info.canRefresh) service.appendChild(button('Refresh cameras', '', function (b) { act(b, 'Scanning…', function () { return sonyCall('POST', '/api/sony/cameras/discover'); }, 'Scan finished', 'service'); }));
    service.appendChild(serviceMsg);
    if (info.service.state !== 'healthy') {
      var help = el('a', 'rigs-link', 'Sony sidecar setup');
      help.href = '/docs/sony-sidecar-setup'; help.target = '_blank'; help.rel = 'noopener';
      service.appendChild(help);
    }
    inspectBody.appendChild(service);

    inspectBody.appendChild(el('h3', 'rigs-subheading', 'Cameras'));
    inspectBody.appendChild(el('p', 'rigs-info', 'Approved cameras reconnect by themselves after an app or camera restart; a camera powered on late can take up to about 75 seconds.'));
    if (!info.devices.length) inspectBody.appendChild(el('p', 'rigs-empty', 'No Sony cameras have been named yet. Name a new camera below, or add one from "New cameras found".'));
    info.devices.forEach(function (device) {
      var key = 'device:' + device.key;
      var msg = messageNode(key);
      var name = nameInput(device.label, 'Name of this camera');
      var savedName = device.label;
      name.addEventListener('change', async function () {
        var value = name.value.trim();
        if (!value || value === savedName) { name.value = savedName; return; }
        msg.textContent = 'Saving…'; msg.className = 'rigs-inline';
        var result = await call('PATCH', '/api/sony-devices/' + encodeURIComponent(device.key), { label: value, expectedVersion: app.data && app.data.version });
        if (result.ok) { savedName = value; msg.textContent = 'Saved'; msg.className = 'rigs-inline is-ok'; app.messages[key] = { text: 'Saved', kind: 'ok' }; adopt(result.body); }
        else { name.value = savedName; msg.textContent = failureText(result); msg.className = 'rigs-inline is-err'; }
      });
      var card = cameraCard(name, [
        device.sonyCameraId ? (device.model ? device.model + ' — ' : '') + device.sonyCameraId : 'Will be bound to a camera when it is connected',
        device.usedBy.length ? 'On ' + device.usedBy.join(', ') : 'Not on a rig in this profile',
        device.message,
      ], device.stateText, device.tone, ['data-device', device.key]);
      var actions = el('div', 'rigs-actions');
      if (device.canConnect) actions.appendChild(button('Connect', 'is-primary', function (b) { act(b, 'Connecting…', function () { return sonyCall('POST', '/api/sony/cameras/' + encodeURIComponent(device.sonyCameraId) + '/connect'); }, 'Connected', key); }));
      if (device.canRetry) actions.appendChild(button('Retry connect', '', function (b) { act(b, 'Retrying…', function () { return sonyCall('POST', '/api/sony/cameras/' + encodeURIComponent(device.sonyCameraId) + '/retry'); }, 'Retry requested', key); }));
      if (device.canBind && info.found.length) {
        var bind = el('select', 'cfg-input rigs-input');
        bind.setAttribute('aria-label', 'Bind ' + device.label + ' to a camera');
        bind.appendChild(el('option', null, 'Bind to a found camera…')).value = '';
        info.found.forEach(function (camera) { var o = el('option', null, camera.model + ' — ' + camera.id); o.value = camera.id; bind.appendChild(o); });
        bind.addEventListener('change', function () {
          var chosen = bind.value; // read before the action disables the control
          if (!chosen) return;
          act(bind, 'Binding…', function () { return call('PATCH', '/api/sony-devices/' + encodeURIComponent(device.key), { sonyCameraId: chosen, expectedVersion: app.data && app.data.version }); }, 'Bound', key);
        });
        actions.appendChild(bind);
      } else if (device.canBind) {
        actions.appendChild(el('span', 'rigs-note', 'Power the camera on and choose it here once it is found.'));
      }
      if (device.canForget) actions.appendChild(button('Forget', '', function (b) {
        if (!window.confirm('Forget "' + device.label + '"? It will stop reconnecting by itself (it stays in your list of named cameras).')) return;
        act(b, 'Forgetting…', function () { return sonyCall('DELETE', '/api/sony/cameras/' + encodeURIComponent(device.sonyCameraId) + '/approval'); }, 'Forgotten', key);
      }));
      var del = button('Delete', 'is-danger', function (b) {
        if (!window.confirm('Delete the camera "' + device.label + '" from your list?')) return;
        act(b, 'Deleting…', function () { return call('DELETE', '/api/sony-devices/' + encodeURIComponent(device.key), { expectedVersion: app.data && app.data.version }); }, null, key);
      });
      if (!device.canDelete) { del.disabled = true; del.title = 'Take it off its rig first'; }
      actions.appendChild(del);
      actions.appendChild(msg);
      card.appendChild(actions);
      inspectBody.appendChild(card);
    });

    inspectBody.appendChild(el('h3', 'rigs-subheading', 'New cameras found'));
    if (!info.found.length) inspectBody.appendChild(el('p', 'rigs-empty', 'No new cameras. Power a camera on and choose Refresh cameras.'));
    info.found.forEach(function (camera) {
      var key = 'camera:' + camera.id;
      var msg = messageNode(key);
      var title = el('span', 'rigs-camera-name', camera.model);
      var card = cameraCard(title, [camera.id, camera.message], camera.stateText, camera.tone, ['data-camera', camera.id]);
      var actions = el('div', 'rigs-actions');
      var name = nameInput(camera.suggestedName, 'Name for this camera');
      actions.appendChild(name);
      actions.appendChild(button('Add as named camera', 'is-primary', function (b) {
        var value = name.value.trim();
        if (!value) { msg.textContent = 'Give it a name'; msg.className = 'rigs-inline is-err'; return; }
        act(b, 'Adding…', function () { return call('POST', '/api/sony-devices', { label: value, sonyCameraId: camera.id, expectedVersion: app.data && app.data.version }); }, 'Added', key);
      }));
      if (camera.canConnect) actions.appendChild(button('Connect', '', function (b) { act(b, 'Connecting…', function () { return sonyCall('POST', '/api/sony/cameras/' + encodeURIComponent(camera.id) + '/connect'); }, 'Connected', key); }));
      if (camera.canRetry) actions.appendChild(button('Retry connect', '', function (b) { act(b, 'Retrying…', function () { return sonyCall('POST', '/api/sony/cameras/' + encodeURIComponent(camera.id) + '/retry'); }, 'Retry requested', key); }));
      actions.appendChild(msg);
      card.appendChild(actions);
      inspectBody.appendChild(card);
    });

    inspectBody.appendChild(el('h3', 'rigs-subheading', 'Name a camera before it is connected'));
    var addRow = el('div', 'rigs-actions');
    var addName = nameInput('', 'Name for a camera that is not connected yet');
    addName.placeholder = 'e.g. FX3A — stage left';
    var addMsg = messageNode('add');
    addRow.appendChild(addName);
    addRow.appendChild(button('Add', '', function (b) {
      var value = addName.value.trim();
      if (!value) { addMsg.textContent = 'Give it a name'; addMsg.className = 'rigs-inline is-err'; return; }
      act(b, 'Adding…', function () { return call('POST', '/api/sony-devices', { label: value, expectedVersion: app.data && app.data.version }); }, 'Added', 'add');
    }));
    addRow.appendChild(addMsg);
    inspectBody.appendChild(addRow);
  }

  // ---- the profile bar: choose the active profile, see and save unsaved changes
  function dialogButton(text, className, handler) { return button(text, className, handler); }

  async function reloadAfterProfileChange() {
    app.messages = {};
    await load();
    app.dialog = null;
    drawAll(true);
    drawProfileBar(true);
  }

  function say(node, text, kind) { node.textContent = text; node.className = 'rigs-inline' + (kind ? ' is-' + kind : ''); }

  // Every dialog is described by app.dialog, so the 5 s refresh redraws it instead of dropping it.
  function drawDialog(info) {
    var d = app.dialog;
    if (!d) return null;
    var box = el('div', 'rigs-dialog');
    box.setAttribute('role', 'alertdialog');
    var failure = el('p', 'rigs-inline'); failure.setAttribute('role', 'status');
    var row = el('div', 'rigs-actions');
    var close = function () { app.dialog = null; drawProfileBar(true); };
    function run(b, progress, work, after) {
      b.disabled = true; var original = b.textContent; b.textContent = progress;
      work().then(async function (result) {
        if (result.ok) { if (result.body && result.body.rigs) adopt(result.body); if (after) await after(result); await reloadAfterProfileChange(); }
        else { b.disabled = false; b.textContent = original; say(failure, failureText(result), 'err'); if (result.status === 409 && result.body && result.body.conflict) await load(); }
      });
    }
    if (d.type === 'switch' || d.type === 'switch-unsaved') {
      var impact = model.switchImpact(app.data, d.target);
      box.setAttribute('aria-label', 'Switch to ' + impact.name);
      box.appendChild(el('h3', 'rigs-subheading', d.type === 'switch-unsaved' ? 'Unsaved changes' : 'Switch profile?'));
      if (d.type === 'switch-unsaved') {
        box.appendChild(el('p', 'rigs-info', 'This profile has changes you have not saved:'));
        var list = el('ul', 'rigs-impact'); info.changeLines.forEach(function (line) { list.appendChild(el('li', null, line)); }); box.appendChild(list);
      }
      box.appendChild(el('p', 'rigs-info', 'Switching to "' + impact.name + '" reconnects cameras and changes what the X / A / B / Y buttons select.'));
      if (impact.programWarning) { var warn = el('p', 'rigs-notice is-error', impact.programWarning); warn.setAttribute('role', 'alert'); box.appendChild(warn); }
      if (impact.lines.length) { var changes = el('ul', 'rigs-impact'); impact.lines.forEach(function (line) { changes.appendChild(el('li', null, line)); }); box.appendChild(changes); }
      else box.appendChild(el('p', 'rigs-info', 'The rigs are the same in both profiles.'));
      var switchTo = function () { return call('POST', '/api/profiles/active', { profile: d.target }); };
      if (d.type === 'switch') {
        row.appendChild(dialogButton('Switch profile', 'is-primary', function (b) { run(b, 'Switching…', switchTo); }));
      } else {
        row.appendChild(dialogButton('Save and switch', 'is-primary', function (b) {
          run(b, 'Saving…', async function () { var saved = await call('POST', '/api/profiles/save', { expectedVersion: app.data && app.data.version }); return saved.ok ? switchTo() : saved; });
        }));
        row.appendChild(dialogButton('Save as…', '', function () { app.dialog = { type: 'save-as' }; drawProfileBar(true); }));
        row.appendChild(dialogButton('Discard and switch', 'is-danger', function (b) { run(b, 'Switching…', function () { return call('POST', '/api/profiles/active', { profile: d.target, discard: true }); }); }));
      }
      row.appendChild(dialogButton('Cancel', '', close));
    } else if (d.type === 'save-as') {
      box.setAttribute('aria-label', 'Save as a new profile');
      box.appendChild(el('h3', 'rigs-subheading', 'Save as a new profile'));
      box.appendChild(el('p', 'rigs-info', 'The new profile keeps your changes and becomes the active one. "' + info.activeLabel + '" stays exactly as it was saved.'));
      var name = el('input', 'cfg-input rigs-input'); name.type = 'text'; name.maxLength = 64; name.value = d.name !== undefined ? d.name : info.saveAsSuggestion;
      name.setAttribute('aria-label', 'Name of the new profile'); name.addEventListener('input', function () { d.name = name.value; });
      box.appendChild(name);
      row.appendChild(dialogButton('Save as new profile', 'is-primary', function (b) {
        var label = name.value.trim();
        if (!label) { say(failure, 'Give the profile a name', 'err'); return; }
        run(b, 'Saving…', function () { return call('POST', '/api/profiles/save-as', { label: label, expectedVersion: app.data && app.data.version }); });
      }));
      row.appendChild(dialogButton('Cancel', '', close));
      window.setTimeout(function () { name.focus(); name.select(); }, 0);
    } else if (d.type === 'revert') {
      box.setAttribute('aria-label', 'Revert unsaved changes');
      box.appendChild(el('h3', 'rigs-subheading', 'Revert to the saved profile?'));
      box.appendChild(el('p', 'rigs-info', 'These changes will be dropped and the presets put back:'));
      var lost = el('ul', 'rigs-impact'); info.changeLines.forEach(function (line) { lost.appendChild(el('li', null, line)); }); box.appendChild(lost);
      box.appendChild(el('p', 'rigs-info', 'Names and addresses you changed stay: they are shared by every profile.'));
      row.appendChild(dialogButton('Revert changes', 'is-danger', function (b) { run(b, 'Reverting…', function () { return call('POST', '/api/profiles/revert'); }); }));
      row.appendChild(dialogButton('Keep editing', '', close));
    } else if (d.type === 'rename') {
      box.setAttribute('aria-label', 'Rename profile');
      box.appendChild(el('h3', 'rigs-subheading', 'Rename "' + info.activeLabel + '"'));
      var newName = el('input', 'cfg-input rigs-input'); newName.type = 'text'; newName.maxLength = 64; newName.value = d.name !== undefined ? d.name : info.activeLabel;
      newName.setAttribute('aria-label', 'New name'); newName.addEventListener('input', function () { d.name = newName.value; });
      box.appendChild(newName);
      row.appendChild(dialogButton('Rename', 'is-primary', function (b) {
        var label = newName.value.trim();
        if (!label) { say(failure, 'Give the profile a name', 'err'); return; }
        run(b, 'Renaming…', function () { return call('PATCH', '/api/profiles/' + encodeURIComponent(info.active), { label: label, expectedVersion: app.data && app.data.version }); });
      }));
      row.appendChild(dialogButton('Cancel', '', close));
      window.setTimeout(function () { newName.focus(); newName.select(); }, 0);
    } else if (d.type === 'delete') {
      box.setAttribute('aria-label', 'Delete a profile');
      box.appendChild(el('h3', 'rigs-subheading', 'Delete a profile'));
      var others = info.options.filter(function (o) { return o.value !== info.active; });
      if (!others.length) {
        box.appendChild(el('p', 'rigs-info', 'There is no other profile to delete. The active profile cannot be deleted; switch to another one first.'));
        row.appendChild(dialogButton('Close', '', close));
      } else {
        var which = el('select', 'cfg-input rigs-input'); which.setAttribute('aria-label', 'Profile to delete');
        others.forEach(function (o) { var option = el('option', null, o.label); option.value = o.value; which.appendChild(option); });
        if (d.which) which.value = d.which; else d.which = which.value;
        which.addEventListener('change', function () { d.which = which.value; });
        box.appendChild(which);
        box.appendChild(el('p', 'rigs-info', 'This cannot be undone. The active profile "' + info.activeLabel + '" is not affected.'));
        row.appendChild(dialogButton('Delete profile', 'is-danger', function (b) { run(b, 'Deleting…', function () { return call('DELETE', '/api/profiles/' + encodeURIComponent(d.which), { expectedVersion: app.data && app.data.version }); }); }));
        row.appendChild(dialogButton('Cancel', '', close));
      }
    }
    box.appendChild(row);
    box.appendChild(failure);
    return box;
  }

  function drawProfileBar(force) {
    if (!force && profileBar.contains(document.activeElement)) return; // never rebuild it under someone typing in it
    clear(profileBar);
    if (!app.data) return;
    var info = model.profileInfo(app.data);
    if (info.legacy || !info.options.length) { profileBar.appendChild(el('div', 'rigs-profile', 'Legacy config (no profiles)')); return; }
    var top = el('div', 'rigs-profile-row');
    var select = el('select', 'cfg-input rigs-input rigs-profile-select');
    select.setAttribute('aria-label', 'Active profile');
    info.options.forEach(function (o) { var option = el('option', null, o.label); option.value = o.value; select.appendChild(option); });
    select.value = info.active;
    select.addEventListener('change', function () {
      var target = select.value;
      select.value = info.active; // nothing changes until the operator confirms
      if (target === info.active) return;
      app.dialog = { type: info.modified ? 'switch-unsaved' : 'switch', target: target };
      drawProfileBar(true);
    });
    top.appendChild(select);
    var menu = button('⋯', 'rigs-profile-menu', function () {
      var open = profileBar.querySelector('.rigs-profile-actions');
      if (open) { open.hidden = !open.hidden; menu.setAttribute('aria-expanded', open.hidden ? 'false' : 'true'); }
    });
    menu.setAttribute('aria-label', 'Profile actions'); menu.setAttribute('aria-expanded', 'false'); menu.title = 'Rename or delete a profile';
    top.appendChild(menu);
    profileBar.appendChild(top);
    var actions = el('div', 'rigs-profile-actions'); actions.hidden = true;
    actions.appendChild(dialogButton('Rename this profile…', '', function () { app.dialog = { type: 'rename' }; drawProfileBar(true); }));
    actions.appendChild(dialogButton('Delete a profile…', '', function () { app.dialog = { type: 'delete' }; drawProfileBar(true); }));
    profileBar.appendChild(actions);

    if (info.modified) {
      var badge = el('div', 'rigs-unsaved');
      badge.appendChild(tone('warn', 'Unsaved changes'));
      badge.appendChild(el('span', 'rigs-note', 'Applied now and kept if the app restarts; "' + info.activeLabel + '" is not changed until you save.'));
      profileBar.appendChild(badge);
      var bar = el('div', 'rigs-actions');
      bar.appendChild(dialogButton('Save', 'is-primary', function (b) {
        b.disabled = true; b.textContent = 'Saving…';
        call('POST', '/api/profiles/save', { expectedVersion: app.data && app.data.version }).then(async function (result) {
          if (result.ok) { adopt(result.body); app.messages = {}; app.dialog = null; drawAll(true); drawProfileBar(true); }
          else { b.disabled = false; b.textContent = 'Save'; app.dialog = null; var m = profileBar.querySelector('.rigs-profile-msg'); if (m) say(m, failureText(result), 'err'); if (result.body && result.body.conflict) await load(); }
        });
      }));
      bar.appendChild(dialogButton('Save as…', '', function () { app.dialog = { type: 'save-as' }; drawProfileBar(true); }));
      bar.appendChild(dialogButton('Revert', 'is-danger', function () { app.dialog = { type: 'revert' }; drawProfileBar(true); }));
      var msg = el('span', 'rigs-inline rigs-profile-msg'); msg.setAttribute('role', 'status'); bar.appendChild(msg);
      profileBar.appendChild(bar);
      var details = el('details', 'rigs-changes');
      details.appendChild(el('summary', null, 'What changed (' + info.changeLines.length + ')'));
      var list = el('ul', 'rigs-impact'); info.changeLines.forEach(function (line) { list.appendChild(el('li', null, line)); });
      details.appendChild(list);
      profileBar.appendChild(details);
    }
    if (info.notice) {
      var note = el('p', 'rigs-notice', info.notice); note.setAttribute('role', 'status'); profileBar.appendChild(note);
    }
    var dialog = drawDialog(info);
    if (dialog) profileBar.appendChild(dialog);
  }

  // ---- the + menu
  function closeMenu(returnFocus) {
    addMenu.hidden = true;
    addButton.setAttribute('aria-expanded', 'false');
    if (returnFocus) addButton.focus();
  }
  function menuItem(text, hint, disabled, handler) {
    var item = el('button', 'rigs-menu-item', text);
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    if (hint) item.title = hint;
    if (disabled) { item.disabled = true; item.setAttribute('aria-disabled', 'true'); }
    else item.addEventListener('click', function () { closeMenu(false); handler(); });
    addMenu.appendChild(item);
    return item;
  }
  function openMenu() {
    clear(addMenu);
    menuItem('Rig…', 'Add a camera position', false, function () { select('new:rig', { showDetail: true, focusInspector: true }); });
    menuItem('Sony camera…', 'Name a Sony camera and connect it', false, function () {
      select('sony', { showDetail: true, focusInspector: true });
      var input = inspectBody.querySelector('.rigs-actions:last-of-type input'); if (input) input.focus();
    });
    menuItem('ATEM switcher', 'One ATEM switcher is supported', true, function () {});
    menuItem('NDI stream', 'Coming soon', true, function () {});
    addMenu.hidden = false;
    addButton.setAttribute('aria-expanded', 'true');
    var first = addMenu.querySelector('button:not(:disabled)');
    if (first) first.focus();
  }
  addButton.addEventListener('click', function () { if (addMenu.hidden) openMenu(); else closeMenu(true); });
  addMenu.addEventListener('keydown', function (event) {
    var items = [].slice.call(addMenu.querySelectorAll('button:not(:disabled)'));
    var at = items.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); if (items.length) items[(at + 1) % items.length].focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); if (items.length) items[(at - 1 + items.length) % items.length].focus(); }
  });
  document.addEventListener('click', function (event) { if (!addMenu.hidden && !addWrap.contains(event.target)) closeMenu(false); });

  // ---- adding a rig
  function labeledRow(labelText, inputNode, id) {
    var row = el('div', 'rigs-row');
    var label = el('label', 'rigs-row-label', labelText);
    if (id) label.setAttribute('for', id);
    row.appendChild(label);
    var box = el('div', 'rigs-row-control');
    box.appendChild(inputNode);
    row.appendChild(box);
    return row;
  }
  function plainInput(type, value, id, options) {
    var input = el('input', 'cfg-input rigs-input');
    input.type = type; input.value = value === undefined || value === null ? '' : String(value); input.id = id;
    if (options) for (var k in options) input.setAttribute(k, options[k]);
    return input;
  }
  function selectInput(options, value, id) {
    var select = el('select', 'cfg-input rigs-input');
    select.id = id;
    options.forEach(function (o) { var option = el('option', null, o.label); option.value = o.value; if (o.disabled) option.disabled = true; select.appendChild(option); });
    select.value = value;
    return select;
  }

  function drawAddRig(info) {
    inspectBody.appendChild(el('p', 'rigs-readonly', 'The rig is added at position ' + info.nextPosition + ', after the existing rigs.'));
    if (info.full) { inspectBody.appendChild(el('p', 'rigs-info', info.fullReason)); return; }
    var values = { mode: 'new', controller: 'vbot', port: undefined, address: undefined };
    var form = el('div', 'rigs-form');
    var message = el('p', 'rigs-inline');
    message.setAttribute('role', 'status');

    var modeBox = null;
    if (info.existing.length) {
      var mode = selectInput([{ value: 'new', label: 'New hardware' }, { value: 'existing', label: 'A controller that is already set up' }], 'new', 'rigs-add-mode');
      modeBox = labeledRow('Add', mode, 'rigs-add-mode');
      mode.addEventListener('change', function () { values.mode = mode.value; drawDynamic(); });
      form.appendChild(modeBox);
    }
    var dynamic = el('div', 'rigs-form');
    form.appendChild(dynamic);
    var wiring = el('div', 'rigs-form');
    form.appendChild(wiring);

    function drawDynamic() {
      clear(dynamic);
      if (values.mode === 'existing') {
        var existing = selectInput([{ value: '', label: 'Choose…' }].concat(info.existing), values.deviceKey || '', 'rigs-add-existing');
        existing.addEventListener('change', function () { values.deviceKey = existing.value; });
        dynamic.appendChild(labeledRow('Controller', existing, 'rigs-add-existing'));
      } else {
        var name = plainInput('text', values.label || '', 'rigs-add-name', { maxlength: 64 });
        name.addEventListener('input', function () { values.label = name.value; });
        dynamic.appendChild(labeledRow('Name', name, 'rigs-add-name'));
        var type = selectInput(info.controllers, values.controller, 'rigs-add-type');
        type.addEventListener('change', function () { values.controller = type.value; values.host = ''; values.port = undefined; values.address = undefined; drawDynamic(); });
        dynamic.appendChild(labeledRow('Controller', type, 'rigs-add-type'));
        (values.controller === 'gimbal' ? info.connection.gimbal : info.connection.visca).forEach(function (control) {
          if (control.type === 'select') {
            var choice = selectInput(control.options, values[control.id] || '', 'rigs-add-' + control.id);
            choice.addEventListener('change', function () { values[control.id] = choice.value; });
            dynamic.appendChild(labeledRow(control.label, choice, 'rigs-add-' + control.id));
            if (control.note) choice.parentNode.appendChild(el('span', 'rigs-note', control.note));
            return;
          }
          var input = plainInput(control.type === 'number' ? 'number' : 'text', values[control.id] === undefined ? control.value : values[control.id], 'rigs-add-' + control.id, control.type === 'number' ? { min: control.min, max: control.max, step: 1 } : { maxlength: control.maxLength });
          input.addEventListener('input', function () { values[control.id] = input.value; });
          dynamic.appendChild(labeledRow(control.label, input, 'rigs-add-' + control.id));
          if (values[control.id] === undefined && control.type === 'number') values[control.id] = control.value;
        });
      }
      drawWiring();
    }
    function drawWiring() {
      clear(wiring);
      var input = plainInput('number', values.inputId, 'rigs-add-input', { min: 1, max: 99, step: 1, placeholder: 'None — control only' });
      input.addEventListener('input', function () { values.inputId = input.value; });
      wiring.appendChild(labeledRow('ATEM input', input, 'rigs-add-input'));
      if (!(values.mode !== 'existing' && values.controller === 'birddog')) {
        var camera = selectInput(info.cameraOptions, values.camera || '', 'rigs-add-camera');
        camera.addEventListener('change', function () { values.camera = camera.value; });
        wiring.appendChild(labeledRow('Sony camera', camera, 'rigs-add-camera'));
      } else {
        wiring.appendChild(labeledRow('Sony camera', el('span', 'rigs-readonly-value', 'Built-in camera'), null));
      }
    }
    drawDynamic();
    inspectBody.appendChild(form);

    var actions = el('div', 'rigs-actions');
    actions.appendChild(button('Add rig', 'is-primary', async function (b) {
      var built = model.buildNewRigPayload(values);
      if (!built.ok) { message.textContent = built.error; message.className = 'rigs-inline is-err'; return; }
      built.payload.expectedVersion = app.data && app.data.version;
      b.disabled = true; b.textContent = 'Adding…'; message.textContent = ''; message.className = 'rigs-inline';
      var result = await call('POST', info.endpoint, built.payload);
      if (result.ok) {
        adopt(result.body);
        var key = 'rig:' + result.body.key;
        select(model.findItem(app.data, key) ? key : model.resolveSelection(app.data, null), { showDetail: true, focusInspector: true });
      } else {
        b.disabled = false; b.textContent = 'Add rig';
        message.textContent = failureText(result); message.className = 'rigs-inline is-err';
        if (result.status === 409 && result.body && result.body.conflict) { await load(); }
      }
    }));
    actions.appendChild(button('Cancel', '', function () { select(model.resolveSelection(app.data, null), { showDetail: false, focusRow: true }); }));
    actions.appendChild(message);
    inspectBody.appendChild(actions);
  }

  // ---- removing a rig: ask the server what would change, show it, and only then remove
  function drawRemove(info) {
    var box = el('div', 'rigs-remove');
    inspectBody.appendChild(box);
    if (!info.removable.allowed) { box.appendChild(el('p', 'rigs-info', info.removable.reason)); return; }
    var message = messageNode('remove');
    var ask = button('Remove this rig…', 'is-danger', async function (b) {
      b.disabled = true;
      var result = await call('DELETE', info.removable.endpoint, {});
      if (!(result.status === 409 && result.body && result.body.confirmationRequired)) {
        b.disabled = false; message.textContent = failureText(result); message.className = 'rigs-inline is-err'; return;
      }
      showConfirm(result.body.impact);
    });
    box.appendChild(ask);
    box.appendChild(message);
    function showConfirm(impact) {
      clear(box);
      var panel = el('div', 'rigs-confirm');
      panel.setAttribute('role', 'alertdialog');
      panel.setAttribute('aria-label', 'Confirm removing ' + impact.label);
      panel.appendChild(el('h3', 'rigs-subheading', 'Remove this rig?'));
      var list = el('ul', 'rigs-impact');
      model.impactLines(impact).forEach(function (line) { list.appendChild(el('li', null, line)); });
      panel.appendChild(list);
      panel.appendChild(el('p', 'rigs-info', 'The device stays in your inventory, so you can add it back later. The change applies now and is kept until you save the profile or revert it.'));
      var failure = el('p', 'rigs-inline'); failure.setAttribute('role', 'status');
      var row = el('div', 'rigs-actions');
      var go = button('Remove rig', 'is-danger', async function (b) {
        b.disabled = true; b.textContent = 'Removing…';
        var result = await call('DELETE', info.removable.endpoint, { confirm: true, expectedVersion: app.data && app.data.version });
        if (result.ok) {
          adopt(result.body);
          select(model.resolveSelection(app.data, null), { showDetail: false, focusRow: true });
        } else {
          b.disabled = false; b.textContent = 'Remove rig';
          failure.textContent = failureText(result); failure.className = 'rigs-inline is-err';
          if (result.status === 409 && result.body && result.body.conflict) await load();
        }
      });
      row.appendChild(go);
      row.appendChild(button('Keep it', '', function () { app.inspectorSig = ''; drawInspector(true); }));
      panel.appendChild(row);
      panel.appendChild(failure);
      box.appendChild(panel);
      go.focus();
    }
  }

  // ---- live preview (Sony live view, the same feed the Status page uses)
  var preview = { id: null, timer: null, url: null, fails: 0 };
  function stopPreview() {
    if (preview.timer) window.clearTimeout(preview.timer);
    if (preview.url) URL.revokeObjectURL(preview.url);
    preview.id = null; preview.timer = null; preview.url = null; preview.fails = 0;
    previewImg.removeAttribute('src');
    previewBox.hidden = true;
    previewBadge.hidden = true;
    previewCaption.textContent = '';
  }
  async function pollPreview(id) {
    if (preview.id !== id) return;
    if (!panelVisible()) { preview.timer = window.setTimeout(function () { pollPreview(id); }, 500); return; }
    try {
      var response = await fetch('/api/sony/cameras/' + encodeURIComponent(id) + '/live-view/frame', { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var blob = await response.blob();
      if (preview.id !== id) return;
      var next = URL.createObjectURL(blob);
      previewImg.src = next;
      if (preview.url) URL.revokeObjectURL(preview.url);
      preview.url = next; preview.fails = 0;
      previewBadge.hidden = true;
    } catch (error) {
      if (preview.id !== id) return;
      preview.fails++;
      if (preview.fails >= 3) previewBadge.hidden = false;
    }
    preview.timer = window.setTimeout(function () { pollPreview(id); }, preview.fails ? Math.min(2000, 250 * preview.fails) : 150);
  }
  async function startPreview(id, name) {
    if (preview.id === id) { previewCaption.textContent = 'Live preview — ' + name; return; }
    stopPreview();
    preview.id = id;
    previewBox.hidden = false;
    previewImg.alt = 'Live preview from ' + name;
    previewCaption.textContent = 'Live preview — ' + name;
    try { await fetch('/api/sony/cameras/' + encodeURIComponent(id) + '/live-view/start', { method: 'POST' }); } catch (error) { /* the frame poll reports trouble */ }
    pollPreview(id);
  }

  function drawStatus() {
    clear(statusBody);
    var status = app.data ? model.statusFor(app.data, app.selected) : null;
    if (!status) { stopPreview(); statusBody.appendChild(el('p', 'rigs-empty', 'Live status appears here.')); return; }
    if (status.previewCameraId) startPreview(status.previewCameraId, status.headline); else stopPreview();
    statusBody.appendChild(el('h2', 'rigs-heading', status.headline));
    var dl = el('dl', 'rigs-fields');
    status.lines.forEach(function (line) {
      dl.appendChild(el('dt', null, line.label));
      var dd = el('dd');
      dd.appendChild(tone(line.tone, line.value));
      dl.appendChild(dd);
    });
    statusBody.appendChild(dl);
    if (!status.previewCameraId && status.noPreviewReason) statusBody.appendChild(el('p', 'rigs-info', status.noPreviewReason));
    (status.actions || []).forEach(function (action) {
      var row = el('div', 'rigs-actions');
      var key = 'status:' + action.id;
      row.appendChild(button(action.label, '', function (b) {
        if (action.confirm && !window.confirm(action.confirm)) return;
        act(b, action.progress || 'Working…', function () { return call(action.method, action.url, action.body); }, action.done || null, key);
      }));
      row.appendChild(messageNode(key));
      statusBody.appendChild(row);
    });
  }

  function drawNotice() {
    notice.hidden = !(app.error || (app.data && app.data.legacy));
    notice.textContent = app.error
      ? 'Could not load rigs (' + app.error + '). Retrying…'
      : 'This config has no profiles (it uses a flat cameras: list), so rigs are shown read-only.';
    notice.className = 'rigs-notice' + (app.error ? ' is-error' : '');
  }

  function drawAll(forceInspector) {
    drawNotice();
    drawProfileBar();
    drawList();
    drawInspector(forceInspector);
    drawStatus();
  }

  // ---- selection and navigation
  function select(key, options) {
    options = options || {};
    if (!key) return;
    var changed = key !== app.selected;
    if (changed) app.messages = {};
    app.selected = key;
    remember(key);
    drawAll(changed);
    if (options.showDetail) { shell.setAttribute('data-pane', 'detail'); app.pane = 'detail'; }
    if (options.focusInspector) { var heading = document.getElementById('rigs-inspector-heading'); if (heading) heading.focus(); }
    if (options.focusRow) { var row = rowFor(key); if (row) row.focus(); }
  }

  function moveSelection(delta, absolute) {
    var items = model.flatItems(app.data || {}, app.selected);
    if (!items.length) return;
    var index = items.map(function (i) { return i.key; }).indexOf(app.selected);
    var next = absolute === 'first' ? 0 : absolute === 'last' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, index + delta));
    select(items[next].key, { focusRow: true });
  }

  listBox.addEventListener('click', function (event) {
    var row = event.target.closest && event.target.closest('[data-key]');
    if (row) select(row.getAttribute('data-key'), { showDetail: true });
  });
  listBox.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowDown') { event.preventDefault(); moveSelection(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); moveSelection(-1); }
    else if (event.key === 'Home') { event.preventDefault(); moveSelection(0, 'first'); }
    else if (event.key === 'End') { event.preventDefault(); moveSelection(0, 'last'); }
    else if (event.key === 'Enter' || event.key === ' ') {
      var row = event.target.closest && event.target.closest('[data-key]');
      if (row) { event.preventDefault(); select(row.getAttribute('data-key'), { showDetail: true, focusInspector: true }); }
    }
  });
  inspectCol.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { shell.setAttribute('data-pane', 'list'); app.pane = 'list'; var row = rowFor(app.selected); if (row) row.focus(); }
  });
  backButton.addEventListener('click', function () {
    shell.setAttribute('data-pane', 'list');
    app.pane = 'list';
    var row = rowFor(app.selected);
    if (row) row.focus();
  });

  // ---- data
  async function load() {
    try {
      var response = await fetch('/api/rigs', { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      app.data = await response.json();
      app.error = null;
      var keep = model.resolveSelection(app.data, app.selected || recall());
      var changed = keep !== app.selected;
      app.selected = keep;
      if (changed && keep) remember(keep);
      drawAll(changed);
    } catch (error) {
      app.error = String(error && error.message ? error.message : error);
      drawNotice();
    }
  }

  function panelVisible() {
    var panel = document.getElementById('tab-rigs');
    return panel && !panel.hidden && !document.hidden;
  }
  function tick() { if (panelVisible()) load(); }

  var tabButton = document.getElementById('tab-btn-rigs');
  if (tabButton) tabButton.addEventListener('click', function () { load(); });
  document.addEventListener('visibilitychange', tick);
  app.selected = recall();
  load();
  app.timer = window.setInterval(tick, POLL_MS);
})();
