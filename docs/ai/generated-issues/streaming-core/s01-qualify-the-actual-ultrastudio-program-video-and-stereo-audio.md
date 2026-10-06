# S01 — qualify the actual UltraStudio program video and stereo audio

## Goal

Record the real capture contract before selecting the production profile.

## Plan and scope

[Revised program streaming core](https://github.com/ajhochy/fps-camcontrol/blob/integration/combine-open-prs/docs/ai/plans/2026-10-06-program-streaming-core.md); PR #60. Milestone: Streaming M1 — Rig and media proof.
This issue delivers one step; it does not authorize the entire streaming project.

## Dependencies

#63

## Likely files

- `docs/program-feed.md`
- `docs/ai/runs/ (new capture qualification receipt)`
- `scripts/ (targeted capture probe)`

## Acceptance criteria

- [ ] On an operator-approved rig session, the sole capture process records a short program clip with identifiable picture and audible embedded stereo; document the actual left/right mapping.
- [ ] Receipt includes source SHA, FFmpeg hash/build flags, device, SDK/driver versions, native resolution, rational fps, pixel format and interlacing. Refresh issue #63 evidence instead of assuming the old versions remain installed.
- [ ] If capture or audio fails, or conversion is required for interlaced input, record the blocker and update the qualified-profile decision; do not mark this task complete from synthetic media or silently change rig settings.

## Required tests / evaluation

Inspect the recorded clip and ffprobe metadata; operator confirms channels and input format. No driver/firmware change. This issue is complete only with real capture evidence.

Add focused contract checks before implementation; apply the repository gates appropriate to changed code. Record commands, source SHA and observed outcomes. Separate synthetic, physical, hosted and installed evidence; missing required evidence leaves the issue open.

## Out of scope / data safety

Does not duplicate #63 SDK repair, add arbitrary devices, or qualify streaming yet.

Preserve unrelated work and operator configs. Use isolated fixtures and disposable credentials; never commit tokens, stream keys, recordings or rig identifiers. Hardware/account use needs operator authorization at execution time. No production install, driver change, merge, release or public broadcast is authorized by issue creation.
