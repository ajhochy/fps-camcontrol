---
type: project
---

# Project State — fps-camcontrol

## Current focus
Prepare the combined Sony dashboard and latest PR #2 work for verification. PR #2 is the latest integration target. The merge is resolved and the combined tree passes build, smoke, Python bridge, and browser checks; it remains uncommitted and unpushed while the verification-gate documentation reconciliation is re-run.

## Active branch / PR
`feat/sony-dashboard`; updated PR #2 is the integration target. The orchestrator will inspect, verify, commit the merge, and push only after PASS.

## Recently completed
- **One Pi per gimbal + Bluetooth gimbal selection + gimbal battery (draft PR, branch `feat/pi-per-gimbal`, deployed
  2026-10-02).** Tripod (RS3 PRO-0614BW 48:1C:B9:54:C6:BC) on `dji-bridge-2.local:7878`, Far Right (RS3-06UH13
  34:D2:62:15:A5:47) on `dji-bridge-3.local:7878`, both as systemd user services (no sudo on the new Pis); bridge 1
  keeps only `dji-bridge@rs3pro-b` (Center, 7880), `@rs3` and `@rs3pro-a` are disabled. All three run bridge 0.6.0.
  **`config/devices.yaml` still points Tripod/Far Right at bridge 1 (7879/7878): repoint them.** Bridge saves its
  gimbal in gimbal.json; Device Config → rig → "Choose gimbal…" lists/switches (confirmed). Battery is the last byte
  of 0x0d/0x02 (RS3 verified on screen; RS3 Pro assumed). Runbook: `docs/pi-per-gimbal.md`. Follow-ups needing sudo
  on the new Pis: Wi-Fi off (both on Ethernet + Wi-Fi).
- **iPad gamepad remote (draft PR, branch `feat/ipad-gamepad-remote`).** An Xbox controller on an iPad drives the
  cameras over the network: `/remote` page (static, `ui/remote/`) streams the browser Gamepad to
  `/ws/remote-controller`; `InputArbiter` keeps the desk controller in charge (desk always wins) and every handover
  stops the camera (`ControlStateMachine.switchSource`). Safety: 250 ms stale-input stop, 1 s seat release, ping
  timeout, stop on close/idle/release/STOP/disable. Off by default (`remoteControl.enabled`, optional PIN). Verified
  only with unit suites, the sandbox and the isolated smoke suite; **not yet tried on a real iPad**. See
  `docs/ipad-remote.md` and `docs/ai/plans/2026-10-01-ipad-gamepad-remote.md`.
- **`DJI_RS3_MAX_JOYSTICK` is actually read** (uncommitted locally; **deployed to
  the Pi 2026-08-13 15:38**). `dji_rs_driver.py`
  hardcoded `MAX_JOYSTICK = 80` while `systemd/dji-bridge@.service` documented the
  variable and all three per-instance env files on the Pi set it to `200`, so the
  operator's configured gain was silently ignored and every gimbal ran at 80. New
  `resolve_max_joystick()` parses and clamps to `1..1000` (default 80), warns on
  an out-of-range or unparseable value instead of failing quietly, and the driver
  logs the effective gain and its source at startup. The gain is read **per driver
  instance**, not at import, because each templated systemd unit is its own
  process with its own env file. `_joystick` is now an instance method.
  The 1000 ceiling is bounded by the wire format: the payload writes
  `CENTER + value` (CENTER = 1024) as an unsigned 16-bit word, so a larger
  magnitude would wrap negative full stick past zero.
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
- Switch Pro Bluetooth controller support (folded from `feat/rs3-ble-bridge` 196ebad) was live-verified with the physical RS3 on 2026-08-04: BT detection, camera selection, all-direction pan/tilt, stop-on-release. Its DJI_RS3_MAX_JOYSTICK change was superseded by the per-instance clamp in the joystick-gain decision (default 80; deployed env files set 200).
- Sony live a7S III widget, preview, properties, explicit discovery/connect cache, and lightweight nested connection checks succeeded. The four-up 4/2/1 layout awaits AJ visual recheck.
- Manual Sony checks remain: two physical cameras, FX3 touch focus, and HDMI coexistence.

## Risks / known issues
- **All three gimbals now run at gain 200 (was 80) — live motion is UNVERIFIED.**
  The fix is deployed and each instance logs `max joystick gain 200 (from
  DJI_RS3_MAX_JOYSTICK…)` at startup, so the env value is provably reaching the
  driver. But no gimbal was advertising at deploy time (all powered off/asleep,
  pre-existing — the warnings predate the restart and `NRestarts` is 0 on all
  three), so nobody has confirmed what 200 actually feels like on a real camera.
  **First stick input must be a small deflection with the operator watching video.**
  Rollback if it is too fast: either set `DJI_RS3_MAX_JOYSTICK` lower in
  `/etc/default/dji-bridge-<instance>` and restart (no code change needed — that is
  the point of the fix), or restore
  `/home/worship/dji-bridge/drivers/dji_rs_driver.py.bak-20260813-153810`.
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
- Switch Pro Bluetooth support is verified only for the tested `057e:2009`
  controller and captured 49-byte `0x30` reports.

