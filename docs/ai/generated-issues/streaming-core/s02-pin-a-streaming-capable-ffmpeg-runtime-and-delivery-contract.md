# S02 — pin a streaming-capable FFmpeg runtime and delivery contract

## Goal

Select a reproducible runtime containing every required capture, encode, mux and TLS capability.

## Plan and scope

[Revised program streaming core](https://github.com/ajhochy/fps-camcontrol/blob/integration/combine-open-prs/docs/ai/plans/2026-10-06-program-streaming-core.md); PR #60. Milestone: Streaming M1 — Rig and media proof.
This issue delivers one step; it does not authorize the entire streaming project.

## Dependencies

#63

## Likely files

- `scripts/ (runtime manifest/build instructions)`
- `docs/program-feed.md`
- `docs/ai/decisions/ (runtime decision)`

## Acceptance criteria

- [ ] Publish version, hash, provenance and capability output for FFmpeg/ffprobe: DeckLink, VideoToolbox H.264, AAC, RTMPS/TLS, FLV, tee/fifo and hybrid_fragmented MP4.
- [ ] Record compatible SDK/driver requirements and the chosen delivery path: bundled redistributable binary or an explicitly supplied, capability-checked DeckLink binary. No reliance on Homebrew/PATH in installed use.
- [ ] Inventory exact license/build flags and required notices/source availability; no nonfree binary. Reuse relevant work from #52/#53; missing permissions/build ingredients remain explicit blockers.

## Required tests / evaluation

Run capability probes against the pinned binary and a synthetic H.264/AAC MP4; verify the delivery manifest matches actual files. No installer or driver mutation.

Add focused contract checks before implementation; apply the repository gates appropriate to changed code. Record commands, source SHA and observed outcomes. Separate synthetic, physical, hosted and installed evidence; missing required evidence leaves the issue open.

## Out of scope / data safety

Preview-only FFmpeg from #63 is insufficient. Packaging implementation belongs to S23.

Preserve unrelated work and operator configs. Use isolated fixtures and disposable credentials; never commit tokens, stream keys, recordings or rig identifiers. Hardware/account use needs operator authorization at execution time. No production install, driver change, merge, release or public broadcast is authorized by issue creation.
