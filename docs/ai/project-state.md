---
type: project
---

# Project State — fps-camcontrol

## Current focus
Complete the remaining live-use checks for the deployed DJI RS3 Bluetooth Low Energy bridge. The BLE driver and app-to-Pi WebSocket path have passed formal verification and initial end-to-end hardware validation. Core VISCA-IP + ATEM camera control remains field-ready pending first-service config.

## Active branch / PR
`fix/controller-visca-ptz-and-multi-cam`; PR #2 targets `main`. Current `main`
and the verified RS3 BLE work are integrated locally; merge to `main` is pending.

## Recently completed
- **Controller hot-plug detection** (`3ef7010`). Controller detection was
  one-shot at startup: `index.ts` called `findConnectedController()` once, and
  when it returned null no `GamepadDevice` was ever built, so nothing retried. A
  pad paired after boot stayed invisible until restart. New
  `src/input/controllerSupervisor.ts` re-runs detection on a 2 s interval while
  nothing is attached, and detaches after two consecutive enumeration misses.
- `/api/controllers` used to hardcode `connected: true` for every enumerated HID
  device, so the Controller tab contradicted the home screen. It now reports
  `detected` (OS sees it) apart from `connected` (packets arriving), and
  `state.controllerStatusDetail` explains a silent pad (exclusive-access
  contention, denied Input Monitoring, or merely idle).
- `GamepadDevice` no longer closes and reopens when the 2 s handshake window
  passes with no packets. **Verified on the real pad: a Bluetooth Xbox
  controller opens fine but sends 0 packets in 3 s while untouched**, so the old
  teardown churned the device every 2 s and restarted the window — an idle
  controller could never come up. Reopening cannot fix denied permissions
  either.

## In progress
- The BLE bridge is deployed to `dji-bridge.local` as user `worship`;
  `dji-bridge` is active and enabled. `/home/worship/dji-bridge` points to
  `/home/worship/fps-camcontrol/pi-bridge`. The app config addresses the Pi by
  **hostname, not IP** — its DHCP address changes when it is moved between
  switches (was `192.168.10.150`; now `eth0 192.168.50.151` / `wlan0
  192.168.50.150`, which is also why `dji-bridge.local` resolves to two IPs).
- RS3 `34:D2:62:15:A5:47` is configured in `/etc/default/dji-bridge`.
- FPS CamControl `cam4` is enabled as DJI RS3. Its live WebSocket handshake
  advertised `velocity`, `position`, `moveTo`, and `recenter`.

## Risks / known issues
- Controller-driven motion, preset `moveTo`/`recenter`, SIGTERM/Ethernet-yank,
  reconnect/reboot, and 30-minute idle/show soak checks remain.
- RS4/RS4 Pro are unvalidated. A `websockets.server` type-import deprecation
  warning is non-blocking and can be cleaned up later.
- **Bridge crash-loops when the gimbal is absent.** `dji_bridge.py` awaits
  `driver.connect()` in `serve()` *before* binding the WebSocket listener, so a
  powered-off/out-of-range RS3 raises `GimbalError` → `exit(1)` → systemd
  restarts (observed 112 restarts). Port 7878 never opens, so the app sees
  "Connection refused" and the Pi looks dead when it is actually healthy.
  Diagnose with `journalctl -u dji-bridge`. Fix: bind the listener first and
  connect/retry the gimbal in the background, reporting it as disconnected.
- **Real-pad input flow is still unverified.** Detection, open, and the
  detected/connected split are covered by tests, but nobody has confirmed that
  moving a stick produces motion since the hot-plug fix — that needs a human at
  the controller.
- **The smoke suite boots the whole app as an import side effect.** Modules
  import `logger` from `src/index.ts`, which runs `main()` — so `pnpm test:smoke`
  connects to the real ATEM/cameras and binds `STATUS_PORT`. Consequences: it
  fails with `EADDRINUSE` while the app is running (use
  `STATUS_PORT=<free port> pnpm test:smoke`), it leaves a listener behind if it
  dies mid-run, and two concurrent runs fight over the controller's exclusive
  HID handle — which looks exactly like "macOS won't let us open the pad".
- **`ai-workflow checks` does not work in this repo.** There is no
  `scripts/run_ai_workflow.py`, so the CLI falls back to `npm run typecheck`,
  which does not exist. Use `pnpm build` + `pnpm test:smoke` from the testing
  guide instead.
- First-service config not yet confirmed on real gear: V-BOT tilt direction, ATEM input IDs, ATEM DSK index.
- Post-hardware polish gaps: no web-UI editor for DJI devices (YAML-only today), DJI-BRIDGE activity-log rendering is default-styled, no Sony PZ stub, roll axis has no controller mapping yet.

## Test status
- Controller hot-plug change (`3ef7010`): `tsc` clean, smoke **86/86** (22
  controller assertions), Python 6/6, `git diff --check` clean. Verified in an
  isolated `git worktree` at HEAD plus only that change, because a concurrent
  session had unrelated in-flight edits in the shared working tree.
- Verification gate passed: Python 4/4, `pnpm build`, smoke 36/36,
  `git diff --check`, and formal verification all passed.
- Integrated PR #2 check: `pnpm build`, merged smoke 64/64, and Python 4/4
  passed locally. `git diff --check main...HEAD` only reports trailing whitespace
  embedded in PR #2's existing volunteer-guide PDF.
- Target-Pi BLE discovery, telemetry, active pose, and bidirectional pan/tilt/roll
  passed. FPS-style visible pan streaming passed end to end; command cessation
  produced `safetyStop` reason `app_timeout` after 250 ms and automatic motion stop.
- A forced disconnect initially logged `ConnectionClosedError`; the focused
  regression test passed, the repair was redeployed, and clean disconnect was confirmed.

## Next step
Restart the app and confirm the Xbox pad now reaches "Connected" on the home
screen and drives motion (`3ef7010` is only in `dist/` after a rebuild — a
running instance keeps its old code). Then run the remaining controller, preset/recenter, signal/network interruption,
reconnect/reboot, and 30-minute idle/show soak checks before live use.

---
**Run history:** one file per run under `docs/ai/runs/` (surfaced as `ai-runs/`). This snapshot is overwritten in place.
