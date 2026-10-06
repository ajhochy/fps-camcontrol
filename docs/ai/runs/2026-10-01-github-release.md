---
date: 2026-10-01
repo: fps-camcontrol
branch: codex/electron-tracking
pr: 58
issues: []
status: testing-release-published-hosted-signing-unverified
tags: [run, fps-camcontrol]
index: "[[fps-camcontrol]]"
---

### 2026-10-01 — GitHub Electron testing release workflow

- Files modified: `.github/workflows/electron_release.yml` adds PR-only validation, exact-source ARM64 builds and one dependent prerelease publisher; `.github/electron-release-sources.json` pins both commits; `scripts/electron-release.cjs` validates inputs, Apple delivery receipts, hashes and release assets; `scripts/test-electron-release.cjs` adds behavioral negative fixtures; `docs/releasing.md` explains operation and proof boundaries.
- Checks run: baseline `node --test tests/release/electron-release.test.cjs` failed 8/8 before implementation as expected; final release contract plus helper tests passed 11/11; `/opt/homebrew/bin/actionlint .github/workflows/electron_release.yml` passed; `node --check` for both helper files and `git diff --check` passed. Hosted signing/build/publish has not run in this coding slice.
- Decisions made: use the tracking PR as the workflow source and separately check out the full pinned SHA for each app; fail early if hosted Apple secrets are absent; publish only after both Apple receipts, mounted runtime checks and downloaded asset hashes match. Tag bootstrap permits an unmerged workflow. Keep embedded app version `0.1.0` distinct from the testing release label. See `docs/ai/current-plan.md`.
- Deviations from spec: initial publication uses existing qualified local DMGs because GitHub signing secrets are absent. The release is explicitly local-build, not hosted-build evidence. No app source/version was changed or rebuilt merely for publication.
- Concerns: repository Actions signing secrets are not configured; native hosted build/sign/notary behavior is unverified. Clean OS/TCC and physical hardware/tracking acceptance remain unverified. Existing unrelated worktree edits are preserved.

## Independent verification

- Root `ai-workflow checks --level pr` exited0 on `b06c6d2` plus the release-only
  working diff: real bundled Python/model38, UI9, isolated smoke268, sandbox104.
- Root and independent reviewer reran11 release tests and actionlint; review
  repaired certificate-rotation propagation, receipt/hash/name validation and
  missing qualification input handling before handoff. No app source changed.
- Independent `ai-workflow checks --level issue` exited0 against the same release
  code. Final root and independent release/signing tests pass23/23 at committed
  workflow source `888ee3c64a6e4b1d6024b2b1014d3399213c04ba`; actionlint and
  `git diff --check` also exit0. A root recap initially misspelled the signing-test
  filename; the actual `scripts/test-electron-signing.cjs` was then run explicitly
  with all12 signing tests included in the23-test result.
- Hosted PR validation succeeded:
  https://github.com/ajhochy/fps-camcontrol/actions/runs/36938086068
  at workflow source888ee3c. Only `validate-pr` ran; `plan`, the macOS build matrix
  and publisher were skipped by design. This is not hosted Apple-build evidence.
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

## Published release and readback

- Public prerelease, published `2026-10-01T23:07:04Z`:
  https://github.com/ajhochy/fps-camcontrol/releases/tag/electron-local-testing-2026.10.01
  Tag targets workflow source `888ee3c64a6e4b1d6024b2b1014d3399213c04ba`.
  It is not a stable/latest release and does not match the hosted-build tag trigger.
- Manual: `FPS-CamControl-manual-0.1.0-arm64.dmg`, 172838600 bytes,
  SHA-256 `da02312a0e65e9bfd440090cf6f7cbc0b29764a5f71685182922806855c98f11`,
  app source `133ae8d9620665b1e87b799a765a619ccae06ebc`, PR57, macOS13+.
- Tracking: `FPS-CamControl-tracking-0.1.0-arm64.dmg`, 288543586 bytes,
  SHA-256 `5c021b66d2433df630677c4cab95fc3019e5617e134afc5dd094f967e4c81652`,
  app source `3711a9e6475633a6cf889850ba3a23843a12c450`, PR58, macOS14+.
- Both embed version0.1.0. Public `release-manifest.json` preserves the original
  source/identity, exact Apple acceptance IDs and local-build provenance;
  `SHA256SUMS.txt` provides the two artifact checksums.
- Before publication, `gh release download` fetched all four draft assets into
  a fresh directory. `shasum -a 256 -c SHA256SUMS.txt` returned both OK; metadata
  `cmp` and manifest byte-size assertions exited0.
- After publication, fresh `curl -q --fail --location` downloads used the public
  URLs without authentication. Both DMG checksums and sizes again matched;
  both public metadata files were byte-identical to the draft/original receipts.
  Public readback completed at23:08Z. This satisfies release-c9, not clean-OS/TCC.
- Both PRs remain drafts with their original bases; PR57 and main were unchanged.
  No Apple credentials were copied/exported, no keychain changed, no source PR
  merged, no artifact overwritten and no worktree/user files removed.
- Remaining: authorized GitHub secret setup and full hosted qualification;
  genuinely clean macOS/TCC and physical HID/camera/gimbal/real-person tracking
  smoke plus calibration and30-minute soaks. These are not implied by publication.
