# S03 — prove static FFmpeg outputs and choose the minimal session architecture

## Goal

Decide whether tee/fifo can meet one-session stream-plus-record behavior without a custom media router.

## Plan and scope

[Revised program streaming core](https://github.com/ajhochy/fps-camcontrol/blob/integration/combine-open-prs/docs/ai/plans/2026-10-06-program-streaming-core.md); PR #60. Milestone: Streaming M1 — Rig and media proof.
This issue delivers one step; it does not authorize the entire streaming project.

## Dependencies

S01, S02

## Likely files

- `scripts/ (isolated media proof)`
- `docs/ai/decisions/ (session architecture)`
- `docs/ai/runs/ (proof receipt)`

## Acceptance criteria

- [ ] One source/encoder produces decodable MP4 and a local RTMP receiver stream concurrently using tee/fifo first; retain a reproducible command/harness with no real ingest secrets.
- [ ] Stall/drop the local publisher and fail the recording writer separately: healthy output continues, memory is bounded, and reconnect starts at a decodable boundary without replaying stale content. Prove at most one second of application-queued publisher media age with a byte bound; downstream network latency is measured separately.
- [ ] Record actual retry behavior, buffer settings and limitations in an ADR. If any invariant fails, update the plan with the smallest justified alternative before dependent implementation; do not silently introduce a Node TS parser/router.

## Required tests / evaluation

Use clocked synthetic media, a controllable local receiver, queue/age instrumentation and fault injection; repeat the selected command on the qualified rig when authorized.

Add focused contract checks before implementation; apply the repository gates appropriate to changed code. Record commands, source SHA and observed outcomes. Separate synthetic, physical, hosted and installed evidence; missing required evidence leaves the issue open.

## Out of scope / data safety

No operator UI, OAuth, independent output attachment or production broadcast. A failed experiment is useful evidence but does not close the architecture gate.

Preserve unrelated work and operator configs. Use isolated fixtures and disposable credentials; never commit tokens, stream keys, recordings or rig identifiers. Hardware/account use needs operator authorization at execution time. No production install, driver change, merge, release or public broadcast is authorized by issue creation.
