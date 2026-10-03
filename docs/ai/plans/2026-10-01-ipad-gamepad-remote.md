# Plan: iPad Gamepad Remote (Xbox controller on iPad → CamControl over the network)

Branch suggestion: `feat/ipad-gamepad-remote` (off `main` once the current Sony/gimbal branch lands; otherwise off `feat/sony-gimbal-link-and-link-watch`).

## 0. What exists today (findings)

- Input path: `src/index.ts` → `ControllerSupervisor` `'data'` → `normalizeHIDReport()` → `machine.updateInput(input)` and `eventBus.emit('controllerData', {type:'rawHidData', raw, normalized})`. `startControllerLoop` ticks the machine at 60 Hz.
- `NormalizedInput` (`src/input/normalizers.ts`): `axes` {leftStickX, leftStickY, rightStickX, rightStickY} in −1..1; `triggers` {leftTrigger, rightTrigger} in 0..1; `buttons` by **name**: A B X Y LB RB LS RS dpadUp dpadDown dpadLeft dpadRight back start. **Stick up = −1** (xbox-bluetooth.yaml is uint16 0..65535, so normalized top = −1). The machine computes `tilt = -rightY`.
- `ControlStateMachine.tick()` hardcodes button names (it does **not** read `config/mappings.yaml`; that file is only served/edited by `/api/mappings`). So the remote only has to produce the same named `NormalizedInput`.
- Safety already in the machine: if `!state.controllerConnected` or `Date.now() - lastInputTs > INPUT_STALE_MS (250)` it sends `stop()` + `setZoom(0)` once and returns. Gimbals also have the Pi bridge's 250 ms watchdog. `back` rising edge → `emergencyStopAll`.
- `/ws/controller-input` is **outbound only**: the server broadcasts raw HID hex + normalized input at 10 Hz to the Controller/calibration tab (`statusServer.ts` ~L918–946; client at ~L2775). It ignores client messages. **Do not reuse it for input**; add a new path `/ws/remote-controller` in the same `server.on('upgrade')` router (noServer pattern, see comment ~L915).
- Static files under `ui/` are served at `/ui` (no-cache), e.g. `ui/rigs/rigs.js`. Live preview: `GET /api/sony/cameras/:id/live-view/frame` (live view runs only while frames are being requested). Rig→Sony camera mapping is in `GET /api/rigs` (`rig.camera` → `config.devices[...].sonyCameraId`). Health: `state.health.rigs/cameras` in `GET /api/status`.
- No HTTP emergency-stop endpoint exists today.
- Sandbox (`src/testing/sandbox/sandbox.ts`) runs the app as a child with fakes in-process; `VirtualDjiBridge` exposes `velPan`/`velTilt` and a `log` array (`"moveVelocity {...}"`, `"stop {}"`, `"safety-stop"`). `FakeViscaCamera` only counts `commands`.

## 1. External research (summary, with sources)

