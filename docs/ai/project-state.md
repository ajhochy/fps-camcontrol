---
type: project
---

# Project State — fps-camcontrol

## Current focus
The manual Electron installer is complete as a signed/notarized/stapled artifact
from frozen foundation commit `133ae8d9620665b1e87b799a765a619ccae06ebc`.
Tracking is implemented from frozen source `3711a9e6475633a6cf889850ba3a23843a12c450`;
its separately identified final signed/notarized/stapled DMG passes exact-byte
mounted runtime. User now authorizes a GitHub testing release and a workflow
mirroring Rhythm. Release tooling is implemented; publication is being verified.
Human gates remain below.

## Active branch / PR
Current: `codex/electron-tracking`, branched from the exact foundation above.
Foundation draft: https://github.com/ajhochy/fps-camcontrol/pull/57, targeting main.
Tracking draft: https://github.com/ajhochy/fps-camcontrol/pull/58, targeting
`feat/electron-foundation`. PR36 and its inherited rigs/Sony
work remain unchanged and credited. Release tooling belongs to PR58 and builds
each variant from separate pinned source commits. No merge, deployment or cleanup.

## In progress
- GitHub release workflow: manual/tag trigger, ARM64 matrix, scoped Apple secrets,
  temporary hosted keychain, notarization and final DMG runtime gates, one
  prerelease publisher with asset download/hash verification. Initial release
  uses qualified local artifacts; full hosted signing awaits credential setup.
- Tracking #23–35/#50: strict config/protocol, shared motion arbitration,
  real Python detector/association, API/UI/RS toggle, bounded calibration,
  pinned runtime/model delivery. Contracts and negative tests precede code.
- Independent safety review repaired shutdown stop ordering, UTF-8 credential
  rejection, actual-manager route errors and source reconfiguration.
- Both final apps and DMGs are Apple Accepted, stapled, strict-signature and
  Gatekeeper verified. Manual artifact remains immutable. Artifact bytes/hashes,
  source commits and clean-Mac procedure: `runs/2026-10-01-electron-delivery.md`.

## Risks / known issues
- MANUAL_PENDING: clean macOS/TCC/download quarantine, physical HID/camera/gimbal,
  real sleep/wake, calibrated gain/latency and both 30-minute tracking soaks.
- Developer-host fresh HOME/minimal PATH is not clean-OS proof. Synthetic model
  inference is not person-detection accuracy or physical stability evidence.
- Packaged APIs use private authenticated loopback; developer CLI endpoints must
  not be exposed on a LAN. Remote control/security work is excluded.
- Historical probe timing failures and unrelated controller #3–6 drafts are
  preserved. Local exclusions: `docs/ai/issues/tracking-v1-exclusions.md`.
- #23 comment placement and #26 manager-to-API status projection are implemented
  adaptations, not literal original file/field changes; no closing keywords.
  #34/#35 human evidence remains pending. Hosted Apple release execution is not
  verified: repository signing secrets are absent and no permission to copy them
  has yet been received. Local artifacts must not be described as hosted builds.

## Test status
- Release change: 11 contract/behavior tests, actionlint, syntax and independent
  diff review pass. Full PR-level gate exits0, including actual Python38,
  UI9, smoke268 and sandbox104. Fresh mounted runtimes pass for the exact old
  manual/tracking DMGs at 22:45:57Z and 22:46:42Z; both hashes/signatures/staples
  and Gatekeeper assessments rechecked. See `runs/2026-10-01-github-release.md`.
- Manual root gate: build/page-JS, 49 focused tests, rig/profile/Sony/Pi suites,
  isolated smoke268, sandbox104; separate signing tests12, all pass.
- Final manual app and DMG Apple Accepted, strict codesign/Gatekeeper/staples
  pass. Exact final DMG runtime passes with empty error arrays:
  `runs/electron-manual-evidence/runtime-2026-10-01T20-00-00-684Z/runtime.json`.
- Tracking targeted tests, actual bundled Python mock→TS→VirtualDJI, delay sweep
  150/300/500ms, model inference and six-viewport UI checks pass in scoped runs.
  Root serial full repository tracking gate now exits0, including38/38 actual
  Python/model tests, UI9/9, smoke268 and sandbox104; latest full rerun exit0 and
  focused harness regressions5/5. Final tracking package has76 arm64 binaries,
  minimum14.0; exact final runtime passes:
  `runs/electron-tracking-evidence/runtime-2026-10-01T20-47-24-065Z/runtime.json`.
  Installed Track click, positive live-model metrics, explicit wire stops and
  owned helper/backend/parent/sleep/quit cleanup pass. Expected Sony busy retries
  and deliberately injected disconnect are retained; preview recovery passes.
  No page JS or unexpected HTTP/console/transport errors.

## Next step
Finish GitHub prerelease upload/readback and hosted PR validation; configure
hosted signing only with the user's credential authorization. Then human clean-Mac
and physical-rig smoke using the delivery/runbook instructions. Do not merge
either draft or claim physical approval. Release/test/docs changes after3711a9e
do not change the shipped tracking production source.
