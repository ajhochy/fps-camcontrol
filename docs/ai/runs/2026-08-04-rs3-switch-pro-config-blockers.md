---
date: 2026-08-04
repo: fps-camcontrol
branch: feat/rs3-ble-bridge
pr: none
issues: Switch Pro Bluetooth startup detection; Device Config DJI preservation
status: live verification passed
tags: [run, fps-camcontrol]
index: "[[fps-camcontrol]]"
---

## Files changed
- `controller-profiles/switch-pro-bluetooth.yaml`
- `src/input/normalizers.ts`
- `src/input/profileDetector.ts`
- `src/testing/smokeTest.ts`
- `src/ui/statusServer.ts`

## Checks run
- `pnpm build` — passed.
- `pnpm test:smoke` — passed, 43 assertions. Includes captured Switch Pro idle report, packed-axis extremes, Bluetooth profile matching, and DJI bridge save preservation.
- Final verification also passed Python 7/7 and `git diff --check`.

## Notes
- Nintendo Switch Pro Controller `057e:2009` was detected through the new
  Bluetooth profile; main state reported `activeConnectionType: bluetooth`.
- Captured reports were 49-byte `0x30` packets; packed 12-bit parser/profile
  verification passed.
- Device Config had downgraded `cam4` to VISCA with undefined bridge data. The
  root fix preserves `dji-bridge` protocol and the full bridge object; RS3
  configuration was restored and connected live.
- Controller selection of DJI RS3 passed. Pan/tilt passed in every direction and
  stopped on stick release.
