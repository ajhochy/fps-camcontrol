---
type: project
---

# Current Plan — fps-camcontrol

## Active plan
Finish the remaining live-use checks for the verified and deployed DJI RS3 BLE bridge. Switch Pro Bluetooth detection, DJI configuration preservation, controller camera selection, all-direction pan/tilt, and stop-on-release have passed with the physical RS3. The deployed joystick maximum is `200` and felt good in the initial live test.

## Next steps

1. Tune controller speed while viewing actual camera video.
2. Verify emergency stop and preset `moveTo`/`recenter` against the physical RS3.
3. Verify safe stop and recovery across Ethernet yank, reconnect, and Pi reboot.
4. Complete idle and representative-show soaks.

The deployed target is `dji-bridge.local` (`192.168.10.150`), user `worship`.
The active and enabled `dji-bridge` service uses `/home/worship/dji-bridge`, a
symlink to `/home/worship/fps-camcontrol/pi-bridge`; RS3 address
`34:D2:62:15:A5:47` is set in `/etc/default/dji-bridge`. FPS CamControl `cam4`
is enabled as DJI RS3.

After redeployment, the Pi service remained active and the app, RS3, and Switch
Pro controller were all live-connected.

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
