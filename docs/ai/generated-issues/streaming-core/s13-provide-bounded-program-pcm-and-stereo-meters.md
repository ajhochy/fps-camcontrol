# S13 — provide bounded program PCM and stereo meters

## Goal

Deliver the capture owner’s stereo audio to a local monitoring consumer without production backpressure.

## Plan and scope

[Revised program streaming core](https://github.com/ajhochy/fps-camcontrol/blob/integration/combine-open-prs/docs/ai/plans/2026-10-06-program-streaming-core.md); PR #60. Milestone: Streaming M3 — Audio monitoring and sync.
This issue delivers one step; it does not authorize the entire streaming project.

## Dependencies

S07

## Likely files

- `src/program/ (audio tap and meters)`
- `src/ui/ (audio WebSocket adapter)`
- `src/testing/ (slow consumer cases)`

## Acceptance criteria

- [ ] Idle capture produces explicitly described stereo PCM frames with sample rate/timing and peak/RMS values; no recording or publishing is needed to hear the source.
- [ ] A disconnected/slow monitor consumer is dropped or rebuffered within the bounded policy; encoded stream/recording samples and capture progress remain unaffected.
- [ ] Only the authenticated Electron-local session can subscribe; no media payload, secret or source credential enters logs.

## Required tests / evaluation

Known stereo tones, peak/RMS checks, slow/disconnected consumer pressure and unauthorized subscriptions.

Add focused contract checks before implementation; apply the repository gates appropriate to changed code. Record commands, source SHA and observed outcomes. Separate synthetic, physical, hosted and installed evidence; missing required evidence leaves the issue open.

## Out of scope / data safety

No channel mixer, multichannel selector, output-device picker or worklet implementation.

Preserve unrelated work and operator configs. Use isolated fixtures and disposable credentials; never commit tokens, stream keys, recordings or rig identifiers. Hardware/account use needs operator authorization at execution time. No production install, driver change, merge, release or public broadcast is authorized by issue creation.
