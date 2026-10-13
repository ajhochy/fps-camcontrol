# S18 — list scheduled events and resolve their bound ingest stream

**GitHub:** [#81](https://github.com/ajhochy/fps-camcontrol/issues/81)

## Goal

Select an existing event and resolve its current destination without modifying it.

## Plan and scope

[Revised program streaming core](https://github.com/ajhochy/fps-camcontrol/blob/integration/combine-open-prs/docs/ai/plans/2026-10-06-program-streaming-core.md); PR #60. Milestone: Streaming M4 — Scheduled YouTube events.
This issue delivers one step; it does not authorize the entire streaming project.

## Dependencies

[S17 / #80](https://github.com/ajhochy/fps-camcontrol/issues/80)

## Likely files

- `src/youtube/ (events and stream resolver)`
- `src/testing/ (YouTube fixtures)`

## Acceptance criteria

- [ ] Paginate mine=true event listings, locally filter upcoming/active and sort by schedule; show channel, title, time, privacy, watch link and auto-start/auto-stop settings.
- [ ] Resolve current boundStreamId by ID including non-reusable streams; return a server-only RTMPS address/key. Resolve again immediately before sending.
- [ ] Unbound/deleted/inaccessible events get actionable Studio setup errors; no create/rebind or silent selection fallback. Active session account/event selection is locked.

## Required tests / evaluation

Multi-page, empty, non-reusable, missing-bound-stream, permission and event-change fixtures; check mine is not combined with broadcastStatus.

Add focused contract checks before implementation; apply the repository gates appropriate to changed code. Record commands, source SHA and observed outcomes. Separate synthetic, physical, hosted and installed evidence; missing required evidence leaves the issue open.

## Out of scope / data safety

No playlist management, event scheduling or metadata editing.

Preserve unrelated work and operator configs. Use isolated fixtures and disposable credentials; never commit tokens, stream keys, recordings or rig identifiers. Hardware/account use needs operator authorization at execution time. No production install, driver change, merge, release or public broadcast is authorized by issue creation.
