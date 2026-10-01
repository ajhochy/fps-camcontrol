# Delivery validation observations

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
