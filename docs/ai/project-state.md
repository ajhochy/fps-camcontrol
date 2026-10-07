---
type: project
---

# Project State — fps-camcontrol

## Current focus

2026-10-07: streaming code is preserved in draft [PR #90](https://github.com/ajhochy/fps-camcontrol/pull/90), branch `feat/streaming-s1-media-proof`. Bounded WIP publication verification passed; **full S1 is NOT READY**. Recorded developer 20-case matrix, 44 decoded comparisons and 60-minute soak passed; broad checks failed/hung. Actual publisher reconnect, channel-1 content, network/internal queues, architecture reconciliation and independent full S1 qualification remain pending. `--recovery-contract` requires unpublished local synthetic fixtures; it is not fresh-checkout self-contained. See [current handoff](runs/2026-10-07-streaming-s1.md), [checkpoint results](runs/2026-10-07-streaming-checkpoint-results.json) and [publication contract](contracts/streaming-wip-publication.json). Physical Blackmagic installation/tests remain AJ's separate handoff.

Canonical product streaming remains planned, not integrated. The user accepted both plan reviews: real capture proof first, conditional media architecture, coupled sessions, MP4 default, Electron-only new streaming, OS audio routing, explicit queue-age/signal/clock behavior. See [plan](plans/2026-10-06-program-streaming-core.md) and [26-step backlog](generated-issues/streaming-core/README.md). Oct7 manager-authorized independent-remux/Node-relay exception is limited to S1; canonical architecture reconciliation remains unresolved, not AJ-specific architecture approval.

## Active branch / PR

Open integration PR #60 (`integration/combine-open-prs`), verified planning base `dd224d0`; PR #62 is merged. This revision changes docs and GitHub planning metadata only. The primary checkout's unrelated changes are preserved. Historical integration/release/tracking receipts and previous snapshot are retained in [pre-revision context](runs/2026-10-06-pre-streaming-revision-context.md); those are historical evidence, not new qualification.

## In progress

Six streaming milestones (#11–#16) with 26 atomic new issues (#64–#89); existing #63 is assigned to the first milestone and owns the DeckLink SDK/driver prerequisite. New output sessions use Record only or Stream + record, with shared start/stop; arbitrary output attachment and a Node TS relay are deferred. Existing CLI/iPad camera/preview operation remains; new broadcast administration is Electron-local.

## Risks / known issues

- Existing iPad remote is CLI-only; Electron is authenticated loopback-only. This scope preserves that boundary, not simultaneous iPad access to Electron. If needed for rollout, address separately without competing capture owners.

- #63 reports SDK 16 versus Desktop Video 14.2 incompatibility and preview-only FFmpeg; refresh versions before work. No driver change is authorized. Actual program format/audio and streaming-capable runtime remain unqualified.
- Static tee/fifo must prove failure isolation and one-second application media-age bounds before selection; failed evidence requires a recorded architecture revision, not silent custom relay work.
- MP4 recovery, shutdown budget, content sync and monitoring clocks require measured evidence. Google setup/consent and operator-authorized rig/account access are external gates.
- Existing physical camera/tracking/clean-Mac and hosted-release qualification gaps remain in the preserved prior context. Protect rig configurations and retain rollback artifacts.

## Test status

This revision: documentation consistency, dependency/link and diff checks only. No implementation tests, build, app/server launch, capture, account access or broadcasting run. Past package/synthetic receipts do not qualify streaming or the physical rig.

## Next step

Resolve/refresh #63, then S01/S02 qualify actual capture/runtime; S03–S05 prove architecture, MP4 and timing before dependent media implementation. S16 credential storage can proceed separately. Compact before starting implementation; execute one issue at a time and record separate synthetic, physical, hosted and installed acceptance.
