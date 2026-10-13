---
date: 2026-10-01
repo: fps-camcontrol
branch: codex/electron-tracking
pr: 58
issues: [23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 50]
status: delivered-draft-human-gates-pending
tags: [run, fps-camcontrol]
index: "[[fps-camcontrol]]"
---

# Tracking integration — final delivery

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

## Final artifact gates

Production source frozen at3711a9e6475633a6cf889850ba3a23843a12c450 and built with
zero tracked changes; only three preserved unrelated drafts were untracked.
Final trackerDMG288543586bytes, SHA256
`5c021b66d2433df630677c4cab95fc3019e5617e134afc5dd094f967e4c81652`.
App and DMG AppleAccepted/staples/strict codesign/Gatekeeper PASS; final exact
mounted runtime20-47-24-065Z PASS, startup4018ms. Installed Track click calls the
actual backend; genuine live bundled model reports positive finite inference and
curated no_target; explicit wire stops0.315/1.956ms before unchanged250ms watchdog.
Helper/backend/parent/simulatedsleep/normalquit ownership and recovered previews
pass. Root latest fullgate13369 exit0 and harness regressions5/5.

Independent test review repaired a `/var` alias discovery assumption and added
actual live-model outcome and wire-stop assertions. Three final-byte diagnostic
failures also remain preserved: an all-phase console-empty assumption rejected
intended Sony503 backpressure and an in-flight GET after deliberate backend kill.
Fresh route/phase/header/body recon and strict negative fixtures distinguish only
those expected observations; unknown HTTP/console/transport and all JS errors
still fail. Final report retains one503 retry and one injected disconnect, and
requires successful preview recovery. No shipping code changed after source
freeze; later commit contains only tests/evidence/project-state updates.

Both draft links, full metadata, matrix and clean-Mac smoke instructions are in
`2026-10-01-electron-delivery.md` and `electron-delivery-receipt-2026-10-01.json`.
No hosted CI is configured; no local result is called a CI pass.

## Remaining human acceptance

Packaging/model tests do not establish physical identity accuracy, calibrated
gain/latency, clean macOS/TCC/HID/real sleep, or either30-minute physical soak.
These remain MANUAL_PENDING; #34/#35 get no closing keywords. #23 comment placement
and #26 manager-to-statusAPI rather than duplicated AppState storage are explicit
acceptance adaptations, also left open. PR58 closes only24,25,27–33,50.
