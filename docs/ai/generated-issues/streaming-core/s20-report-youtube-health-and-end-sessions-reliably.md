# S20 — report YouTube health and end sessions reliably

## Goal

Handle status uncertainty and terminal session actions without false Live/Complete claims.

## Plan and scope

[Revised program streaming core](https://github.com/ajhochy/fps-camcontrol/blob/integration/combine-open-prs/docs/ai/plans/2026-10-06-program-streaming-core.md); PR #60. Milestone: Streaming M4 — Scheduled YouTube events.
This issue delivers one step; it does not authorize the entire streaming project.

## Dependencies

S19

## Likely files

- `src/youtube/ (health and completion)`
- `src/program/ (session stop intent)`
- `src/testing/ (status/stop cases)`

## Acceptance criteria

- [ ] Poll selected health at 15 seconds with bounded faster transition polling; OAuth/API failure after start labels status unavailable while healthy media continues.
- [ ] Confirmed End session requests complete then stops local sending and finalizes recording. API timeout/failure still stops local outputs and labels YouTube completion unconfirmed.
- [ ] Confirmed external completion cancels retry and gracefully ends the session; auto-stop consequences are shown. Record-only Stop makes no YouTube call, and stale status cannot redirect or restart publishing.

## Required tests / evaluation

API outage/revoke/rate-limit fixtures, external completion, retry cancellation and complete timeout cases; preserve file evidence for each stop path.

Add focused contract checks before implementation; apply the repository gates appropriate to changed code. Record commands, source SHA and observed outcomes. Separate synthetic, physical, hosted and installed evidence; missing required evidence leaves the issue open.

## Out of scope / data safety

No independent Stop Sending button or automatic event replacement.

Preserve unrelated work and operator configs. Use isolated fixtures and disposable credentials; never commit tokens, stream keys, recordings or rig identifiers. Hardware/account use needs operator authorization at execution time. No production install, driver change, merge, release or public broadcast is authorized by issue creation.
