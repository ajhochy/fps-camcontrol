# Testing Guide — fps-camcontrol

## How to run checks
```bash
pnpm install
pnpm build          # tsc typecheck + emit to dist/
pnpm test:smoke     # ts-node src/testing/smokeTest.ts
```
The assertions run against virtual hardware, but **importing the suite also boots
the real app**: modules pull `logger` from `src/index.ts`, so `main()` executes,
connects to the configured ATEM/cameras, and binds `STATUS_PORT`. So:

```bash
STATUS_PORT=8175 pnpm test:smoke   # required while the app is running
```

Otherwise it dies with `EADDRINUSE`. Two concurrent runs also contend for the
controller's exclusive HID handle, which shows up as a bogus
`cannot open device` — check for strays with `ps aux | grep smokeTest` before
believing a controller-open failure.

`ai-workflow checks` does not work here: there is no `scripts/run_ai_workflow.py`,
so it falls back to a nonexistent `npm run typecheck`. Use the commands above.

The Pi bridge's `bleak>=3.0.2` runtime requires Python >=3.10.

## Isolated harnesses (use these, not the live app)
```bash
pnpm build
node scripts/check-page-js.cjs      # the desk page's inline JS + ui/ files parse
node dist/testing/<name>.js         # unit suites, no app needed: rigsTest rigSchemaTest rigEditTest rigsUiModelTest
                                    # workingProfileTest sonyManagerTest sonyConfigStoreTest gimbalScanTest djiReconnectTest
                                    # viscaTransportTest healthTest gimbalWakeTest
                                    # iPad remote: browserGamepadTest remoteFrameTest inputArbiterTest remoteControlTest remoteUiModelTest
                                    # Pi per gimbal: bluetoothGimbalTest (gimbal selection proxy + battery)
pnpm sandbox:check                  # isolated app (8090/8191/17878+), fakes; includes the iPad remote stop paths
pnpm test:smoke:isolated            # the smoke suite against the sandbox config
```
Never import the machine or `src/index.ts` from a standalone suite: `logger` comes from `index.ts`, so doing so boots
the app. Machine-level checks go in `smokeTest.ts` (run via `test:smoke:isolated`).

iPad remote coverage: validation and the token bucket (`remoteFrameTest`), the mapping (`browserGamepadTest`),
arbitration with a fake clock (`inputArbiterTest`), the hub with fake sockets: dead-man, ping timeout, PIN lockout,
Origin, Tailscale label (`remoteControlTest`), the page's pure logic round-tripped through the server validator
(`remoteUiModelTest`), `switchSource` on the real machine (smoke Test 12b), and the sandbox: a WebSocket client plays
the iPad against the fake DJI bridge and checks that socket drop, silence, idle, Take back, STOP, junk frames and
switch-off each leave the gimbal stopped and the desk in control.
Manual only: a real iPad with a real Xbox controller (checklist in the PR / `docs/ipad-remote.md`).

## What's covered
- Custom virtual-hardware smoke suite (`src/testing/smokeTest.ts`): **86/86 assertions** as of the controller hot-plug fix.
- Controller hot-plug via an injectable `ControllerSupervisor` (`detect` /
  `enumerate` / `createGamepad` are swappable, so no real HID is needed):
  attach-after-startup, detach only after two consecutive enumeration misses,
  re-attach, and the diagnostic text for a detected-but-silent pad.
- VISCA path via `virtualVisca.ts` (incl. preset save/recall round-trip).
- ATEM path via `virtualAtem.ts` (cut, auto-transition, state sync).
- Controller input via `virtualController.ts`.
- DJI gimbal via `virtualDjiBridge.ts`: hello/capability handshake, moveVelocity, 250 ms safety timeout, position round-trip, preset save/recall.

## What's NOT covered (manual verification only)
- Real controller input flow. `GamepadDevice`'s 2 s handshake window needs a live
  HID open, so "opened, idle, then a stick moves → connected" is manual only.
  A Bluetooth Xbox pad sends **zero** reports while untouched, so "no packets"
  alone does not mean anything is broken.
- Real VISCA cameras (BirdDog / V-BOT) — needs the cameras on the LAN at their configured IPs.
- Real ATEM switcher — input IDs, DSK/USK index, transition behavior.
- Real DJI bridge deployment — focused fake-BLE driver tests cover RS3 frame
  mapping, active pose translation, and neutral stop/close, but do not replace
  safety-confirmed end-to-end bridge validation on the Pi.
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

## RS3 BLE driver tests
```bash
python3 -m unittest discover -s pi-bridge/tests -v
```
These use an injected fake BLE transport; no gimbal or `bleak` installation is required.
