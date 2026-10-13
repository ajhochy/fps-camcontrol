---
date: 2026-10-06
repo: fps-camcontrol
branch: integration/combine-open-prs
pr: 60 (documentation only)
issues: []
status: planned-not-implemented
tags: [run, fps-camcontrol]
index: "[[fps-camcontrol]]"
---

# Program streaming core — planning checkpoint

## Files changed

- Detailed implementation plan: `docs/ai/plans/2026-10-06-program-streaming-core.md`.
- `docs/ai/current-plan.md`: new active plan/ordered issue summary.
- Prior plan preserved verbatim in `docs/ai/plans/2026-10-01-electron-release-and-packaging.md`.
- `docs/ai/project-state.md`: planned core scope, inspected checkout and next step; historical implementation evidence retained.

## Checks run

- Static inspection: existing FFmpeg capture, program HTTP adapter, backend lifecycle, Electron protection and package allowlists.
- Primary-source research: FFmpeg formats/timestamps/license/build configuration; YouTube scheduled-event/OAuth/lifecycle APIs; Web Audio monitoring.
- Documentation check: required plan sections/archive presence, local Markdown links and `git diff --check`.
- NOT RUN: source builds/tests, any synthetic or hardware media pipeline, local monitoring, YouTube OAuth/streaming, packaged runtimes or target-machine qualification.

## Notes

The operator uses Wirecast only to stream/record the finished program feed. Required additions are audio
monitoring, small video sync delay and connection to existing scheduled YouTube events. The user selected
core first after the question card did not display and the question was repeated in chat.
Follow-up: the user requested default MP4 recordings. The plan now uses FFmpeg hybrid fragmented MP4
while writing, a regular MP4 on normal close, and a source-preserving recovery remux after interruption.

The planning checkpoint chooses one capture/encode with independent remux outputs, Mac-local audio
monitoring, pre-output frame delay and protected YouTube integration. These are proposals to be proved,
not completed features. Full pipeline feasibility is the first implementation acceptance gate.

External release prerequisites: Google OAuth client/consent setup and exact FFmpeg/DeckLink runtime
distribution qualification. The plan defines a separately supplied DeckLink binary path if bundling has
not qualified. Never change production drivers or overwrite rig configurations during research.

The user authorized committing and pushing this plan to the existing open PR. GitHub inspection found
PR #62 merged and PR #60 open; the documentation push targets PR #60 from base head `72a67c7`.
No application implementation, deployments, signing, notifications or dashboard manual publishing were performed.
Existing unrelated untracked files were preserved. No personal Codex memory files were updated.
