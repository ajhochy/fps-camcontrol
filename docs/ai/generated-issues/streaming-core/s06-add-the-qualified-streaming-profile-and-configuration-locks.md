# S06 — add the qualified streaming profile and configuration locks

## Goal

Persist a narrow, validated profile without allowing active-session reconfiguration.

## Plan and scope

[Revised program streaming core](https://github.com/ajhochy/fps-camcontrol/blob/integration/combine-open-prs/docs/ai/plans/2026-10-06-program-streaming-core.md); PR #60. Milestone: Streaming M2 — Session and recording engine.
This issue delivers one step; it does not authorize the entire streaming project.

## Dependencies

S01, S03, S05

## Likely files

- `src/config/configLoader.ts`
- `src/program/ (broadcast config)`
- `src/ui/ (legacy program/config write routes)`

## Acceptance criteria

- [ ] Existing configurations load with streaming idle/disabled; qualified source/profile, bitrate, folder and integer videoDelayFrames 0–15 persist without changing preview fps/width semantics.
- [ ] Unsupported input profiles and invalid fields produce specific validation errors; do not silently choose another codec, source or frame rate.
- [ ] While an output session runs, every write route that can alter source/profile/encoding/delay/folder rejects that change visibly; unrelated camera controls remain usable.

## Required tests / evaluation

Config migration/round-trip and boundary assertions, plus route checks for both the new config adapter and legacy profile/source edits.

Add focused contract checks before implementation; apply the repository gates appropriate to changed code. Record commands, source SHA and observed outcomes. Separate synthetic, physical, hosted and installed evidence; missing required evidence leaves the issue open.

## Out of scope / data safety

No broad profile catalog, secrets in config or edits to the operator’s existing rig files.

Preserve unrelated work and operator configs. Use isolated fixtures and disposable credentials; never commit tokens, stream keys, recordings or rig identifiers. Hardware/account use needs operator authorization at execution time. No production install, driver change, merge, release or public broadcast is authorized by issue creation.
