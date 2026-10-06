# S14 — implement Listen playback with sample-rate and clock correction

**GitHub:** [#77](https://github.com/ajhochy/fps-camcontrol/issues/77)

## Goal

Render program audio through one Listen toggle and volume using the OS-selected device.

## Plan and scope

[Revised program streaming core](https://github.com/ajhochy/fps-camcontrol/blob/integration/combine-open-prs/docs/ai/plans/2026-10-06-program-streaming-core.md); PR #60. Milestone: Streaming M3 — Audio monitoring and sync.
This issue delivers one step; it does not authorize the entire streaming project.

## Dependencies

[S13 / #76](https://github.com/ajhochy/fps-camcontrol/issues/76)

## Likely files

- `ui/streaming/ (AudioWorklet and monitor controller)`
- `src/testing/ (monitor harness)`

## Acceptance criteria

- [ ] Listen defaults off; enabling it plays stereo and volume changes only monitor gain. No separate mute or app device picker.
- [ ] Explicit sample-rate conversion and gradual clock correction handle mismatched capture/AudioContext rates; normal clock drift does not cause recurring hard sample drops.
- [ ] Queue targets ~100 ms and caps at 250 ms; underruns produce defined silence/rebuffer behavior and recovery handles suspend/resume and OS device changes. Target-rig measured headphone latency is below 250 ms.

## Required tests / evaluation

Synthetic rate/skew/underrun and suspended-context cases, recorded-output identity under volume changes, plus authorized headphone latency measurement.

Add focused contract checks before implementation; apply the repository gates appropriate to changed code. Record commands, source SHA and observed outcomes. Separate synthetic, physical, hosted and installed evidence; missing required evidence leaves the issue open.

## Out of scope / data safety

No lipsync claim from MJPEG and no native audio helper unless evidence first changes the plan.

Preserve unrelated work and operator configs. Use isolated fixtures and disposable credentials; never commit tokens, stream keys, recordings or rig identifiers. Hardware/account use needs operator authorization at execution time. No production install, driver change, merge, release or public broadcast is authorized by issue creation.
