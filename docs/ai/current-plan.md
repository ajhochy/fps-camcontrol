# Current Plan — fps-camcontrol

## Active plan
Finish DJI RS-series gimbal support. App-side and Pi-bridge software are done (mock bridge, 36/36 smoke). The remaining work is hardware-blocked: acquire the Pi kit, bring up CAN, then write the one real driver.

## Next steps
1. **Order parts (~$200):** Pi 5, PiCAN3 HAT, PoE++ splitter, RSA pigtail, microSD, enclosure + standoffs.
2. **Assemble + flash** RPi OS Lite; baseline `apt` setup.
3. **Enable PiCAN3** in `/boot/firmware/config.txt`; bring up `can0` at 1 Mbit.
4. **Verify wiring** — `candump can0` must show DJI frames (hard gate before any further step).
5. **Deploy bridge in mock mode** against the live app to prove the network path.
6. **Write the real DJI driver** in `pi-bridge/drivers/dji_rs_driver.py` — six methods against `base.py`. If DJI's SDK has a Linux build, wrap via `ctypes`/`cffi`; if Windows-only, implement CAN directly with `python-can` against the RS Stabilizer External Interface Diagram PDF (~200–300 lines). The mock driver is a working lifecycle reference.
7. **Verify before live use:** soak test per `docs/pi-implementation.md` §12 (30 min idle, 250 ms safety-timeout on Ethernet yank, heartbeat reconnect, 30 min mock show), then pin gimbal firmware.

All hardware/bridge steps are documented step-by-step in `docs/pi-implementation.md`.

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
- Bluetooth gimbal control (DJI's protocol is closed, never reverse-engineered — not viable).
- USB-C gimbal control (impossible on RS-series — CAN bus required).
