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
  var app = { data: null, selected: null, error: null, pane: 'list', inspectorSig: '', timer: null };

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
    inspectBody.appendChild(el('p', 'rigs-readonly', 'Read-only for now: editing arrives in a later step.'));
    if (info.kind === 'sony-connections') { drawSonyConnections(info); return; }
    inspectBody.appendChild(fieldList(info.fields));
    if (info.advanced && info.advanced.length) {
      var details = el('details', 'rigs-advanced');
      details.appendChild(el('summary', null, 'Advanced'));
      details.appendChild(fieldList(info.advanced));
      inspectBody.appendChild(details);
    }
    (info.notes || []).forEach(function (note) { inspectBody.appendChild(el('p', 'rigs-info', note)); });
  }

  function cameraCard(title, lines, stateText, tone) {
    var card = el('div', 'rigs-camera');
    var head = el('div', 'rigs-camera-head');
    head.appendChild(el('span', 'rigs-camera-name', title));
    head.appendChild(tone === undefined ? el('span') : toneChip(tone, stateText));
    card.appendChild(head);
    lines.forEach(function (line) { if (line) card.appendChild(el('div', 'rigs-camera-line', line)); });
    return card;
  }
  function toneChip(toneName, text) { return tone(toneName, text); }

  // The Sony connections screen: the service, the named cameras, and cameras found that no device is bound to.
  function drawSonyConnections(info) {
    var service = el('div', 'rigs-service');
    service.appendChild(el('span', 'rigs-service-label', 'Sony service'));
    service.appendChild(tone(info.service.tone, info.service.text));
    if (info.service.message) service.appendChild(el('span', 'rigs-note', info.service.message));
    inspectBody.appendChild(service);

    inspectBody.appendChild(el('h3', 'rigs-subheading', 'Cameras'));
    if (!info.devices.length) inspectBody.appendChild(el('p', 'rigs-empty', 'No Sony cameras have been named yet.'));
    info.devices.forEach(function (device) {
      inspectBody.appendChild(cameraCard(device.label, [
        device.sonyCameraId ? (device.model ? device.model + ' — ' : '') + device.sonyCameraId : 'Will be bound to a camera when it is connected',
        device.usedBy.length ? 'On ' + device.usedBy.join(', ') : 'Not on a rig in this profile',
        device.message,
      ], device.stateText, device.tone));
    });

    inspectBody.appendChild(el('h3', 'rigs-subheading', 'New cameras found'));
    if (!info.found.length) inspectBody.appendChild(el('p', 'rigs-empty', 'No new cameras. Power a camera on and it appears here.'));
    info.found.forEach(function (camera) {
      inspectBody.appendChild(cameraCard(camera.model, [camera.id, 'Found on the network; not one of your named cameras yet', camera.message], camera.stateText, camera.tone));
    });
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
