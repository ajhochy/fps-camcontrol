# S09 — recover interrupted MP4 recordings without overwriting originals

**GitHub:** [#72](https://github.com/ajhochy/fps-camcontrol/issues/72)

## Goal

Expose the proven recovery operation for a chosen interrupted recording.

## Plan and scope

[Revised program streaming core](https://github.com/ajhochy/fps-camcontrol/blob/integration/combine-open-prs/docs/ai/plans/2026-10-06-program-streaming-core.md); PR #60. Milestone: Streaming M2 — Session and recording engine.
This issue delivers one step; it does not authorize the entire streaming project.

## Dependencies

[S08 / #71](https://github.com/ajhochy/fps-camcontrol/issues/71)

## Likely files

- `src/program/ (recording recovery)`
- `src/ui/ (local recovery action contract)`
- `src/testing/ (recovery cases)`

## Acceptance criteria

- [ ] Recovery writes a unique separate regular MP4 and leaves the original unchanged, including when remuxing fails or storage fills.
- [ ] Validate recovered streams/duration/content using the [S04 / #67](https://github.com/ajhochy/fps-camcontrol/issues/67) recipe before reporting success; report partial recovery explicitly.
- [ ] Repeated recovery requests cannot overwrite an original or another recovered file; bounded child lifetime and sanitized errors are retained.

## Required tests / evaluation

Compare original hashes before/after success/failure; damaged/truncated fixture cases and duplicate-action checks.

Add focused contract checks before implementation; apply the repository gates appropriate to changed code. Record commands, source SHA and observed outcomes. Separate synthetic, physical, hosted and installed evidence; missing required evidence leaves the issue open.

## Out of scope / data safety

No directory-wide automatic repair, deletion of originals or standalone media-library feature.

Preserve unrelated work and operator configs. Use isolated fixtures and disposable credentials; never commit tokens, stream keys, recordings or rig identifiers. Hardware/account use needs operator authorization at execution time. No production install, driver change, merge, release or public broadcast is authorized by issue creation.
