# S12 — integrate safe media shutdown with Electron supervision

**GitHub:** [#75](https://github.com/ajhochy/fps-camcontrol/issues/75)

## Goal

Ensure camera motion stops promptly and media children terminate with the measured file-close policy.

## Plan and scope

[Revised program streaming core](https://github.com/ajhochy/fps-camcontrol/blob/integration/combine-open-prs/docs/ai/plans/2026-10-06-program-streaming-core.md); PR #60. Milestone: Streaming M2 — Session and recording engine.
This issue delivers one step; it does not authorize the entire streaming project.

## Dependencies

[S11 / #74](https://github.com/ajhochy/fps-camcontrol/issues/74)

## Likely files

- `src/embed.ts`
- `src/index.ts`
- `electron/main.cjs`
- `src/program/ (session teardown)`

## Acceptance criteria

- [ ] Quit/sleep first stop motion, then stop outputs and drain/finalize within the [S04 / #67](https://github.com/ajhochy/fps-camcontrol/issues/67) measured policy; the Electron outer deadline allows that policy.
- [ ] Backend/parent death and forced termination leave no owned capture/encoder/writer/publisher children; incomplete files are retained for [S09 / #72](https://github.com/ajhochy/fps-camcontrol/issues/72) recovery.
- [ ] Cold startup/wake never restores recording or streaming intent; partial teardown and repeated Stop cannot hang the app or replay commands.

## Required tests / evaluation

Owned-process exit/kill/sleep simulations, recording validation/recovery and camera stop-order assertions; physical sleep behavior remains an installed gate.

Add focused contract checks before implementation; apply the repository gates appropriate to changed code. Record commands, source SHA and observed outcomes. Separate synthetic, physical, hosted and installed evidence; missing required evidence leaves the issue open.

## Out of scope / data safety

Reuse the existing guardian/process ledger; do not create a second generic supervision framework.

Preserve unrelated work and operator configs. Use isolated fixtures and disposable credentials; never commit tokens, stream keys, recordings or rig identifiers. Hardware/account use needs operator authorization at execution time. No production install, driver change, merge, release or public broadcast is authorized by issue creation.
