# S23 — package the chosen media runtime in both Electron variants

## Goal

Extend existing installer packaging for the selected runtime and credential integration.

## Plan and scope

[Revised program streaming core](https://github.com/ajhochy/fps-camcontrol/blob/integration/combine-open-prs/docs/ai/plans/2026-10-06-program-streaming-core.md); PR #60. Milestone: Streaming M6 — Packaging and qualification.
This issue delivers one step; it does not authorize the entire streaming project.

## Dependencies

S02, S12, S16, S22

## Likely files

- `scripts/package-electron-manual.cjs`
- `scripts/ (tracking package allowlist/runtime manifest)`
- `electron/`
- `docs/electron.md`

## Acceptance criteria

- [ ] Manual and tracking variants include intended new modules/runtime/helper files and retain their identities; exact source and binary hashes plus notices are recorded.
- [ ] On minimal PATH, resolve the pinned runtime from packaged resources or the explicitly configured qualified DeckLink override; missing capabilities produce setup guidance rather than hidden downloads.
- [ ] Sign nested binaries using existing release workflow; installer includes documented Desktop Video prerequisites and no rig configuration or secrets. Link existing #47/#50/#52 work rather than rebuild those systems.

## Required tests / evaluation

Both package allowlist/signature/capability inspections and installed runtime resolution using disposable app data; signing credentials remain operator-controlled.

Add focused contract checks before implementation; apply the repository gates appropriate to changed code. Record commands, source SHA and observed outcomes. Separate synthetic, physical, hosted and installed evidence; missing required evidence leaves the issue open.

## Out of scope / data safety

No release publication, auto-updater redesign, driver installer or production install.

Preserve unrelated work and operator configs. Use isolated fixtures and disposable credentials; never commit tokens, stream keys, recordings or rig identifiers. Hardware/account use needs operator authorization at execution time. No production install, driver change, merge, release or public broadcast is authorized by issue creation.
