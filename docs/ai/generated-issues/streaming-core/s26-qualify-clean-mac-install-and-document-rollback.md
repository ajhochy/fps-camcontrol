# S26 — qualify clean-Mac install and document rollback

**GitHub:** [#89](https://github.com/ajhochy/fps-camcontrol/issues/89)

## Goal

Validate both app variants and operator recovery outside the development environment.

## Plan and scope

[Revised program streaming core](https://github.com/ajhochy/fps-camcontrol/blob/integration/combine-open-prs/docs/ai/plans/2026-10-06-program-streaming-core.md); PR #60. Milestone: Streaming M6 — Packaging and qualification.
This issue delivers one step; it does not authorize the entire streaming project.

## Dependencies

[S23 / #86](https://github.com/ajhochy/fps-camcontrol/issues/86), [S24 / #87](https://github.com/ajhochy/fps-camcontrol/issues/87)

## Likely files

- `docs/electron.md`
- `docs/program-feed.md`
- `docs/ai/runs/ (clean-Mac receipt)`

## Acceptance criteria

- [ ] On a clean supported Mac without Homebrew, each signed variant starts with declared prerequisites, prompts for required permissions and can run the qualified capture/record/monitor workflow.
- [ ] OS output changes, sleep/wake, quit and crash behave as documented: no orphan processes or automatic live restart, and interrupted originals can be recovered.
- [ ] Publish exact installed artifact/source/runtime receipts and a concise setup/calibration/restore guide; preserve previous app/Wirecast and rig configuration until [S25 / #88](https://github.com/ajhochy/fps-camcontrol/issues/88) and this gate pass.

## Required tests / evaluation

Actual clean-Mac/TCC/installed checks for both variants; explicit unavailable prerequisites fail rather than count as a developer-host pass.

Add focused contract checks before implementation; apply the repository gates appropriate to changed code. Record commands, source SHA and observed outcomes. Separate synthetic, physical, hosted and installed evidence; missing required evidence leaves the issue open.

## Out of scope / data safety

No deployment or release approval implied. Existing clean-machine issue #51 remains a related foundation task, not evidence of new streaming qualification.

Preserve unrelated work and operator configs. Use isolated fixtures and disposable credentials; never commit tokens, stream keys, recordings or rig identifiers. Hardware/account use needs operator authorization at execution time. No production install, driver change, merge, release or public broadcast is authorized by issue creation.
