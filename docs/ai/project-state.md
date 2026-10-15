---
type: project
---

# Project State — fps-camcontrol

## Current focus

2026-10-15 DeckLink capture helper (#63/#64/#65 delivery path): `native/decklink-capture/` (C++17, SDK 14.2 via `DECKLINK_SDK_DIR`, never vendored) captures the UltraStudio Recorder 3G and writes live Matroska (DeckLink stream-time PTS, UYVY + PCM) into the ONE session FFmpeg; `src/broadcast/decklinkCapture.ts` + `captureTeeArgs` wire helper -> tee/fifo (MP4 slave 0 + local RTMP), profile 1080p `30/1`. Real <=20 s capture verified (601/600 frames, 1920x1080 30/1, no decode errors, monotonic, AAC track present, picture confirmed); input currently carries no embedded audio (digital silence). Signal-loss/disconnect on the real card, embedded audio, pinned FFmpeg (#65) and #67/#68 on this path remain open. See [ADR addendum](decisions/2026-10-13-streaming-session-architecture.md) and [run note](runs/2026-10-15-decklink-capture-helper.md).

2026-10-13 #66 progress: synthetic proof that one static FFmpeg `tee` + `fifo` process meets the stream+record isolation contract (recording 1020/1020 frames across publisher outages; stalled publisher never blocks the encoder; reconnect at a key frame with no stale replay; L/R channel content intact; initial recording failure needs a supervisor-owned recording descriptor). Decision: [static tee/fifo, S1 Node TS relay superseded](decisions/2026-10-13-streaming-session-architecture.md); evidence in [run note](runs/2026-10-13-streaming-s03-tee-proof.md). Developer runtime/synthetic only: #66 stays open (pinned runtime, rig, TLS/YouTube, AJ approval).

2026-10-13 preservation only: restored the two existing synthetic recovery fixtures (13,976 bytes total), with exact historical SHA-256 matches. `--recovery-contract` now has its referenced fixtures present in this worktree; no recovery/pipeline tests or builds reran, and runtime qualification/full S1 remain unresolved. See [preservation inventory](runs/2026-10-13-streaming-fixture-preservation.md). The Oct7 receipt below is retained as historical context, not the current fixture-presence state.

2026-10-07: streaming code is preserved in draft [PR #90](https://github.com/ajhochy/fps-camcontrol/pull/90), branch `feat/streaming-s1-media-proof`. Bounded WIP publication verification passed; **full S1 is NOT READY**. Recorded developer 20-case matrix, 44 decoded comparisons and 60-minute soak passed; broad checks failed/hung. Actual publisher reconnect, channel-1 content, network/internal queues, architecture reconciliation and independent full S1 qualification remain pending. `--recovery-contract` requires unpublished local synthetic fixtures; it is not fresh-checkout self-contained. See [current handoff](runs/2026-10-07-streaming-s1.md), [checkpoint results](runs/2026-10-07-streaming-checkpoint-results.json) and [publication contract](contracts/streaming-wip-publication.json). Physical Blackmagic installation/tests remain AJ's separate handoff.

Canonical product streaming remains planned, not integrated. The user accepted both plan reviews: real capture proof first, conditional media architecture, coupled sessions, MP4 default, Electron-only new streaming, OS audio routing, explicit queue-age/signal/clock behavior. See [plan](plans/2026-10-06-program-streaming-core.md) and [26-step backlog](generated-issues/streaming-core/README.md). Oct7 manager-authorized independent-remux/Node-relay exception is limited to S1; canonical architecture reconciliation remains unresolved, not AJ-specific architecture approval.

## Active branch / PR

Open integration PR #60 (`integration/combine-open-prs`), verified planning base `dd224d0`; PR #62 is merged. This revision changes docs and GitHub planning metadata only. The primary checkout's unrelated changes are preserved. Historical integration/release/tracking receipts and previous snapshot are retained in [pre-revision context](runs/2026-10-06-pre-streaming-revision-context.md); those are historical evidence, not new qualification.

## In progress

Six streaming milestones (#11–#16) with 26 atomic new issues (#64–#89); existing #63 is assigned to the first milestone and owns the DeckLink SDK/driver prerequisite. New output sessions use Record only or Stream + record, with shared start/stop; arbitrary output attachment and a Node TS relay are deferred. Existing CLI/iPad camera/preview operation remains; new broadcast administration is Electron-local.

## Risks / known issues

- Existing iPad remote is CLI-only; Electron is authenticated loopback-only. This scope preserves that boundary, not simultaneous iPad access to Electron. If needed for rollout, address separately without competing capture owners.

- #63 reports SDK 16 versus Desktop Video 14.2 incompatibility and preview-only FFmpeg; refresh versions before work. No driver change is authorized. Actual program format/audio and streaming-capable runtime remain unqualified.
- Static tee/fifo passed synthetic failure-isolation and one-second application-queue tests (2026-10-13 ADR); loopback kernel socket buffering (~3 s) is outside the fifo and bounded only by `rw_timeout`. Rig, pinned-runtime and YouTube confirmation remain open.
- MP4 recovery, shutdown budget, content sync and monitoring clocks require measured evidence. Google setup/consent and operator-authorized rig/account access are external gates.
- Existing physical camera/tracking/clean-Mac and hosted-release qualification gaps remain in the preserved prior context. Protect rig configurations and retain rollback artifacts.

## Test status

This revision: documentation consistency, dependency/link and diff checks only. No implementation tests, build, app/server launch, capture, account access or broadcasting run. Past package/synthetic receipts do not qualify streaming or the physical rig.

## Next step

Resolve/refresh #63, then S01/S02 qualify actual capture/runtime; S03–S05 prove architecture, MP4 and timing before dependent media implementation. S16 credential storage can proceed separately. Compact before starting implementation; execute one issue at a time and record separate synthetic, physical, hosted and installed acceptance.
