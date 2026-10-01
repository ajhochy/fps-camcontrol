---
type: project
---

# Project State — fps-camcontrol

## Current focus
The manual Electron installer is complete as a signed/notarized/stapled artifact
from frozen foundation commit `133ae8d9620665b1e87b799a765a619ccae06ebc`.
Tracking implementation and independent integration verification are underway;
its final committed-source installer/signing/runtime gates remain pending.

## Active branch / PR
Current: `codex/electron-tracking`, branched from the exact foundation above.
Foundation draft: https://github.com/ajhochy/fps-camcontrol/pull/57, targeting main.
Tracking will target `feat/electron-foundation`. PR36 and its inherited rigs/Sony
work remain unchanged and credited. No merge, release, deployment or cleanup.

## In progress
- Tracking #23–35/#50: strict config/protocol, shared motion arbitration,
  real Python detector/association, API/UI/RS toggle, bounded calibration,
  pinned runtime/model delivery. Contracts and negative tests precede code.
- Independent safety review repaired shutdown stop ordering, UTF-8 credential
  rejection, actual-manager route errors and source reconfiguration.
- Final tracking build must follow source freeze, then Apple acceptance/staples
  and exact mounted-DMG runtime. The manual artifact is immutable.

## Risks / known issues
- MANUAL_PENDING: clean macOS/TCC/download quarantine, physical HID/camera/gimbal,
  real sleep/wake, calibrated gain/latency and both 30-minute tracking soaks.
- Developer-host fresh HOME/minimal PATH is not clean-OS proof. Synthetic model
  inference is not person-detection accuracy or physical stability evidence.
- Packaged APIs use private authenticated loopback; developer CLI endpoints must
  not be exposed on a LAN. Remote control/security work is excluded.
- Historical probe timing failures and unrelated controller #3–6 drafts are
  preserved. Local exclusions: `docs/ai/issues/tracking-v1-exclusions.md`.

## Test status
- Manual root gate: build/page-JS, 49 focused tests, rig/profile/Sony/Pi suites,
  isolated smoke268, sandbox104; separate signing tests12, all pass.
- Final manual app and DMG Apple Accepted, strict codesign/Gatekeeper/staples
  pass. Exact final DMG runtime passes with empty error arrays:
  `runs/electron-manual-evidence/runtime-2026-10-01T20-00-00-684Z/runtime.json`.
- Tracking targeted tests, actual bundled Python mock→TS→VirtualDJI, delay sweep
  150/300/500ms, model inference and six-viewport UI checks pass in scoped runs.
  Root serial full repository tracking gate now exits0, including38/38 actual
  Python/model tests, UI9/9, smoke268 and sandbox104. Final installer remains pending.

## Next step
Finish calibration and independent runtime review, run the serial full gate,
freeze tracking source, build/notarize/verify exact final bytes, and open the
second stacked draft PR. Keep every manual/physical limitation explicit.
