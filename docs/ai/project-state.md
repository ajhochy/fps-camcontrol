---
type: project
---

# Project State — fps-camcontrol

## Current focus
Prepare the combined Sony dashboard and latest PR #2 work for verification. PR #2 is the latest integration target. The merge is resolved and the combined tree passes build, smoke, Python bridge, and browser checks; it remains uncommitted and unpushed while the verification-gate documentation reconciliation is re-run.

## Active branch / PR
`feat/sony-dashboard`; updated PR #2 is the integration target. The orchestrator will inspect, verify, commit the merge, and push only after PASS.

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
- Sony live a7S III widget, preview, properties, explicit discovery/connect cache, and lightweight nested connection checks succeeded. The four-up 4/2/1 layout awaits AJ visual recheck.
- Manual Sony checks remain: two physical cameras, FX3 touch focus, and HDMI coexistence.

## Risks / known issues
- Controller-driven motion, preset `moveTo`/`recenter`, interruption/recovery, and 30-minute soak checks remain; RS4/RS4 Pro are unvalidated.
- The bridge crash-loops when the gimbal is absent because it connects before binding WebSocket port 7878; diagnose with `journalctl -u dji-bridge`.
- Real-pad motion remains unverified. Smoke imports boot the app and can conflict on `STATUS_PORT`/HID; use a free `STATUS_PORT`.
- First-service config not yet confirmed on real gear: V-BOT tilt direction, ATEM input IDs, ATEM DSK index.
- Post-hardware polish gaps: no web-UI editor for DJI devices (YAML-only today), DJI-BRIDGE activity-log rendering is default-styled, no Sony PZ stub, roll axis has no controller mapping yet.

## Test status
- Integrated merge evidence captured: `pnpm build` pass, `STATUS_PORT=8176 pnpm test:smoke` 206/206, `python3 -m unittest discover -s pi-bridge/tests` 26/26, `git diff --check` pass, and the browser fixture (desktop four-up, tablet two-column, mobile one-column, tabs, dark mode) pass.
- The verification gate failed only on contract criterion c10, whose "no controller/MotionDevice/ATEM/YAML/dependency changes" wording was stale for the combined branch. Contract and run note now separate Sony feature ownership from the intentionally merged PR #2 branch scope; no production or test file changed, so a documentation-only gate re-run is what remains.

## Next step
Documentation-only verification-gate re-run against the reconciled contract; only then may the orchestrator commit and push updated PR #2. AJ visual recheck of the four-up layout and the remaining physical Sony checks follow.

---
**Run history:** one file per run under `docs/ai/runs/` (surfaced as `ai-runs/`). This snapshot is overwritten in place.
