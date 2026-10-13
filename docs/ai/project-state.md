---
type: project
---

# Project State — fps-camcontrol

## Current focus

Original product checks used `1e7e1ad`; another owner subsequently rewrote PR #91 to `ce2a951` and merged PR #60 to main `ce98b2d`. This manager performed neither action and moved its handoff to separate branch `docs/camcontrol-preservation-handoff`, based on `ce2a951`, instead of overwriting the active feature branch. Draft [PR #90](https://github.com/ajhochy/fps-camcontrol/pull/90) keeps streaming S1 separate. See [development handoff](../camcontrol-development-handoff.md) and [dated inventory](runs/2026-10-13-preservation-inventory.md).

## Active branch / PR

PR #91 targets `main`; the docs handoff targets its feature branch. PR #90 targets integration at `1c94e68`; its original merge-base is `aea1f13`. Integration is now in main through externally merged #60. DeckLink preservation uses `preserve/decklink-sdk16-checkpoint`, based on `3f719b0`, targeting integration. Publication receipts provide final documentation/fixture SHAs. No manager merge, rebase, force-push, deployment or cleanup.

## In progress

Preserved 53 DeckLink stash files plus two tiny referenced synthetic fixtures; separate draft publication, not compatibility remediation. Current delivery includes desktop/iPad Hold this framing, not phone Hold or automatic zoom. PR #90 full S1 remains NOT READY. Independent DeckLink static preservation review passed; execution remains blocked by documented script/SDK risks.

## Risks / known issues

- Physical framing, direction/gain, override/dead-man/e-stop soaks, Safari, HID/TCC, Sony/ATEM, captured driver/format/audio, and clean-Mac packaged acceptance are unverified and require later operator-approved manual qualification.
- SDK 16 versus historical Desktop Video 14.2 remains blocked under #63; preview-only FFmpeg is not streaming-capable. Target device OS/driver/runtime were not queried.
- Never use operator config/secrets for tests. `CAMCONTROL_NO_CONTROLLER=1` disables real HID only; it does not isolate startup networking/config access. No live rig smoke or deployment is authorized.
- Initial worktree review found two clean registered worktrees and no local unpushed commits, but no global writer-quiescence guarantee; manager must recheck immediately before any commit.

## Test status

Fresh independent checks: both TypeScript builds pass; primary page parsing passes; bounded framing/controller/security checks 32/32 pass; pure broadcast arguments/relay 3/3 pass. Contracts: 22/23 pass, issue-23-c4 fails. Manager suite fails on missing `config.speeds['rig-one']` and times out at 180 seconds; isolated c1 fails exit 1. Full PR whitespace check fails on inherited Sony patch files. Full sandbox/packaged/model/hardware gates are not passed. See [exact commands and limits](runs/2026-10-13-safe-verification.md).

Fresh rewritten-head re-gate at `ce2a951`: build/page-JS and 32/32 focused tests pass, no source drift. Broader failures remain earlier-head unresolved evidence, not a claim of current full-suite acceptance. Streaming 3/3 and build use unchanged product head `f708df3`; restored fixture bytes are not fresh media/recovery proof.

## Next step

Continue on the appropriate published draft, repair/classify disclosed fixture/configuration test blockers, and qualify runtimes before later operator-approved physical tests. Keep candidates separate. No merge or deployment.
