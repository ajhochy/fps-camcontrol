# S19 — drive Go Live through confirmed YouTube transitions

## Goal

Connect recorder-first startup to the selected scheduled broadcast.

## Plan and scope

[Revised program streaming core](https://github.com/ajhochy/fps-camcontrol/blob/integration/combine-open-prs/docs/ai/plans/2026-10-06-program-streaming-core.md); PR #60. Milestone: Streaming M4 — Scheduled YouTube events.
This issue delivers one step; it does not authorize the entire streaming project.

## Dependencies

S11, S18

## Likely files

- `src/youtube/ (broadcast lifecycle)`
- `src/program/ (session integration)`
- `src/testing/ (lifecycle fixtures)`

## Acceptance criteria

- [ ] Go Live re-resolves the pinned event, verifies recorder readiness, begins ingest and waits for YouTube stream active before required testing/live transitions.
- [ ] Poll asynchronous states and show Sending until Live is confirmed; auto-start behavior is disclosed before the explicit action. Preview/Listen never begins ingest.
- [ ] Canceled/duplicate actions, invalid transitions and startup API failures leave an explicit state with preserved recordings and no unintended event mutation.

## Required tests / evaluation

Fixtures for auto-start on/off, monitor stream enabled/disabled, transition-in-progress, timeout/cancel and recorder-start failure; authorized disposable event for hosted evidence.

Add focused contract checks before implementation; apply the repository gates appropriate to changed code. Record commands, source SHA and observed outcomes. Separate synthetic, physical, hosted and installed evidence; missing required evidence leaves the issue open.

## Out of scope / data safety

No separate Test Stream workflow, silent setting changes or independent output start.

Preserve unrelated work and operator configs. Use isolated fixtures and disposable credentials; never commit tokens, stream keys, recordings or rig identifiers. Hardware/account use needs operator authorization at execution time. No production install, driver change, merge, release or public broadcast is authorized by issue creation.
