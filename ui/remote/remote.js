// Minimal remote: polls the first gamepad and streams frames (replaced by the full page in issue #4).
(function () {
  var ws = null, seq = 0, timer = null;
  var statusEl = document.getElementById('status');
  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  function frame() {
    var pads = navigator.getGamepads ? navigator.getGamepads() : [];
    var pad = null;
    for (var i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected && pads[i].mapping === 'standard') { pad = pads[i]; break; }
    if (!pad) return;
    var b = 0;
    for (var k = 0; k < 16; k++) if (k !== 6 && k !== 7 && pad.buttons[k] && pad.buttons[k].pressed) b |= (1 << k);
    send({ t: 'in', s: ++seq, a: [pad.axes[0], pad.axes[1], pad.axes[2], pad.axes[3]], tr: [pad.buttons[6].value, pad.buttons[7].value], b: b });
  }
  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/remote-controller');
    ws.onopen = function () { send({ t: 'hello', v: 1, name: 'iPad' }); timer = setInterval(frame, 33); statusEl.textContent = 'Connected'; };
    ws.onclose = function () { clearInterval(timer); statusEl.textContent = 'Disconnected'; setTimeout(connect, 1000); };
    ws.onmessage = function (e) { try { var m = JSON.parse(e.data); if (m.t === 'owner') statusEl.textContent = m.you ? 'You have control' : 'Desk has control'; } catch (_) {} };
  }
  document.getElementById('claim').onclick = function () { send({ t: 'claim' }); };
  document.getElementById('stop').onclick = function () { send({ t: 'stop' }); };
  connect();
})();
