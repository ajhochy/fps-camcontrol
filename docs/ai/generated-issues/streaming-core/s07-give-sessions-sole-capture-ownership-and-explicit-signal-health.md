# S07 — give sessions sole capture ownership and explicit signal health

**GitHub:** [#70](https://github.com/ajhochy/fps-camcontrol/issues/70)

## Goal

Replace preview-owned capture with one app-owned source and a compatible preview adapter.

## Plan and scope

[Revised program streaming core](https://github.com/ajhochy/fps-camcontrol/blob/integration/combine-open-prs/docs/ai/plans/2026-10-06-program-streaming-core.md); PR #60. Milestone: Streaming M2 — Session and recording engine.
This issue delivers one step; it does not authorize the entire streaming project.

## Dependencies

[S06 / #69](https://github.com/ajhochy/fps-camcontrol/issues/69)

## Likely files

- `src/program/programFeed.ts`
- `src/program/ (session capture owner)`
- `src/index.ts`
- `src/ui/statusServer.ts`

## Acceptance criteria

- [ ] Idle preview/Listen and active outputs never open the same device twice; preview inactivity or closing the iPad page cannot stop active recording/publishing.
- [ ] Report valid signal, absent signal, disconnected device and failed process separately. Bars/repeated frames do not clear absent-signal status; supported warning/device telemetry remains observable.
- [ ] Healthy-process signal absence preserves the session with documented filler and a visible warning. Device/process loss ends the session safely and requires explicit restart; returning hardware never auto-starts sending.

## Required tests / evaluation

Fake device telemetry/process cases and existing program-route compatibility; authorized cable/signal-loss check on the rig. Record transition behavior and no duplicate owners.

Add focused contract checks before implementation; apply the repository gates appropriate to changed code. Record commands, source SHA and observed outcomes. Separate synthetic, physical, hosted and installed evidence; missing required evidence leaves the issue open.

## Out of scope / data safety

No generic source plugin framework, automatic capture retry or multipart recording. Session transitions consume this owner in [S11 / #74](https://github.com/ajhochy/fps-camcontrol/issues/74).

Preserve unrelated work and operator configs. Use isolated fixtures and disposable credentials; never commit tokens, stream keys, recordings or rig identifiers. Hardware/account use needs operator authorization at execution time. No production install, driver change, merge, release or public broadcast is authorized by issue creation.
