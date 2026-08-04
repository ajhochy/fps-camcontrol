---
date: 2026-08-04
repo: fps-camcontrol
branch: main
pr: none
issues: none
status: verification passed; deployed; initial live bridge validation passed
tags: [run, fps-camcontrol]
index: "[[fps-camcontrol]]"
---

# RS3 Bluetooth spike decision and implementation

## Files changed

- `docs/ai/project-state.md`
- `docs/ai/current-plan.md`
- `docs/ai/decisions/2026-06-25-gimbal-control-build-vs-buy.md`
- `docs/ai/decisions/2026-08-04-rs3-bluetooth-via-pi.md`
- `docs/ai/runs/2026-08-04-rs3-bluetooth-decision.md`

## Checks run

- Live RS3 BLE spike: discovery, connection, raw telemetry, active decoded pose,
  and bidirectional pan/tilt/roll all passed; passive decoded pose timed out.
- `pnpm build` — passed (`tsc`).
- `pnpm test:smoke` — passed, 36/36 assertions.
- `git diff --check` — passed with no whitespace errors.

## Notes

- Decision: retain the app-to-Pi WebSocket bridge and replace its real CAN
  transport with BLE for RS3 control.
- No source code, dependency, commit, push, or PR change was requested.
- The working tree contained unrelated pre-existing modifications and untracked
  files; they were not altered by this documentation task.

## Implementation follow-up

### Files changed

- `pi-bridge/drivers/dji_rs_driver.py`, `pi-bridge/dji_bridge.py`,
  `pi-bridge/requirements.txt`, `pi-bridge/systemd/dji-bridge.service`, and
  `pi-bridge/tests/test_dji_rs_driver.py`
- `README.md`, `pi-bridge/README.md`, `docs/pi-implementation.md`,
  `docs/dji-gimbal-spec.md`, and the affected `docs/ai/` memory files

- Replaced the unverified CAN scaffold with a self-contained RS3 BLE driver
  adapted from the MIT-licensed `jdesbonnet/dji_rs3_control` revision
  `689884f2249e721c5b65c9c74804caddc1e7a68c` with attribution in source.
- Preserved the WebSocket protocol and 250 ms session watchdog. The real driver
  is selected by `--driver dji-rs3-ble`; its address is supplied through
  `--ble-address` or `DJI_RS3_BLE_ADDRESS`.
- Focused fake-BLE tests cover normalized axis mapping, active pose polling and
  translation, and rate-stop plus neutral-frame behavior on close. No live
  bridge or gimbal movement test was run in this implementation session.

## Implementation checks run

- `python3 -m unittest discover -s pi-bridge/tests -v` — passed, 3 tests.
- `pnpm build` — passed (`tsc`).
- `pnpm test:smoke` — passed, 36 assertions.
- `git diff --check` — passed with no whitespace errors.

## Verification repair

- The systemd unit now intentionally targets the deployed `worship` account and
  `/home/worship/dji-bridge` stable symlink, using that path's virtualenv
  interpreter. Deployment instructions create the repository virtualenv before
  the symlink.
- Added `pi-bridge/THIRD_PARTY_NOTICES.md` with the complete upstream MIT
  notice for revision `689884f2249e721c5b65c9c74804caddc1e7a68c`; the driver
  and bridge documentation link to it.
- Removed stale active CAN/stub descriptions from the bridge README and
  architecture. Python >=3.10 is documented for `bleak>=3.0.2`.
- No live gimbal movement is part of this repair.

### Repair checks run

- `python3 -m unittest discover -s pi-bridge/tests -v` — passed, 3 tests.
- `pnpm build` — passed (`tsc`).
- `pnpm test:smoke` — passed, 36 assertions.
- `PYTHONPATH=pi-bridge python3 -c "from drivers.mock_driver import MockDriver; assert MockDriver().name == 'mock'; from drivers.dji_rs_driver import DjiRsDriver"` — passed; imports do not require `bleak`.
- `git diff --check` — passed with no whitespace errors.

## Pi documentation repair

- Reclassified sections 1–11 as historical CAN fallback, removed the obsolete
  CAN service `ExecStartPre` claim, and aligned retained path examples and the
  deployment footer with `worship` and `/home/worship/dji-bridge`.
- `! rg -n '/home/pi|systemd unit.*ExecStartPre' docs/pi-implementation.md && rg -n 'Historical CAN fallback|/home/worship/dji-bridge|Bluetooth LE' docs/pi-implementation.md` — passed.
- `git diff --check` — passed with no whitespace errors. No live motion test was
  performed.

## Final Pi documentation repair

- Replaced the active soak firmware warning with BLE protocol guidance and
  removed CAN-only `candump`/Interface Diagram troubleshooting rows.
- `python3 -c "from pathlib import Path; active = Path('docs/pi-implementation.md').read_text().split('## 12. Soak test before going live', 1)[1]; assert not any(term in active for term in ('CAN', 'candump', 'Interface Diagram PDF'))"` — passed.
- `git diff --check` — passed with no whitespace errors. No live motion test was
  performed.

## WebSocket disconnect repair

- `Session.run()` now treats `ConnectionClosed` during an expected abrupt client
  disconnect as normal while retaining its `finally` stop behavior. A fake
  WebSocket boundary test verifies the exception does not escape and
  `driver.stop()` is called once.
- `python3 -m unittest discover -s pi-bridge/tests -v` — passed, 4 tests.
- `pnpm build` — passed (`tsc`).
- `pnpm test:smoke` — passed, 36 assertions.
- `git diff --check` — passed with no whitespace errors. No live motion test was
  performed.

## Deployment and live verification

- Verification gate passed: Python 4/4, `pnpm build`, smoke 36/36,
  `git diff --check`, and formal verification.
- Deployed to `dji-bridge.local` (`192.168.10.150`) as `worship`. The active and
  enabled `dji-bridge` service uses `/home/worship/dji-bridge`, which points to
  `/home/worship/fps-camcontrol/pi-bridge`.
- RS3 `34:D2:62:15:A5:47` is configured in `/etc/default/dji-bridge`. FPS
  CamControl `cam4` is enabled as DJI RS3; the live WebSocket handshake reported
  `velocity`, `position`, `moveTo`, and `recenter`.
- Direct Pi BLE discovery, telemetry, active pose, and bidirectional pan/tilt/roll
  passed. An FPS-style visible pan stream passed end to end; stopping commands
  produced `safetyStop` reason `app_timeout` after 250 ms and visible automatic stop.
- A forced client disconnect initially logged `ConnectionClosedError`. The
  focused regression test passed, the fix was redeployed, and a clean disconnect
  was confirmed.
- Remaining live-use checks: controller-driven motion, preset `moveTo`/`recenter`,
  SIGTERM/Ethernet yank, reconnect/reboot, and 30-minute idle/show soaks.
- The `websockets.server` type-import deprecation warning is non-blocking future cleanup.