## Test status
- Joystick-gain fix: `python3 -m unittest discover -s pi-bridge/tests` **40/40**
  (13 new in `MaxJoystickTests` covering default, env read, per-instance read,
  clamping at both bounds, unparseable/blank fallback, the startup log line, and
  full-deflection scaling), `pnpm build` clean, `STATUS_PORT=8175 pnpm test:smoke`
  **176/176**, `git diff --check` clean. On the Pi: 40/40 under its own
  `.venv/bin/python3` (3.13.5), all three instances `active` with `NRestarts=0`
  and each logging the effective gain. Real-gimbal **motion** is **not** verified —
  the gimbals were powered off during the deploy window.
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
- Focused blocker repair: `pnpm build` and smoke 43/43 passed; see
  `docs/ai/runs/2026-08-04-rs3-switch-pro-config-blockers.md`.
- Final automated verification: Python 7/7, `pnpm build`, smoke 43/43, and
  `git diff --check` passed. Packed 12-bit parser/profile verification used
  captured 49-byte `0x30` reports.
- Live controller verification: `activeConnectionType` was `bluetooth`; DJI RS3
  camera selection passed; pan/tilt passed in all directions and stopped on
  stick release.
- RS3 joystick calibration details:
  see `docs/ai/runs/2026-08-04-rs3-joystick-calibration.md`.

- Sony dashboard merge evidence: `pnpm build` pass, `STATUS_PORT=8176 pnpm test:smoke` 206/206, `python3 -m unittest discover -s pi-bridge/tests` 26/26, `git diff --check` pass, and the browser fixture (desktop four-up, tablet two-column, mobile one-column, tabs, dark mode) pass.
- That run's verification gate failed only on contract criterion c10, whose "no controller/MotionDevice/ATEM/YAML/dependency changes" wording was stale for the combined branch. Contract and run note now separate Sony feature ownership from the intentionally merged PR #2 branch scope; no production or test file changed, so a documentation-only gate re-run is what remains.
- Gimbal BLE link drops were diagnosed as **signal strength, not command rate**.
  Measured with both RS3 Pros moved next to the Pi: 45s idle, 45s at 60 commands/sec,
  and 45s at 20/sec each produced **0 drops**. Beforehand, at -82 to -89 dBm, the
  same gimbals dropped 46/hour and eventually stopped advertising entirely. Two
  earlier hypotheses (battery, command flooding) were tested and disproved.
  Motion commands are rate-limited anyway (`shouldSendMotion`), as hygiene rather
  than as the fix.

## Next step
Live-verify the new gain 200 with the operator watching camera video, starting from
small stick deflections (see the risk above) — the gimbals were powered off during
the deploy window so nobody has felt 200 yet. Confirm the Xbox pad drives motion
after a rebuild (`3ef7010` only reaches `dist/` on rebuild; a running instance keeps
its old code). Keep the gimbals within good BLE range of the Pi, or move the Pi —
signal, not software, is what determined link stability. Then the documentation-only
verification-gate re-run against the reconciled contract, AJ's visual recheck of the
four-up Sony layout, and the remaining controller, preset/recenter,
interruption/recovery, reconnect/reboot, and 30-minute soak checks before live use.

---
**Run history:** one file per run under `docs/ai/runs/` (surfaced as `ai-runs/`). This snapshot is overwritten in place.

## Consolidation 2026-09-29
- Branch `mega/2026-09-29-consolidation` (from `origin/main` dd3db16) folds all unmerged work. PR: https://github.com/ajhochy/fps-camcontrol/pull/20 (draft). Tracking issues: https://github.com/ajhochy/fps-camcontrol/issues/21 (verify and land), https://github.com/ajhochy/fps-camcontrol/issues/22 (Sony auto-connect and dashboard).
- Folded refs (tip SHA): `fix/controller-visca-ptz-and-multi-cam` local 2fbd51f / remote 332ef15 (PR #2); `feat/sony-dashboard` remote b3715b0 / local 62f75f4 (PR #8); `feat/settings-dark-mode` remote e8b68bb / local 8cae6a1; `feat/rs3-ble-bridge` 196ebad (local only; base 2833026 merged `-s ours` since 5a99565 on PR #2 supersedes it; joystick-gain and config-save changes superseded by the PR #2 versions, Switch Pro support kept).
- Dropped refs (fully merged into `origin/main`; preserved in `~/Documents/.consolidation-backups/fps-camcontrol-2026-09-29.bundle`): `origin/claude/peaceful-wilson-7df1fc` a721d71, `origin/claude/practical-jepsen-8235f2` c13dff2, `origin/claude/stupefied-gauss-f1b1dc` 703c350, `origin/claude/tender-swirles-a91629` aedca7c, `origin/claude/vibrant-yalow-c5d9cf` a6620d2.
- Open decision: default DJI joystick gain is 80 in code (per-instance env files set 200); `docs/ai/runs/2026-08-04-rs3-joystick-calibration.md` describes 200 as the accepted default.
- In-flight worktrees: none. Linked worktree `~/Documents/fps-camcontrol-sony-worktree` (`feat/sony-dashboard`) is folded and scheduled for removal by the cleanup script.
- Cleanup script (not executed): `~/Documents/.consolidation-backups/cleanup/fps-camcontrol-2026-09-29-cleanup.sh`.
