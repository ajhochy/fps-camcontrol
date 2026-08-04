---
type: project
---

# Project State — fps-camcontrol

## Current focus
Complete the remaining live-use checks for the deployed DJI RS3 Bluetooth Low Energy bridge. The BLE driver and app-to-Pi WebSocket path have passed formal verification and initial end-to-end hardware validation. Core VISCA-IP + ATEM camera control remains field-ready pending first-service config.

## Active branch / PR
`main`. No open PR. The working tree contains pre-existing source, configuration, documentation, and untracked changes from the RS3 work and unrelated work.

## In progress
- The BLE bridge is deployed to `dji-bridge.local` (`192.168.10.150`) as user
  `worship`; `dji-bridge` is active and enabled. `/home/worship/dji-bridge`
  points to `/home/worship/fps-camcontrol/pi-bridge`.
- RS3 `34:D2:62:15:A5:47` is configured in `/etc/default/dji-bridge`.
- FPS CamControl `cam4` is enabled as DJI RS3. Its live WebSocket handshake
  advertised `velocity`, `position`, `moveTo`, and `recenter`.

## Risks / known issues
- Controller-driven motion, preset `moveTo`/`recenter`, SIGTERM/Ethernet-yank,
  reconnect/reboot, and 30-minute idle/show soak checks remain.
- RS4/RS4 Pro are unvalidated. A `websockets.server` type-import deprecation
  warning is non-blocking and can be cleaned up later.
- First-service config not yet confirmed on real gear: V-BOT tilt direction, ATEM input IDs, ATEM DSK index.
- Post-hardware polish gaps: no web-UI editor for DJI devices (YAML-only today), DJI-BRIDGE activity-log rendering is default-styled, no Sony PZ stub, roll axis has no controller mapping yet.

## Test status
- Verification gate passed: Python 4/4, `pnpm build`, smoke 36/36,
  `git diff --check`, and formal verification all passed.
- Target-Pi BLE discovery, telemetry, active pose, and bidirectional pan/tilt/roll
  passed. FPS-style visible pan streaming passed end to end; command cessation
  produced `safetyStop` reason `app_timeout` after 250 ms and automatic motion stop.
- A forced disconnect initially logged `ConnectionClosedError`; the focused
  regression test passed, the repair was redeployed, and clean disconnect was confirmed.

## Next step
Run the remaining controller, preset/recenter, signal/network interruption,
reconnect/reboot, and 30-minute idle/show soak checks before live use.

---
**Run history:** one file per run under `docs/ai/runs/` (surfaced as `ai-runs/`). This snapshot is overwritten in place.
