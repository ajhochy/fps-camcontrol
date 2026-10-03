# Delivery validation observations

## 2026-10-01 — Tracking final package — expected recovery observations

- Result: final exact-byte runtime PASS after preserving three diagnostic FAILs.
- Category: test-observation mismatch, not a shipping-code repair; final C-category none.
- Cause: unconditional console-empty logic treated intended Sony reconnect503 and
  a preview GET against a deliberately killed backend as normal-operation errors.
- Repair: capture exactphase/route/header/body/terminatedorigin; allow only paired,
  identified observations, reject every unexpected error and allJS errors, and
  require decoded non-stale preview recovery. Negative fixtures5/5; independent review.
- Final evidence: runtime20-47-24-065Z, finalDMG SHA5c021b66d2433df630677c4cab95fc3019e5617e134afc5dd094f967e4c81652.
- No final runtime claim of zero console errors, cleanOS or physical safety.

## 2026-10-01 — Tracking package — process path alias

- Result: candidate mounted smoke failed twice before overall artifact acceptance;
  bundled-model/protocol sub-proof passed. No final installer pass was claimed.
- Category: C5, macOS process-path alias in test discovery.
- Criterion: issue-50-c4 plus full-app owned-helper lifecycle.
- Cause: raw `/var` prefix failed to match observed `/private/var` executable.
- Repair: fresh PID/PPID/comm recon, canonical exact interpreter and same PPID,
  negative foreign-parent/runtime regression. Candidate lifecycle passed afterward.
- Independent review also strengthened final checks to reject UI errors, distinguish
  live `no_target` from `source_unavailable`, and measure actual stop commands before
  the unchanged virtual watchdog. Final-byte rerun remains mandatory.
- No production code changed after source3711a9e, no failed report overwritten,
  and no remote follow-up substituted for a repair.

## 2026-10-01 — Manual package — macOS HOME isolation

- Result: actual mounted-DMG runtime failed; full verification had not claimed pass.
- Category: C3, wrong implementation; no contract-versus-smoke false-green claim.
- Criterion: manual package c7 (userData isolation/persistence).
- Cause: Electron's default macOS data directory did not follow the supplied HOME.
- Repair: derive the intended appData/userData before startup, assert containment,
  then rerun the actual mounted app. Preserve accidentally created generic files.
- Related review: denied hardware lock must guard every launch path; managed Sony
  child ownership needs parent-death cleanup; graceful timeout is not force-exit proof.
- Tracking: repaired inside the current delivery, not deferred to new tasks.
