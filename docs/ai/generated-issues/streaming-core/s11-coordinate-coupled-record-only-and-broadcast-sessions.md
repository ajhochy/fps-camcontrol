# S11 — coordinate coupled record-only and broadcast sessions

**GitHub:** [#74](https://github.com/ajhochy/fps-camcontrol/issues/74)

## Goal

Implement one serialized output-session state machine with the accepted failure policy.

## Plan and scope

[Revised program streaming core](https://github.com/ajhochy/fps-camcontrol/blob/integration/combine-open-prs/docs/ai/plans/2026-10-06-program-streaming-core.md); PR #60. Milestone: Streaming M2 — Session and recording engine.
This issue delivers one step; it does not authorize the entire streaming project.

## Dependencies

[S08 / #71](https://github.com/ajhochy/fps-camcontrol/issues/71), [S10 / #73](https://github.com/ajhochy/fps-camcontrol/issues/73)

## Likely files

- `src/program/ (session service)`
- `src/app/state.ts`
- `src/testing/ (session transitions)`

## Acceptance criteria

- [ ] Record-only Start starts a recorder; broadcast Start confirms recorder readiness before sending. Initial recording failure sends no media.
- [ ] Duplicate/concurrent Start/Stop is idempotent; mode is fixed until Stop. Normal Stop ends all session outputs together; per-output attachment is unavailable.
- [ ] Publisher outage leaves recording active; recording failure leaves an existing publisher active and visibly degraded; capture/device failure ends both. State distinguishes starting, active, reconnecting, stopping and failure without hiding per-output conditions.

## Required tests / evaluation

Table-driven state and concurrent-action cases using fake children plus the proven local dual-output harness.

Add focused contract checks before implementation; apply the repository gates appropriate to changed code. Record commands, source SHA and observed outcomes. Separate synthetic, physical, hosted and installed evidence; missing required evidence leaves the issue open.

## Out of scope / data safety

No YouTube API, independent output controls, automatic restart after app launch or event switching.

Preserve unrelated work and operator configs. Use isolated fixtures and disposable credentials; never commit tokens, stream keys, recordings or rig identifiers. Hardware/account use needs operator authorization at execution time. No production install, driver change, merge, release or public broadcast is authorized by issue creation.
