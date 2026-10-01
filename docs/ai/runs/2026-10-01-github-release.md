---
date: 2026-10-01
repo: fps-camcontrol
branch: codex/electron-tracking
pr: 58
issues: []
status: local-verification-passed-publication-pending
tags: [run, fps-camcontrol]
index: "[[fps-camcontrol]]"
---

### 2026-10-01 — GitHub Electron testing release workflow

- Files modified: `.github/workflows/electron_release.yml` adds PR-only validation, exact-source ARM64 builds and one dependent prerelease publisher; `.github/electron-release-sources.json` pins both commits; `scripts/electron-release.cjs` validates inputs, Apple delivery receipts, hashes and release assets; `scripts/test-electron-release.cjs` adds behavioral negative fixtures; `docs/releasing.md` explains operation and proof boundaries.
- Checks run: baseline `node --test tests/release/electron-release.test.cjs` failed 8/8 before implementation as expected; final release contract plus helper tests passed 11/11; `/opt/homebrew/bin/actionlint .github/workflows/electron_release.yml` passed; `node --check` for both helper files and `git diff --check` passed. Hosted signing/build/publish has not run in this coding slice.
- Decisions made: use the tracking PR as the workflow source and separately check out the full pinned SHA for each app; fail early if hosted Apple secrets are absent; publish only after both Apple receipts, mounted runtime checks and downloaded asset hashes match. Tag bootstrap permits an unmerged workflow. Keep embedded app version `0.1.0` distinct from the testing release label. See `docs/ai/current-plan.md`.
- Deviations from spec: none for the workflow; initial public release and full repository gate are owned by the orchestrating task.
- Concerns: repository Actions signing secrets are not configured; native hosted build/sign/notary behavior is unverified. Clean OS/TCC and physical hardware/tracking acceptance remain unverified. Existing unrelated worktree edits are preserved.

## Independent verification

- Root `ai-workflow checks --level pr` exited0 on `b06c6d2` plus the release-only
  working diff: real bundled Python/model38, UI9, isolated smoke268, sandbox104.
- Root and independent reviewer reran11 release tests and actionlint; review
  repaired certificate-rotation propagation, receipt/hash/name validation and
  missing qualification input handling before handoff. No app source changed.
- Exact manual DMG mounted runtime: `electron-manual-evidence/runtime-2026-10-01T22-45-57-760Z/runtime.json`, PASS.
- Exact tracking DMG mounted runtime: `electron-tracking-evidence/runtime-2026-10-01T22-46-42-443Z/runtime.json`, all10 criteria PASS.
- Both DMG hashes, sizes, strict signatures, staple validation and Gatekeeper
  assessment independently matched the original notarized receipt. Staged upload
  copies also pass `shasum -a 256 -c SHA256SUMS.txt`.
- One initial local staging command used repo-relative paths from the artifact
  directory and failed without copying anything; corrected relative paths passed.
  Existing original artifacts and historical evidence were not altered.
- Full hosted signing is NOT VERIFIED. No secret copy, keychain export or local
  keychain change has been performed. Source pins intentionally preserve PR57
  and PR58's app code; later release tooling does not change the shipped binaries.
