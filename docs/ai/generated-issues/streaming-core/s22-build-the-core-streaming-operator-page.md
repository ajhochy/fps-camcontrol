# S22 — build the core Streaming operator page

## Goal

Expose the accepted workflow on one page with useful progress and failure states.

## Plan and scope

[Revised program streaming core](https://github.com/ajhochy/fps-camcontrol/blob/integration/combine-open-prs/docs/ai/plans/2026-10-06-program-streaming-core.md); PR #60. Milestone: Streaming M5 — Operator workflow.
This issue delivers one step; it does not authorize the entire streaming project.

## Dependencies

S21

## Likely files

- `ui/streaming/ (new page/assets)`
- `ui/ (dashboard navigation)`

## Acceptance criteria

- [ ] Operator can select Record only or Stream + record, set folder/bitrate/pre-session delay, connect YouTube/select an event, then Start/Go Live and Stop/End session.
- [ ] Framing preview, stereo meters, Listen and monitor volume appear alongside signal, Sending/confirmed Live, recording duration/path/free space and finalizing/recovery status. Camera controls remain reachable.
- [ ] Empty events, missing input/audio, unsupported runtime, failed storage and expired login have actionable messages; preview is labeled unsuitable for lipsync, and calibration uses short record-only playback. No manual-key/device-picker/Test Stream/independent-output UI.

## Required tests / evaluation

Isolated fake-media/YouTube UI checks for complete happy path, disabled/conflicting actions and each error state; inspect layout alongside camera controls.

Add focused contract checks before implementation; apply the repository gates appropriate to changed code. Record commands, source SHA and observed outcomes. Separate synthetic, physical, hosted and installed evidence; missing required evidence leaves the issue open.

## Out of scope / data safety

No redesign of unrelated pages, effects, scene composition or iPad streaming controls.

Preserve unrelated work and operator configs. Use isolated fixtures and disposable credentials; never commit tokens, stream keys, recordings or rig identifiers. Hardware/account use needs operator authorization at execution time. No production install, driver change, merge, release or public broadcast is authorized by issue creation.
