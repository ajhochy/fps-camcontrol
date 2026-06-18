# Testing Guide — fps-camcontrol

## How to run checks
```bash
pnpm install
pnpm build          # tsc typecheck + emit to dist/
pnpm test:smoke     # ts-node src/testing/smokeTest.ts
```
The smoke suite runs entirely against virtual hardware — no ATEM, cameras, gimbal, or controller required.

## What's covered
- Custom virtual-hardware smoke suite (`src/testing/smokeTest.ts`): **36/36 assertions** as of Round 11.
- VISCA path via `virtualVisca.ts` (incl. preset save/recall round-trip).
- ATEM path via `virtualAtem.ts` (cut, auto-transition, state sync).
- Controller input via `virtualController.ts`.
- DJI gimbal via `virtualDjiBridge.ts`: hello/capability handshake, moveVelocity, 250 ms safety timeout, position round-trip, preset save/recall.

## What's NOT covered (manual verification only)
- Real VISCA cameras (BirdDog / V-BOT) — needs the cameras on the LAN at their configured IPs.
- Real ATEM switcher — input IDs, DSK/USK index, transition behavior.
- Real DJI gimbal — the `dji_rs_driver.py` is a stub; CAN path is unverified against hardware.
- V-BOT tilt direction (inverted byte) on the actual unit.

## Manual smoke (real gear)
1. Edit `config/devices.yaml` (or the web UI) with real ATEM IP, input IDs, DSK index, and camera IPs.
2. `pnpm build && pnpm start`.
3. Open `http://<machine-LAN-IP>:8080` — confirm every connection shows green (startup also prints a per-device probe summary before the first tick).
4. Save shot-zone presets (LB + hold A/B/X/Y) per camera, then exercise pan/tilt/zoom, cut (RT), and auto-transition (RB).

## DJI bridge manual check (mock, no hardware)
```bash
cd pi-bridge
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python3 dji_bridge.py --driver mock --port 7878
```
Uncomment the `cam4` block in `config/devices.yaml`, restart the app, and confirm the gimbal joins camera selection. Soak procedure: `docs/pi-implementation.md` §12.
