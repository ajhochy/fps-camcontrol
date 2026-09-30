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
  var app = { data: null, selected: null, error: null, pane: 'list', inspectorSig: '', timer: null, flash: null, messages: {} };

  function remember(key) { try { window.localStorage.setItem(STORE_KEY, key || ''); } catch (e) { /* storage may be blocked */ } }
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
  var profileLine = el('div', 'rigs-profile');
  var addButton = el('button', 'rigs-add', '+');
  addButton.type = 'button';
  addButton.disabled = true;
  addButton.title = 'Adding rigs and connections arrives in a later step';
  addButton.setAttribute('aria-label', 'Add (not available yet)');
  var listHead = el('div', 'rigs-list-head');
  listHead.appendChild(profileLine);
  listHead.appendChild(addButton);
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
  var statusBody = el('div', 'rigs-status-body');
  statusBody.setAttribute('aria-live', 'polite');
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
    var activeName = data.profiles.filter(function (p) { return p.active; }).map(function (p) { return p.label || p.name; })[0] || data.activeProfile;
    profileLine.textContent = data.legacy ? 'Legacy config (no profiles)' : 'Profile: ' + activeName;

    model.itemsOf(data).forEach(function (section) {
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
    if (body && body.rigs) { app.data = body; app.error = null; var keep = model.resolveSelection(app.data, app.selected); if (keep !== app.selected) { app.selected = keep; remember(keep); } drawNotice(); drawList(); drawStatus(); }
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
      saving = true; say('Saving…');
      try {
        var body = patchFor(control.path, payload);
        body.expectedVersion = app.data && app.data.version;
        var result = await call('PATCH', info.endpoint, body);
        if (result.ok) {
          saved = raw; say('Saved', 'ok');
          adopt(result.body);
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
    var info = app.data ? model.inspectorFor(app.data, app.selected) : null;
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
    inspectBody.appendChild(service);

    inspectBody.appendChild(el('h3', 'rigs-subheading', 'Cameras'));
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

  function drawStatus() {
    clear(statusBody);
    var status = app.data ? model.statusFor(app.data, app.selected) : null;
    if (!status) { statusBody.appendChild(el('p', 'rigs-empty', 'Live status appears here.')); return; }
    statusBody.appendChild(el('h2', 'rigs-heading', status.headline));
    var dl = el('dl', 'rigs-fields');
    status.lines.forEach(function (line) {
      dl.appendChild(el('dt', null, line.label));
      var dd = el('dd');
      dd.appendChild(tone(line.tone, line.value));
      dl.appendChild(dd);
    });
    statusBody.appendChild(dl);
    statusBody.appendChild(el('p', 'rigs-info', 'Live preview and quick actions arrive in a later step.'));
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
    var items = model.flatItems(app.data || {});
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
