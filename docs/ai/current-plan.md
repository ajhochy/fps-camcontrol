---
type: project
---

# Current Plan — fps-camcontrol

## Active plan
Open a draft PR for the verified Sony multi-camera dashboard, then complete the remaining physical-camera smoke checks. Automated verification and browser-fixture evaluation passed; the feature remains incomplete and unmerged pending manual validation.

## Next steps

1. Open a draft PR from `feat/sony-dashboard`.
2. Verify two physical cameras simultaneously.
3. Verify FX3 touch focus.
4. Verify HDMI coexistence.

The final-gate live physical sidecar timed out. Automated verification still passed: `pnpm build`, smoke 89/89, and `git diff --check`; browser artifacts are under `docs/ai/runs/artifacts/sony-dashboard/`.

## Remaining DJI live-use checks

1. Run a controller-driven live pan/tilt test through FPS CamControl.
2. Verify preset `moveTo` and `recenter` against the physical RS3.
3. Verify safe stop on bridge SIGTERM and Ethernet yank.
4. Verify app/bridge recovery after reconnect and Pi reboot.
5. Complete 30-minute idle and representative-show soaks.

The deployed target is `dji-bridge.local` (`192.168.10.150`), user `worship`.
The active and enabled `dji-bridge` service uses `/home/worship/dji-bridge`, a
symlink to `/home/worship/fps-camcontrol/pi-bridge`; RS3 address
`34:D2:62:15:A5:47` is set in `/etc/default/dji-bridge`. FPS CamControl `cam4`
is enabled as DJI RS3.

The `websockets.server` type-import deprecation warning is non-blocking cleanup,
not a live-use gate.

## Post-hardware polish (not blockers)
- Web UI editor for DJI devices — `statusHtml()` only exposes VISCA fields today; DJI cameras are YAML-only. ~30 min to add `protocol`, `bridge.host`, `bridge.port`, `rollEnabled`.
- Activity-log rendering for `DJI-BRIDGE` protocol entries (enum accepted, default styling). Cosmetic.
- Sony PZ lens stub — Phase 3 step 14, skipped; would validate a third protocol. ~1 hr.
- Roll velocity from sticks — capability + protocol support exist, but no controller input maps to roll yet. Needs a chord + state-machine route.

## First-service config (before any live use of the VISCA/ATEM path)
- Set ATEM IP + confirm input IDs + DSK index via the web UI.
- Confirm V-BOT tilt direction on the actual unit (`cameraType: vbot`).
- Save shot-zone presets (LB + hold A/B/X/Y) per camera.

## Out of scope / parked
- CAN/PiCAN3 gimbal transport — retained as a fallback, superseded by the tested RS3 BLE path.
- USB-C gimbal control (unsupported on RS-series; use BLE primary or CAN fallback).
