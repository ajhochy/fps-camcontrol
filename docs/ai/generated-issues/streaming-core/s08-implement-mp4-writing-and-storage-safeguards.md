# S08 — implement MP4 writing and storage safeguards

**GitHub:** [#71](https://github.com/ajhochy/fps-camcontrol/issues/71)

## Goal

Create and finalize a session recording with bounded writes and visible storage failures.

## Plan and scope

[Revised program streaming core](https://github.com/ajhochy/fps-camcontrol/blob/integration/combine-open-prs/docs/ai/plans/2026-10-06-program-streaming-core.md); PR #60. Milestone: Streaming M2 — Session and recording engine.
This issue delivers one step; it does not authorize the entire streaming project.

## Dependencies

[S04 / #67](https://github.com/ajhochy/fps-camcontrol/issues/67), [S07 / #70](https://github.com/ajhochy/fps-camcontrol/issues/70)

## Likely files

- `src/program/ (recorder)`
- `src/config/paths.ts`
- `src/testing/ (recorder cases)`

## Acceptance criteria

- [ ] Start chooses a unique non-overwriting .mp4 in the configured folder; unwritable storage or less than 1 GiB free refuses recording before any stream begins.
- [ ] Use the proven hybrid-MP4 recipe; status stays starting until media arrives and finalizing until close succeeds. Successful close is regular playable MP4.
- [ ] Below 256 MiB free or on write/queue failure, finish as safely as possible and surface a recording error without blocking the other output; no silent frame dropping to keep recording green.

## Required tests / evaluation

Temporary-volume writability/free-space simulations, slow/failing writer cases, normal close metadata and decoded-file validation.

Add focused contract checks before implementation; apply the repository gates appropriate to changed code. Record commands, source SHA and observed outcomes. Separate synthetic, physical, hosted and installed evidence; missing required evidence leaves the issue open.

## Out of scope / data safety

No recovery UI, output attachment at runtime or production-volume fault injection.

Preserve unrelated work and operator configs. Use isolated fixtures and disposable credentials; never commit tokens, stream keys, recordings or rig identifiers. Hardware/account use needs operator authorization at execution time. No production install, driver change, merge, release or public broadcast is authorized by issue creation.
