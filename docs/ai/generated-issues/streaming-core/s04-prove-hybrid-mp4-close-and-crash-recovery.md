# S04 — prove hybrid MP4 close and crash recovery

**GitHub:** [#67](https://github.com/ajhochy/fps-camcontrol/issues/67)

## Goal

Establish an MP4 writer/recovery recipe and measured shutdown budget.

## Plan and scope

[Revised program streaming core](https://github.com/ajhochy/fps-camcontrol/blob/integration/combine-open-prs/docs/ai/plans/2026-10-06-program-streaming-core.md); PR #60. Milestone: Streaming M1 — Rig and media proof.
This issue delivers one step; it does not authorize the entire streaming project.

## Dependencies

[S03 / #66](https://github.com/ajhochy/fps-camcontrol/issues/66)

## Likely files

- `scripts/ (MP4 fault proof)`
- `docs/ai/decisions/ (finalization policy)`
- `docs/ai/runs/ (MP4 evidence)`

## Acceptance criteria

- [ ] Normal stop of the pinned hybrid-fragmented writer produces regular H.264/AAC MP4 that seeks and plays in QuickTime and the intended editor; do not combine faststart.
- [ ] Kill during writing and finalization; recover all completed fragments to a separate file while retaining the original bytes. Incomplete trailing fragments are reported, not counted as recovered.
- [ ] Measure finalization on two-hour-equivalent recordings and slow temporary storage; document a bounded graceful-drain/forced-termination policy based on measurements, including recovery behavior. Do not reinstate an unmeasured five-second limit.

## Required tests / evaluation

Automated writer kill/remux cases plus ffprobe/decoded-content comparison; manual QuickTime/editor check with durations and hashes in receipt.

Add focused contract checks before implementation; apply the repository gates appropriate to changed code. Record commands, source SHA and observed outcomes. Separate synthetic, physical, hosted and installed evidence; missing required evidence leaves the issue open.

## Out of scope / data safety

No production disk filling, overwrites or application lifecycle implementation.

Preserve unrelated work and operator configs. Use isolated fixtures and disposable credentials; never commit tokens, stream keys, recordings or rig identifiers. Hardware/account use needs operator authorization at execution time. No production install, driver change, merge, release or public broadcast is authorized by issue creation.
