# S17 — connect YouTube using desktop OAuth and refresh tokens

**GitHub:** [#80](https://github.com/ajhochy/fps-camcontrol/issues/80)

## Goal

Implement one-account system-browser OAuth for scheduled-event access.

## Plan and scope

[Revised program streaming core](https://github.com/ajhochy/fps-camcontrol/blob/integration/combine-open-prs/docs/ai/plans/2026-10-06-program-streaming-core.md); PR #60. Milestone: Streaming M4 — Scheduled YouTube events.
This issue delivers one step; it does not authorize the entire streaming project.

## Dependencies

[S16 / #79](https://github.com/ajhochy/fps-camcontrol/issues/79)

## Likely files

- `src/youtube/ (OAuth service)`
- `electron/ (browser/loopback authorization)`
- `docs/ (Google setup)`

## Acceptance criteria

- [ ] Connect uses registered Desktop client, PKCE, a one-use state and temporary loopback callback; successful auth shows channel/account identity and stores only through [S16 / #79](https://github.com/ajhochy/fps-camcontrol/issues/79).
- [ ] Reject wrong/replayed state, canceled/expired auth and invalid callback; close the temporary listener on every exit path.
- [ ] Refresh works without interactive login; revoked access shows reconnect needed. Document client configuration and applicable public consent-verification gate without shipping assumed renderer secrets.

## Required tests / evaluation

Mocked OAuth success/error/refresh/revoke cases and one operator-authorized real login/cleanup; use youtube.force-ssl scope.

Add focused contract checks before implementation; apply the repository gates appropriate to changed code. Record commands, source SHA and observed outcomes. Separate synthetic, physical, hosted and installed evidence; missing required evidence leaves the issue open.

## Out of scope / data safety

No media upload, event creation, manual stream-key UI or public rollout before applicable verification.

Preserve unrelated work and operator configs. Use isolated fixtures and disposable credentials; never commit tokens, stream keys, recordings or rig identifiers. Hardware/account use needs operator authorization at execution time. No production install, driver change, merge, release or public broadcast is authorized by issue creation.
