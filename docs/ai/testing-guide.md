# Testing Guide — fps-camcontrol

## How to run checks
```bash
pnpm install
pnpm build          # tsc typecheck + emit to dist/
ai-workflow checks --level issue
ai-workflow checks --level pr
```
`scripts/run_ai_workflow.py` adapts the installed workflow CLI to this repository.
`scripts/checks.cjs` runs checks serially, with real-controller access disabled:
TypeScript build, embedded-page JavaScript syntax, focused rig/profile/Sony tests,
Node contract/security/lifecycle tests, Pi fake-BLE tests, and the isolated FPS smoke.
PR level also runs the FPS sandbox self-test. There is no separate lint command.
Importing `src/index.ts` no longer boots the app; startup is explicit.

Release changes additionally require `node --test tests/release/electron-release.test.cjs scripts/test-electron-release.cjs`
and `actionlint .github/workflows/electron_release.yml`. The local check runner
includes the release contracts and helper fixtures. The GitHub PR job is
credential-free release-tooling validation only, not a hosted signed app build.
See `docs/releasing.md` for full signing and publication gates.

```bash
pnpm build
node scripts/check-page-js.cjs
CAMCONTROL_NO_CONTROLLER=1 pnpm test:smoke:isolated
CAMCONTROL_NO_CONTROLLER=1 pnpm sandbox:check
python3 -m unittest discover -s pi-bridge/tests -v
git diff --check
```

Serialize fixed-port suites: FPS sandbox uses app 8090, Sony 8191, VISCA
52391–52393, DJI 17878–17880; isolated smoke uses app 8175 and Sony 8199.
Never run checks against the operator's configuration or touch a live service.
Electron native dependencies are rebuilt only in an isolated staging directory;
the ordinary Node test dependencies must keep their own ABI.

The Pi bridge's `bleak>=3.0.2` runtime requires Python >=3.10.

## What's covered

### Tracking-specific checks (serial, synthetic sources only)

```bash
pnpm test:tracking
node --test -r ts-node/register/transpile-only tests/tracking/*.cjs tests/tracking/*.ts
dist/tracking-runtime/python/bin/python3 -I -B -m unittest discover -s tracker-sidecar/tests -v
node dist/testing/trackingSim.js
node dist/testing/trackingIntegrationTest.js
node scripts/test-tracking-ui.cjs
node --test scripts/test-tracking-docs.cjs scripts/test-tracking-runtime-staging.cjs
pnpm tracking:calibrate --dry-run --trials 5
# This invokes scripts/tracking-calibrate.ts (developer tooling only).
node scripts/package-electron-tracking.cjs
node scripts/test-electron-tracking-package.cjs
node scripts/test-tracking-sidecar-runtime.cjs --app '/absolute/FPS CamControl Tracking.app'
node scripts/test-electron-tracking-runtime.cjs --dmg '/absolute/final-tracking.dmg'
```

Stage the pinned runtime first (explicit `--download` only for missing verified
cache); never use host pip or replace the Node-test ABI with Electron's.
Set `TRACKER_TEST_MODEL` to the absolute pinned ONNX path for actual inference
tests; skipped model tests do not count as real inference. The combined
`test:tracking` runner uses that staged interpreter/model directly.
UI tests use an installed test browser, synthetic preview, actual HTML/assets
and fixture API responses; integration/runtime tests cover real services.

Record separate 30-minute idle and 30-minute active-tracking physical soaks,
gain/direction calibration, BLE drop/recovery, stale/target-loss, manual override,
emergency stop and real sleep/HID/TCC. All are MANUAL_PENDING until witnessed;
see `runs/2026-10-01-tracking-live-verification.md`. Never save identifiable footage.

- Custom virtual-hardware smoke suite (`src/testing/smokeTest.ts`); latest captured
  counts and commit provenance belong in the dated run report, not this guide.
- Controller hot-plug via an injectable `ControllerSupervisor` (`detect` /
  `enumerate` / `createGamepad` are swappable, so no real HID is needed):
  attach-after-startup, detach only after two consecutive enumeration misses,
  re-attach, and the diagnostic text for a detected-but-silent pad.
- VISCA path via `virtualVisca.ts` (incl. preset save/recall round-trip).
- ATEM path via `virtualAtem.ts` (cut, auto-transition, state sync).
- Controller input via `virtualController.ts`.
- DJI gimbal via `virtualDjiBridge.ts`: hello/capability handshake, moveVelocity, 250 ms safety timeout, position round-trip, preset save/recall.

## What's NOT covered (manual verification only)
- A genuinely clean macOS machine/VM, TCC prompts, first-download quarantine,
  and physical HID behavior. A temporary HOME/minimal PATH on a developer Mac
  is an isolation check, not a clean-OS result.
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
3. Open `http://127.0.0.1:8080` on the host — confirm the configured real connections show green. The server is loopback-only, not LAN-accessible. The packaged app opens its private authenticated ephemeral listener itself.
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

## Packaged Electron acceptance

See `docs/electron.md` for build, first-run, import, optional user-supplied Sony
setup, and clean-Mac instructions. Run `pnpm test:electron:runtime`
against the built DMG at the path configured in the script; it mounts it and uses
disposable homes and no controller. It exercises offline setup, real HTTP/WS
authentication, native module loading, persistence, consented import, single
instance ownership, and owned crash/sleep/quit recovery. Preserve failed-run
evidence separately. Packaging/signing alone is not runtime acceptance.

Probe telemetry remains diagnostic and separate from the shipping app. The two
historical idle-soak failures are preserved and are not declared repaired by a
short instrumentation run. Do not repeat blind soaks or substitute probe results
for production-app evidence.
