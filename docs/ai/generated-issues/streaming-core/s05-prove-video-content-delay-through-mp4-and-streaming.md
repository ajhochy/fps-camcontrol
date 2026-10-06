# S05 — prove video content delay through MP4 and streaming

## Goal

Establish exact timestamp/filter options that preserve a requested positive video delay.

## Plan and scope

[Revised program streaming core](https://github.com/ajhochy/fps-camcontrol/blob/integration/combine-open-prs/docs/ai/plans/2026-10-06-program-streaming-core.md); PR #60. Milestone: Streaming M1 — Rig and media proof.
This issue delivers one step; it does not authorize the entire streaming project.

## Dependencies

S03

## Likely files

- `scripts/ (flash/impulse media proof)`
- `docs/ai/decisions/ (sync recipe)`
- `docs/ai/runs/ (timing evidence)`

## Acceptance criteria

- [ ] At the qualified rig rate, repeated flashes/audio impulses show video delays of 0/1/3/15 frames within one frame in both MP4 and local RTMP playback.
- [ ] At the beginning, middle, end and after publisher reconnect, relative A/V timing is preserved; a 60-minute run drifts by less than one output frame.
- [ ] Document common-origin handling, rational conversions, frame pacing and mux buffer limits; arithmetic covers 30000/1001 and 60000/1001 without claiming untested hardware modes.

## Required tests / evaluation

Decode and compare content event times, not only first PTS or leading padding; retain exact commands and machine-readable measurements.

Add focused contract checks before implementation; apply the repository gates appropriate to changed code. Record commands, source SHA and observed outcomes. Separate synthetic, physical, hosted and installed evidence; missing required evidence leaves the issue open.

## Out of scope / data safety

No live delay adjustment or broad capture-device matrix.

Preserve unrelated work and operator configs. Use isolated fixtures and disposable credentials; never commit tokens, stream keys, recordings or rig identifiers. Hardware/account use needs operator authorization at execution time. No production install, driver change, merge, release or public broadcast is authorized by issue creation.
