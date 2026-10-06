# Current plan — program streaming core

The [revised implementation plan](plans/2026-10-06-program-streaming-core.md) applies the architecture and ponytail reviews authorized on 2026-10-06. The [atomic backlog](generated-issues/streaming-core/README.md) contains 26 published single-deliverable issues (#64–#89) grouped into six milestones (#11–#16), plus existing #63 as the DeckLink prerequisite.

## Intent and constraints

Replace Wirecast's finished-program streaming/recording role with scheduled YouTube events, MP4 recording, local audio monitoring and measured video delay. New streaming functionality ships in Electron first; retain existing CLI/iPad camera controls and preview. One capture owner, responsive camera safety, bounded media, isolated network/storage failures and protected credentials are mandatory.

Select Record only or Stream + record before Start; normal Stop ends session outputs together. A running stream survives recording failure; a recording survives network failure. Initial recording failure prevents Go Live. Arbitrary output attachment, stream-only mode, CLI streaming, effects, event creation, manual-key UI, separate Test Stream and in-app audio-output selection are deferred. Use macOS output selection and one Listen toggle/volume.

## Clarification interview

Prior answers established core-first scope and MP4 default. The user explicitly accepted both review passes on 2026-10-06; these revisions apply those decisions without reopening the interview. Actual input mode, runtime delivery, static-output failure behavior, clock options and teardown budget remain evidence gates documented in S01–S05, not presumed facts.

## Prior art and cheapest proof

Reuse prior FFmpeg/YouTube/Web Audio research linked in the detailed plan. First resolve existing #63 and prove actual UltraStudio video/stereo capture. Then use the pinned runtime to demonstrate static tee/fifo outputs, MP4 crash recovery and repeated-content sync. Record the selected architecture from results; a custom Node media relay is not pre-approved. Secure credential work can proceed independently.

## Ordered milestones

| Milestone | Steps | Exit evidence |
| --- | --- | --- |
| M1 — Rig and media proof | #63, S01–S05 | Real input contract, pinned runtime, minimal output architecture, MP4 recovery and timing |
| M2 — Session and recording engine | S06–S12 | Sole capture owner, qualified config/locks, MP4, recovery, bounded publishing, coupled lifecycle and cleanup |
| M3 — Audio monitoring and sync | S13–S15 | Bounded PCM, audible clock-corrected monitor, isolated volume and persisted measured delay |
| M4 — Scheduled YouTube events | S16–S20 | Secure credentials, OAuth, bound-event resolution, confirmed Go Live/status/End |
| M5 — Operator workflow | S21–S22 | Protected Electron adapters and the complete core Streaming page |
| M6 — Packaging and qualification | S23–S26 | Both variants, camera-load regression, two-hour hosted rig session and clean-Mac evidence |

Every step's likely files, acceptance, evaluation and dependencies are in the [issue index](generated-issues/streaming-core/README.md). Milestone ordering does not override the issue DAG; independent credential work may proceed early.

## Status and handoff

Existing boundary: iPad remote currently works through CLI; Electron is loopback-only. Preserving those paths does not add simultaneous iPad access to Electron. Treat that as a separate rollout prerequisite if required; never launch two competing capture owners.

Documentation and issue planning only. No streaming code, runtime tests, hardware capture, driver changes, OAuth login, broadcast, merge, deployment or release performed. Target is open PR #60, `integration/combine-open-prs`, based on verified head `dd224d0` for this revision. Keep all future implementation issues open until their own acceptance passes.

Before implementation, compact the conversation and start one issue from the saved backlog. The prior [Electron release/packaging plan](plans/2026-10-01-electron-release-and-packaging.md) retains its separate qualification gates.