- **Secure context: NOT required.** The W3C spec dropped `[SecureContext]` for the Gamepad API (spec PR #194, Feb 2024); Firefox 125 removed its gate "in agreement with WebKit"; WebKit and Chromium only ever shipped a console warning. So `navigator.getGamepads()` works on `http://192.168.x.x:8080` in iPad Safari. Sources: [Mozilla intent-to-ship](https://www.mail-archive.com/dev-platform@mozilla.org/msg01105.html), [w3c/gamepad PR #120 history](https://github.com/w3c/gamepad/pull/120), [Gamepad spec](https://w3c.github.io/gamepad/).
- **But Screen Wake Lock (`navigator.wakeLock`) DOES require HTTPS** and is released whenever the page is hidden ([MDN Screen Wake Lock](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API)). Without it the iPad auto-locks mid-service unless Auto-Lock is set to Never. This is the real reason to offer HTTPS.
- **User gesture:** `getGamepads()` returns empty until a button is pressed/axis moved after page load ([spec](https://w3c.github.io/gamepad/), [freeCodeCamp guide](https://www.freecodecamp.org/news/gamepad-api-javascript-guide/)). Show "Press any button on the controller".
- **Polling:** no input events; poll `getGamepads()` each tick. rAF is paused in hidden tabs and halved in Low Power Mode on iOS ([testmu rAF notes](https://www.testmuai.com/learning-hub/requestanimationframe-browser-support/)). Use `setInterval(…, 33)` for the send loop; Safari suspends JS when hidden/locked, so the **server-side dead-man is the real guarantee**.
- **Standard mapping** (`pad.mapping === 'standard'`): buttons 0 A(bottom) 1 B(right) 2 X(left) 3 Y(top) 4 LB 5 RB 6 LT(analog `.value`) 7 RT 8 View/Back 9 Menu/Start 10 LS 11 RS 12–15 dpad U/D/L/R 16 Guide; axes 0 LX 1 LY 2 RX 3 RY, up = −1 ([Adam Jones mapping](https://adamjones.me/blog/gamepad-mapping/), [MDN mapping](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad/mapping)). Safari ships standard mapping for Xbox/PS/Switch Pro.
- **Guide/Home button is taken by iPadOS** (opens Games / Game Overlay; configurable in Settings ▸ General ▸ Game Controller ▸ Home Button) — never map anything to button 16 ([Apple Support](https://support.apple.com/en-us/111099), [Apple Discussions](https://discussions.apple.com/thread/256151051)). Newer iPadOS lets a controller navigate the system UI ([OSXDaily](https://osxdaily.com/2026/04/16/control-your-ipad-launch-apps-with-a-game-controller/)) — must be checked on the real iPad that A/dpad are delivered to Safari and not consumed.
- **Tailscale HTTPS:** enable MagicDNS + HTTPS Certificates in the admin console (machine name goes to public CT logs), certs are `machine.tailnet.ts.net`, `tailscale cert` certs expire in 90 days and need manual renewal ([KB 1153](https://tailscale.com/kb/1153/enabling-https)); `tailscale serve --bg --https=443 http://127.0.0.1:8080` terminates TLS with an auto-provisioned cert ([KB 1242](https://tailscale.com/kb/1242/tailscale-serve)); Serve adds `Tailscale-User-Login`/`-Name` headers and strips spoofed ones ([Tailscale Serve docs](https://tailscale.com/docs/features/tailscale-serve)).
- **Prior art:** [Panevo](https://github.com/dutchdronesquad/panevo) (browser Gamepad API → VISCA, deadman-gated motion), [PTZ-Control-Web](https://github.com/CultoemOff/PTZ-Control-Web), [PTZJoystickControl](https://github.com/AronHetLam/PTZJoystickControl), [jeffmikels/ptz-server](https://github.com/jeffmikels/ptz-server), Companion [gamepad-io](https://bitfocus.io/connections/josephadams-gamepadio). Common patterns: deadman/enable gating, stop on disconnect, deadzones, fixed-rate send.

## 2. Design

### 2.1 HTTPS decision
- **v1 runs on plain http** (`http://<mac-lan-ip>:8080/remote` or `http://videos-mac-studio:8080/remote` over Tailscale). Gamepad API works; Tailscale is WireGuard-encrypted anyway.
- **Recommended for service use:** Tailscale Serve for HTTPS so Wake Lock works and the URL is stable. Exact commands (on the Mac, run by AJ, not by the agent):
  1. Admin console ▸ DNS: MagicDNS on; HTTPS Certificates ▸ Enable (accept CT-log notice).
  2. `tailscale serve --bg --https=443 http://127.0.0.1:8080`
  3. `tailscale serve status` → note `https://videos-mac-studio.<tailnet>.ts.net/`
  4. On iPad (Tailscale app connected): open `https://videos-mac-studio.<tailnet>.ts.net/remote`, Share ▸ Add to Home Screen.
  5. Undo: `tailscale serve --https=443 off` (or `tailscale serve reset`).
  Serve auto-renews; no app change needed besides `wss:` (page already picks `wss` from `location.protocol`). The app can stay on `0.0.0.0` for LAN http in parallel.
- Rejected: mkcert/self-signed (must install + trust a root profile on the iPad, renewal and trust-UI friction); a separate reverse proxy (another moving part on a show machine).
- Page fallback: if `!window.isSecureContext`, skip wake lock and show a hint "Screen may auto-lock — set Auto-Lock to Never or use the https link".

### 2.2 Arbitration (local vs remote)
New `src/input/inputArbiter.ts` (pure, clock injectable). Owner ∈ `'local' | 'remote'`; default `'local'`.
- **Desk always wins.** Any *active* local frame (any button pressed, any |axis| > 0.3, any trigger > 0.15) while remote owns → owner becomes local immediately, remote is told `{t:'owner', owner:'local', reason:'desk-override'}` and its frames are ignored until it claims again. Justification: the desk operator sees program video directly and is the safety fallback; last-active-wins would let a stray iPad nudge steal the shot.
- **Remote claims explicitly** (`claim` message from the "Take control" button or the remote pressing Menu/Start ≥ 1 s). Granted only if remote control is enabled, the session passed the PIN (if configured), no other remote session owns, and the local controller has had no active frame for ≥ 1500 ms. Otherwise refused with reason (`'disabled' | 'desk-active' | 'other-remote' | 'pin'`).
- **One remote owner at a time**; a second iPad may connect and watch (spectator), and can claim only after the owner releases/drops. No stealing between remotes in v1.
- Owner reverts to local on: remote `release`, `idle` (hidden/blur), WS close/error, dead-man timeout (1000 ms without a frame → revoke ownership; motion already stopped at 250 ms by the machine), remote control disabled, or STOP.
- **On every owner change:** call `machine.switchSource(seedInput)` (see 2.4): immediate `stop()` + `setZoom(0)` on the controlled camera if moving, clear `lastPanTilt/lastZoom`, set `lastInput = null`, and seed edge state with the new source's currently-held buttons so a held button never fires a rising edge.
- Operator indicator: `state.remoteControl` = `{ enabled, owner: 'local'|'remote', ownerName, sessions, lastFrameAgoMs, rttMs }` exposed via `/api/status`; desk page shows a pill "Control: Desk" / "Control: iPad (name) — Take back" (Take back = `POST /api/remote/release`). Activity log entry on every owner change.

### 2.3 Safety (layered, never leave a camera moving)
1. **Client:** sends a fixed 30 Hz frame stream (the stream itself is the heartbeat, even if unchanged). On `visibilitychange`→hidden, `pagehide`, `blur`, `gamepaddisconnected`, or `pad.connected === false`: send one neutral frame + `{t:'idle'}`, stop the loop, show "Paused — press any button". On `pageshow`/visible it must re-claim (no auto-resume of ownership).
2. **Server dead-man:** remote frames feed `machine.updateInput` → existing `INPUT_STALE_MS = 250` stops motion if no frame for 250 ms (covers half-open TCP, Safari suspended, Wi-Fi drop). `ws` ping every 1 s; terminate if no pong in 2.5 s.
3. **Explicit stop on close/idle/release:** arbiter calls `switchSource` immediately (don't wait 250 ms).
4. **Machine connectivity gate:** today `!state.controllerConnected` stops motion; generalize to "active source connected" (`local` → `state.controllerConnected`, `remote` → socket open and owner).
5. **STOP:** big on-page button + `{t:'stop'}` + new `POST /api/emergency-stop` → `emergencyStopAll()`, release remote ownership, activity log "Emergency Stop (iPad)". The View/Back button keeps its existing emergency-stop meaning through the machine.
6. **Validation (`src/input/remoteFrame.ts`):** `maxPayload: 512` on the WebSocketServer; JSON parse in try; `t` ∈ {hello, claim, release, in, idle, stop, ping}; `in` requires `s` integer > last seq (drop stale/out-of-order), `a` array of exactly 4 finite numbers clamped to −1..1, `tr` exactly 2 finite numbers clamped to 0..1, `b` integer 0..0xFFFF (bit 16 Guide rejected/ignored). Anything else → counted invalid; > 20 invalid → close 1008.
7. **Rate limit:** token bucket 60 frames/s, burst 20; excess dropped silently; > 300 drops in 5 s → close 1008. Frames from non-owner sessions are validated and discarded (not applied).
8. **Access:** `remoteControl` block in `config/devices.yaml` (Zod, optional): `{ enabled: false, pin?: string /* 4–8 digits */ }`. Runtime toggle `POST /api/remote/enabled {enabled}` on the desk page (not exposed on /remote). Disabling while a remote owns → immediate stop + release. PIN checked in `hello` with `crypto.timingSafeEqual`; 5 bad PINs per remote IP → 60 s lockout. WS upgrade checks `Origin` host equals `Host` (blocks cross-site WS from a random page on the LAN). If `Tailscale-User-Login` is present and the socket's remote address is 127.0.0.1 (i.e. via `tailscale serve`), use it as `ownerName` (label only, not auth).

### 2.4 Changes to `ControlStateMachine`
- Add `setSourceConnected(fn: () => boolean)` (default `() => this.state.controllerConnected`) and use it in the tick guard instead of `state.controllerConnected`.
- Add `switchSource(seed: NormalizedInput | null)`: if `wasMovingPT || wasMovingZoom` → `device.stop(); device.setZoom(0)` (stops are never rate-limited); reset `wasMoving*`, `lastPanTilt`, `lastZoom`, `lastInput = null`, `lastInputTs = 0`; `edgeState.prevButtons = { ...(seed?.buttons ?? {}) }`.
- Activity-log controller name: pass the source label (`'iPad: <name>'`) — add optional `updateInput(input, sourceLabel?)` and use it instead of `state.activeControllerProfile` in `tick()` when set.
No other behavior change: mappings, speed curves, presets (LB+face), recenter (LB+RB), RB auto, dpad speed, lower thirds, back = E-stop all work unchanged.

### 2.5 Mapping (`src/input/browserGamepad.ts`, pure)
`standardFrameToInput({a, tr, b}): NormalizedInput`:
- axes: `leftStickX=a[0], leftStickY=a[1], rightStickX=a[2], rightStickY=a[3]` (pass-through; standard up = −1 matches HID normalization — verify once against the Controller tab's normalized readout with the same pad on the Mac).
- triggers: `leftTrigger=tr[0], rightTrigger=tr[1]` (client sends `buttons[6].value`, `buttons[7].value`).
- buttons by bit: 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 8 back, 9 start, 10 LS, 11 RS, 12 dpadUp, 13 dpadDown, 14 dpadLeft, 15 dpadRight. Bits 6/7 ignored (triggers carry them). Always emit all 14 button keys (false default) so edge state is complete.
- Deadzones: the machine already applies `applyDeadzone` to sticks and `TRIGGER_DEADZONE` to triggers; additionally the **client** applies a radial deadzone of 0.12 to each stick and zeroes |v| < 0.02 so drifting iPad-side sticks don't keep the camera creeping and don't count as "active".
- Non-standard pads (`mapping !== 'standard'`): page shows "Controller not recognised (mapping: '')" and refuses to send motion.
- PlayStation/Switch Pro under standard mapping are **positional** (index 0 = bottom). Xbox labels match; Switch Pro labels differ (bottom is "B"), while the local Switch Pro HID profile is label-based. Document; don't solve in v1.

### 2.6 Wire protocol (`/ws/remote-controller`, JSON)
Client→server: `{t:'hello', v:1, name?, pin?, pad?:{id, mapping}}`, `{t:'claim'}`, `{t:'release'}`, `{t:'in', s, a:[4], tr:[2], b}`, `{t:'idle'}`, `{t:'stop'}`, `{t:'ping', ts}`.
Server→client: `{t:'welcome', session, enabled, needsPin, owner}`, `{t:'owner', owner, you, reason?}`, `{t:'denied', reason}`, `{t:'pong', ts}`, `{t:'state', controlled, program, preview, speedName, precision}` pushed on change and at 2 Hz while owner.

### 2.7 Server module `src/input/remoteControl.ts`
`class RemoteControlHub` (constructed in `index.ts` with `state, config, machine, arbiter, activityLog, emergencyStop`): `handleConnection(ws, req)`, session map, ping timer, owner bookkeeping, writes `state.remoteControl`. `startStatusServer(app, activityLog, port, host, remoteHub?)` routes `/ws/remote-controller` to it. In `index.ts`, supervisor `'data'` goes to `arbiter.fromLocal(input)` which forwards to `machine.updateInput` only when local owns (and detects desk override). Express routes in `createStatusServer`: `POST /api/remote/enabled`, `POST /api/remote/release`, `POST /api/emergency-stop`, `GET /remote` (serves `ui/remote/index.html`).

### 2.8 UI: `ui/remote/index.html`, `remote.js`, `remote.css` (static; no template literal)
iPad-landscape, dark, touch targets ≥ 56 px:
- Top bar: connection dot (WS), RTT ms, owner pill ("You have control" / "Desk has control" / "Another iPad has control"), gamepad indicator (name + "standard" or "Press any button on the controller").
- Main: live preview of the **controlled** camera (find the rig's Sony camera via `/api/rigs` + `/api/config`; poll `/api/sony/cameras/:id/live-view/frame` at ~5 fps only while visible and owner/watching; placeholder "No preview for this rig").
- Side: camera list with Controlled / Program / Preview badges and health verdict text from `state.health.rigs` (poll `/api/status` at 1 Hz); speed preset and precision indicator.
- Buttons: huge red **STOP** (always enabled, even without control), **Take control** / **Release**, PIN prompt when `needsPin`.
- Wake lock when `isSecureContext`; re-acquire on visible. Link to `/remote` from the desk page header.
Add a "Remote control" card on the desk page (statusServer template): enabled toggle, owner, Take back. Keep that JS ES5-ish, no backticks/`${` (run `scripts/check-page-js.cjs`).

## 3. Tests

- `src/testing/remoteFrameTest.ts` (assert + `check()` style like `healthTest.ts`): valid frame parses; NaN/Infinity/strings/wrong lengths rejected; values clamped; seq monotonic; `b` > 0xFFFF rejected; oversized/unknown `t` rejected; token bucket drops above 60/s and allows burst 20.
- `src/testing/browserGamepadTest.ts`: each standard bit → right name; triggers from `tr`; axes pass-through incl. up = −1 → machine tilt positive; all 14 keys present; guide bit ignored.
- `src/testing/inputArbiterTest.ts` (fake clock, fake machine recording calls): default local; claim refused while desk active < 1500 ms; granted after; desk override revokes instantly and calls `switchSource`; second remote refused; close/idle/release/disable/1000 ms silence revert to local with `switchSource`; seeded edge state means a held A on switch does not select a camera.
- Machine test (extend smoke or new `remoteMachineTest.ts` with virtual devices): `switchSource` while panning sends `stop` immediately; tick guard uses the provider.
- Run: `pnpm build && node dist/testing/<name>.js` each.
- **Sandbox self-test** (`sandbox.ts --selftest`, new block using `ws` client): enable remote (`POST /api/remote/enabled`), connect `ws://127.0.0.1:8090/ws/remote-controller` with `Origin: http://127.0.0.1:8090`, `hello`, `claim` → owner remote; select the rs3 rig (face button whose index = rs3's position in `/api/config` cameras); send `rightStickX 0.8` at 30 Hz for 1 s → `bridges[0].velPan > 0`; (a) close socket → within 150 ms `bridges[0].log` has `stop {}` (explicit stop, not just `safety-stop`) and `velPan === 0`; (b) reconnect, claim, move, then stop sending but keep socket open → `velPan === 0` within 400 ms; (c) junk frames don't move anything; (d) `/api/status.remoteControl.owner` returns to `local`; (e) `GET /remote` 200 and the page references `remote.js`. Sandbox has `CAMCONTROL_NO_CONTROLLER=1`, which is fine (remote doesn't need the HID pad).
- `STATUS_PORT=8175 pnpm test:smoke` must remain green (86 assertions); `node scripts/check-page-js.cjs` for the desk page; `node --check ui/remote/remote.js`.
- Manual (AJ, real gear, low-stakes camera first): Xbox paired to iPad, `/remote` over LAN http, then Tailscale https; verify press-to-start, pan/tilt directions match the desk pad, zoom triggers, X/A/B/Y select, LB+face preset save, RB auto transition, Home button does nothing in the app; lock the iPad mid-pan → camera stops; airplane mode mid-pan → stops ≤ 300 ms; desk pad nudge takes control back.

## 4. Issues (ordered)

1. **Pure mapper + validator** — `src/input/browserGamepad.ts`, `src/input/remoteFrame.ts`, tests `browserGamepadTest.ts`, `remoteFrameTest.ts`. AC: tests in §3 pass. No deps.
2. **Arbiter + machine hooks** — `src/input/inputArbiter.ts`, `controlStateMachine.ts` (`setSourceConnected`, `switchSource`, source label), `src/app/state.ts` (`remoteControl` field in `defaultState`/`createInitialState`), `index.ts` routes local data through arbiter. Test `inputArbiterTest.ts`; smoke green. Dep: 1.
3. **WS hub + endpoints** — `src/input/remoteControl.ts`, `statusServer.ts` upgrade route + `/api/remote/*`, `/api/emergency-stop`, `GET /remote`; `configLoader.ts` optional `remoteControl` Zod block; sandbox config gets `remoteControl: { enabled: false }`. AC: sandbox self-test §3 (a)–(e). Dep: 2. **Cheapest end-to-end proof = issues 1–3 plus a 60-line throwaway `ui/remote/index.html` that just polls the pad and sends frames** — then AJ can drive a sandbox/real camera from the iPad.
4. **Remote page** — `ui/remote/{index.html,remote.js,remote.css}`: full UI §2.8, visibility/blur/pagehide handling, wake lock, RTT, STOP. AC: `node --check`, sandbox `GET /remote`, manual iPad checklist. Dep: 3.
5. **Desk page indicator + toggle + Take back** — `statusServer.ts` template card, link to `/remote`. AC: `check-page-js.cjs` passes; sandbox check for the card markers. Dep: 3.
6. **PIN + Origin check + Tailscale name label + lockout** — in hub; tests in `remoteFrameTest`/hub unit test with fake sockets. Dep: 3.
7. **Docs** — `docs/ai/*` (architecture flow, testing-guide, decisions: "desk always wins", "http v1 / Tailscale Serve for https"), a short `docs/ipad-remote.md` with the Tailscale commands. Dep: 4–6.

## 5. Risks & open questions

- **iPad system UI eating input** (iPadOS controller navigation / Game Overlay on Home): must be verified on the real iPad; mitigations: Settings ▸ General ▸ Game Controller customizations, Guided Access.
- **Background/lock**: Safari stops JS; we rely on server dead-man (250 ms) — acceptable, but ownership drops and needs re-claim after unlock (intended).
- **Wi-Fi jitter**: a > 250 ms gap stutters a held move to a stop (then resumes on next frame because the machine treats it as a new move). Tailscale adds latency mostly when relayed (DERP); check `tailscale ping videos-mac-studio` shows direct. If stutter is observed, consider a remote-only stale window of 350 ms — keep below the bridge's 250 ms only matters for gimbals (heartbeat 150 ms keeps them fed while frames arrive).
- **Multi-operator**: desk-wins + single remote owner avoids fights; still needs an operational rule (who's on which surface).
- **Axis sign / face-button label differences** for Switch Pro and PlayStation (positional standard mapping vs label-based local profiles) — open.
- **Should `back` on the iPad pad trigger global emergency stop?** Kept for parity; confirm with AJ.
- **Should remote control be enabled by default on Tailscale?** Proposed default off, toggle per service.
- **Low Power Mode on iPad** halves timers/rAF — 30 Hz send via setInterval should still hold; verify RTT/frame rate display.
- Preview frame polling from the iPad keeps a Sony camera's live view running (heat) — only poll while visible and while viewing.
