# S10 — implement bounded publishing and fresh reconnect

**GitHub:** [#73](https://github.com/ajhochy/fps-camcontrol/issues/73)

## Goal

Apply the selected static-output publishing design and measured failure policy.

## Plan and scope

[Revised program streaming core](https://github.com/ajhochy/fps-camcontrol/blob/integration/combine-open-prs/docs/ai/plans/2026-10-06-program-streaming-core.md); PR #60. Milestone: Streaming M2 — Session and recording engine.
This issue delivers one step; it does not authorize the entire streaming project.

## Dependencies

[S03 / #66](https://github.com/ajhochy/fps-camcontrol/issues/66), [S07 / #70](https://github.com/ajhochy/fps-camcontrol/issues/70)

## Likely files

- `src/program/ (FFmpeg publisher/session command)`
- `src/testing/ (local receiver fault cases)`

## Acceptance criteria

- [ ] Publish the shared H.264/AAC encode as FLV over RTMPS with the selected runtime; secrets are excluded from status/logs and process-error text.
- [ ] Enforce the proven application media-age and byte bounds across relevant buffers; stall recovery resumes at a fresh decodable keyframe, never by draining old show content.
- [ ] Network failure enters reconnecting with capped proven retries while recording continues; stop intent cancels pending retry immediately. No separate encode or capture restart for publisher-only failure.

## Required tests / evaluation

Local TLS/RTMP receiver tests for connection loss, stalls, decoder joins, cancellation and recording continuity with timestamped content.

Add focused contract checks before implementation; apply the repository gates appropriate to changed code. Record commands, source SHA and observed outcomes. Separate synthetic, physical, hosted and installed evidence; missing required evidence leaves the issue open.

## Out of scope / data safety

No custom relay unless [S03 / #66](https://github.com/ajhochy/fps-camcontrol/issues/66) first revises the plan; no YouTube credentials or lifecycle API yet.

Preserve unrelated work and operator configs. Use isolated fixtures and disposable credentials; never commit tokens, stream keys, recordings or rig identifiers. Hardware/account use needs operator authorization at execution time. No production install, driver change, merge, release or public broadcast is authorized by issue creation.
