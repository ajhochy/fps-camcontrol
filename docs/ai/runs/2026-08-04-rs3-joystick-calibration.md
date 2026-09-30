---
date: 2026-08-04
repo: fps-camcontrol
branch: feat/rs3-ble-bridge
pr: none
issues: configurable DJI RS3 joystick calibration
status: automated and live verification passed
tags: [run, fps-camcontrol]
index: "[[fps-camcontrol]]"
---

## Files changed
- `pi-bridge/drivers/dji_rs_driver.py`
- `pi-bridge/tests/test_dji_rs_driver.py`
- `pi-bridge/README.md`
- `docs/pi-implementation.md`
- `pi-bridge/systemd/dji-bridge.service`
- `docs/ai/project-state.md`

## Checks run
- `python3 -m unittest discover -s pi-bridge/tests -v` — 7/7 passed.
- `pnpm build` — passed.
- `pnpm test:smoke` — 43/43 passed against virtual hardware.
- `git diff --check` — passed.

## Notes
- `DJI_RS3_MAX_JOYSTICK` defaults to `200`; invalid values fall back to the default and numeric values clamp to the reference protocol range `1..1000`.
- The original maximum `80` was too slow. A direct 200-unit test moved the RS3
  about 10° in one second; deployed current/default `200` felt good to the user.
- Final tuning remains against actual camera video.
- Existing Switch Pro and configuration dirty changes were preserved.
