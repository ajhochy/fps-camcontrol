---
type: project
---

# Project State — fps-camcontrol

## Current focus
Complete the remaining live-use checks for the deployed DJI RS3 Bluetooth Low Energy bridge. Switch Pro Bluetooth detection, DJI device-configuration preservation, controller camera selection, and released-stick motion stop have passed end-to-end with the physical RS3.

## Active branch / PR
`feat/rs3-ble-bridge`. No open PR. The working tree retains the manually restored `config/devices.yaml` and unrelated `config/mappings.yaml` changes.

## In progress
- RS3 normalized joystick scaling is configurable with `DJI_RS3_MAX_JOYSTICK`
  and deployed at its default `200`. A direct 200-unit command moved about 10°
  in one second, and controller speed was accepted as feeling good.
- The BLE bridge is deployed to `dji-bridge.local` (`192.168.10.150`) as user
  `worship`; `dji-bridge` is active and enabled. `/home/worship/dji-bridge`
  points to `/home/worship/fps-camcontrol/pi-bridge`.
- RS3 `34:D2:62:15:A5:47` is configured in `/etc/default/dji-bridge`.
- FPS CamControl `cam4` is enabled as DJI RS3. Its live WebSocket handshake
  advertised `velocity`, `position`, `moveTo`, and `recenter`.
- The Pi service is active; the app, RS3, and Switch Pro controller were all
  live-connected after redeployment.

## Risks / known issues
- Tune speed against actual camera video. Emergency stop, preset
  `moveTo`/`recenter`, Ethernet-yank/reboot/reconnect, and soak checks remain.
- RS4/RS4 Pro are unvalidated. A `websockets.server` type-import deprecation
  warning is non-blocking and can be cleaned up later.
- First-service config not yet confirmed on real gear: V-BOT tilt direction, ATEM input IDs, ATEM DSK index.
- Post-hardware polish gaps: no web-UI editor for DJI devices (YAML-only today), DJI-BRIDGE activity-log rendering is default-styled, no Sony PZ stub, roll axis has no controller mapping yet.
- Switch Pro Bluetooth support is verified only for the tested `057e:2009`
  controller and captured 49-byte `0x30` reports.

## Test status
- Verification gate passed: Python 4/4, `pnpm build`, smoke 36/36,
  `git diff --check`, and formal verification all passed.
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

## Next step
Tune controller speed against actual video, then test emergency stop,
preset/recenter, Ethernet yank plus reboot/reconnect, and idle/show soak.

---
**Run history:** one file per run under `docs/ai/runs/` (surfaced as `ai-runs/`). This snapshot is overwritten in place.
