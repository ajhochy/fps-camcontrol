---
date: 2026-10-01
repo: fps-camcontrol
branch: codex/electron-tracking
pr: pending
issues: [23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 50]
status: artifact-verification-pending
tags: [run, fps-camcontrol]
index: "[[fps-camcontrol]]"
---

# Tracking integration — source-freeze checkpoint

Based on independently verified manual source
`133ae8d9620665b1e87b799a765a619ccae06ebc`; foundation draft PR57 is open.
The manual final DMG remains immutable (172838600 bytes,
SHA256 `da02312a0e65e9bfd440090cf6f7cbc0b29764a5f71685182922806855c98f11`).
Its app/DMG are Apple Accepted, stapled and Gatekeeper-assessed; exact-byte runtime
is `electron-manual-evidence/runtime-2026-10-01T20-00-00-684Z/runtime.json`.

## Files changed

New tracking TS/Python modules, real runtime/model packaging, bounded backend-owned
calibration, small Sony-preview UI extension, controller safety hooks and
contracts/tests/docs. No controller customization or production configuration
change. Only RS cancel/resume is added. Manual branch/artifact are unchanged.

## Checks run

Root `ai-workflow checks --level pr` exited **0** after final integration repairs.
It ran a real TypeScript build, emitted-page/standalone JS syntax, all focused
Node contract/security/lifecycle/control/calibration tests, existing rig/profile/
Sony tests, Pi fake-BLE tests, actual bundled-Python/model tests **38/38, zero
skips**, simulator at150/300/500ms, real TS→Python→VirtualDJI motion/override/crash
integration, runtime fixture/staging/docs tests11/11, UI9/9 across six viewports,
isolated smoke268 and sandbox104, and diff check. Serial fixed-port suites used
only the FPS sandbox. No live hardware/service/config or original checkout used.

Final full-gate UI evidence: `tracking-ui-evidence/2026-10-01T20-19-08-293Z/`.
An independent finish reviewer inspected the six images and extension behavior;
no additional functional/accessibility/craft defect was verified. The impeccable
context/craft pass kept the existing dashboard layout and Focus behavior intact.

## Failures found and repaired

- UTF-8 bearer value could trigger timingSafeEqual length error instead of403;
  byte-length guard and negative HTTP test now pass.
- Stateless API used duplicate select throttling. Actual manager now owns the
  rate limit and returns curated400/404/409/429; HTTP tests use real manager.
- Source configuration is refreshed before manager reconciliation; old targets
  stop before changed devices close. URL/config/protocol parity rejects unsafe
  decoded IDs, duplicate frame URLs, control characters and URL queries.
- All manual/tracked stops must precede helper teardown. Throwing stop methods
  now cannot skip remaining stop attempts or owned-resource cleanup.
- Actual CameraSelector/ControlStateMachine tests preserve other-camera tracking,
  same-camera override, explicit resume and emergency invalidation. Camera change
  cancels a calibration pump so a later tick cannot replay a stopped step.
- Helper readiness timeout/byte bound, failed startup cleanup, concurrent Python
  ownership, queued-image cancellation and executor parent-death issues are
  covered by executable regressions and scoped independent review.
- First root gate failed calibration video-loss timing: the test timed child
  process exit, not the normal device stop. The corrected test retains <600ms,
  requires the same-operation stop request, and measures the stop itself (2ms in
  focused evidence). It separately awaits CLI exit; the800ms cap was not relaxed.

No remote follow-up issues were created in place of fixes. Local excluded-scope
records satisfy the documentation requirement without expanding this delivery.

## Remaining gates

Freeze/commit this source, build the actual tracking app/DMG, run mounted runtime,
then Apple sign/notarize/staple and rerun the exact final bytes. Packaging/model
tests do not establish physical identity accuracy, calibrated gain/latency,
clean macOS/TCC/HID/real sleep, or either30-minute physical soak. Those remain
MANUAL_PENDING in the explicit runbook; #34/#35 will not get closing keywords.
