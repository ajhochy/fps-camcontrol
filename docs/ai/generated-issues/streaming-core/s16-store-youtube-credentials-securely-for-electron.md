# S16 — store YouTube credentials securely for Electron

## Goal

Provide the smallest Electron-owned macOS credential boundary for OAuth tokens.

## Plan and scope

[Revised program streaming core](https://github.com/ajhochy/fps-camcontrol/blob/integration/combine-open-prs/docs/ai/plans/2026-10-06-program-streaming-core.md); PR #60. Milestone: Streaming M4 — Scheduled YouTube events.
This issue delivers one step; it does not authorize the entire streaming project.

## Dependencies

None; may proceed independently.

## Likely files

- `electron/ (credential integration)`
- `src/youtube/ (narrow secret-store boundary)`
- `src/testing/ (redaction checks)`

## Acceptance criteria

- [ ] Refresh tokens persist securely for the app and can be deleted; the chosen macOS mechanism and access behavior are documented. Introduce a narrow native helper only if necessary.
- [ ] Credentials never enter renderer responses, exported config, URLs in UI, logs or error diagnostics; transient ingest destinations are redacted too.
- [ ] Missing/denied/unavailable storage fails connect clearly without plaintext fallback. Disconnect removes stored OAuth material without accidentally killing healthy media.

## Required tests / evaluation

Disposable credential-store entries, denied/unavailable storage, exact cleanup and secret-sentinel redaction tests.

Add focused contract checks before implementation; apply the repository gates appropriate to changed code. Record commands, source SHA and observed outcomes. Separate synthetic, physical, hosted and installed evidence; missing required evidence leaves the issue open.

## Out of scope / data safety

No CLI support, generic cross-platform vault or migration of unrelated credentials.

Preserve unrelated work and operator configs. Use isolated fixtures and disposable credentials; never commit tokens, stream keys, recordings or rig identifiers. Hardware/account use needs operator authorization at execution time. No production install, driver change, merge, release or public broadcast is authorized by issue creation.
