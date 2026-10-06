# S21 — expose Electron-only session status and actions

## Goal

Provide validated local adapters without creating a new CLI authentication system.

## Plan and scope

[Revised program streaming core](https://github.com/ajhochy/fps-camcontrol/blob/integration/combine-open-prs/docs/ai/plans/2026-10-06-program-streaming-core.md); PR #60. Milestone: Streaming M5 — Operator workflow.
This issue delivers one step; it does not authorize the entire streaming project.

## Dependencies

S09, S12, S14, S15, S20

## Likely files

- `src/ui/ (broadcast/YouTube adapters)`
- `src/ui/statusServer.ts`
- `src/app/state.ts`

## Acceptance criteria

- [ ] Authenticated Electron-local callers can read sanitized signal/session/output/YouTube state and invoke validated config/start/stop/recovery/connect/event actions.
- [ ] CLI/LAN/iPad callers cannot use new privileged routes or audio transport; existing iPad preview/camera routes retain compatibility.
- [ ] Adapter errors distinguish invalid config, conflict, missing source, storage failure and unavailable API; duplicate actions use service idempotency. All existing write paths respect active-session locks.

## Required tests / evaluation

Route contract tests for normal, unauthorized, duplicate/concurrent and conflict requests; secret-sentinel scans of responses/logs.

Add focused contract checks before implementation; apply the repository gates appropriate to changed code. Record commands, source SHA and observed outcomes. Separate synthetic, physical, hosted and installed evidence; missing required evidence leaves the issue open.

## Out of scope / data safety

No new CLI session/cookie system or independent adapter-owned capture process.

Preserve unrelated work and operator configs. Use isolated fixtures and disposable credentials; never commit tokens, stream keys, recordings or rig identifiers. Hardware/account use needs operator authorization at execution time. No production install, driver change, merge, release or public broadcast is authorized by issue creation.
