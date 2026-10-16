---
date: 2026-10-13
repo: fps-camcontrol
branch: docs/camcontrol-preservation-handoff
issues: []
status: qualified-draft-preservation
tags: [run, fps-camcontrol]
index: "[[fps-camcontrol]]"
---

# Preservation inventory and handoff — 2026-10-13

## Scope and current published state

Documentation-only inventory in the primary checkout, branch `feat/combined-studio-framing`, based on HEAD `1e7e1ad`. Manager retains commit/push/PR ownership. No source, test, product configuration, Git history, branch or remote ref is changed by this task. Initial inventory: two registered clean worktrees, no staged/unstaged/nonignored-untracked changes and no local-branch commits missing from their remote. `origin` is `github.com/ajhochy/fps-camcontrol`; `origin/main` is `c9098d8`. No global quiescence claim: process inspection found no observed FPS writer, but the manager must recheck immediately before any commit.

## Candidate work and disposition

| Candidate | Exact known provenance | Disposition |
|---|---|---|
| Combined Studio/framing | PR #91, `feat/combined-studio-framing` @ `1e7e1ad`; includes baseline `aea1f13` | Published current work; preserve. Exact deployed iPhone assets and desktop/iPad Hold this framing; no phone Hold/automatic zoom. |
| Streaming S1 media proof | PR #90, `feat/streaming-s1-media-proof` @ `f708df3`, based on `aea1f13`; 15 unique source/test/docs paths | Separate published draft; preserve separately. Two synthetic MP4 recovery fixtures (13,888 + 88 = 13,976 bytes) are being restored by its coding agent. Do not edit that worktree or merge the candidate here. |
| New integration candidate | PR #60 advanced from `3f719b0` to `1c94e68` during this run; since `aea1f13`, 23 paths and five commits (three production, two merges) | Concurrent remote author/agent work already published; untouched locally. Four phone files match PR #91. Keep distinct; do not copy/merge into PR #91. |
| Published historical sources | `feat/ipad-remote-touch-redesign` @ `fa389cb` (docs-only, merged #62); `codex/electron-tracking` @ `237c54d` (evidence-only, open #58) | Retain remote provenance; do not restore their stale documentation over current state. |
| Other original feature remotes | All checked as ancestors of integration, except documented metadata-only exceptions | Already represented by integration history or metadata; do not replay commits. |
| Reflog-only commits | 56 historical commits remain visible via reflog but not refs; count is unchanged by this inventory branch | Historical snapshots, not new delivery. Oct 3 remote-agent code `af5ffdb` matches `bf3921a` except `project-state.md`; earlier snapshots/consolidation squash are preserved in `main` `3663090` and later implementation. No historical code replay. |
| Stash | `addc6d762547344c009bb425c132c7a57b3b19ac`; 53 files, selected paths identical to abandoned `50ffc5f` | Retained unchanged; restored to `preserve/decklink-sdk16-checkpoint`, based on `3f719b0`, in `/Users/ajhochhalter/Documents/fps-camcontrol-decklink-preservation`. Separate draft publication; no SDK/script fixes or stale baseline overwrite. |
| Private recovery archive | Dated private backup contains six historical archived worktrees and a bundle | Retained; not an active checkout. Historical cleanup was authorized 2026-10-07. Incomplete controller experiments are not delivered work. No archive deletion here. |

The coding agent for the DeckLink checkpoint owns the detailed 53-per-file inventory receipt. The two MP4 fixtures are recovery assets only; no generated matrix or hour-long media is included. Do not infer source ownership from untracked or ignored files.

## Ignored and generated data excluded

Primary checkout has nine ignored root groups: `.DS_Store`, `.claire/`, `.claude/`, `.env`, `.gitnexus/`, `dist/`, `logs/`, `node_modules/`, `sandbox/.run/`. The streaming worktree has three groups: `dist/`, `logs/`, `node_modules/`.

- Investigated `.claire/.../src/visca/ptzActions.ts` is blob `3b0652f`, identical to historical source `a721d71`; its tilt speed is stale/unsafe (24) and direction is reversed relative to corrected current source. Excluded; retained on disk, not copied.
- `.claude/launch.json` is local editor data; its health log is sandbox evidence, not implementation. `.gitnexus/run.cjs` and its index are generated external-tool runner data, not app code.
- `dist/` contains generated JS/source-map counterparts. The streaming `dist/broadcast-evidence` is historical generated TypeScript/media evidence, not maintained TS source. `sandbox/.run/` contains seven runtime configs/log artifacts; none imports operator credentials. Ignored files were not added to the handoff.

## Target/prerequisite and safety notes

Target is Apple-Silicon macOS 14+ for tracking; manual-only install supports macOS 13+. Actual target OS/driver/runtime were not queried (no SSH). Host development baseline observed: Node 22.23.0, pnpm 11.1.2; project pins pnpm 11.1.2 but declares no Node engine minimum. Pi BLE runtime requires Python >=3.10. Sony SDK/CameraWebApp is user-supplied. Historical Desktop Video 14.2 vs SDK 16 is blocked by #63; preview-only FFmpeg is not streaming-capable. No installation, driver, camera, motion, recording or deployment command is part of this documentation handoff.

Use a separate dev checkout of PR #91, verify the branch and `1e7e1ad` ancestry, then `pnpm install --frozen-lockfile`, `pnpm build`, and `node scripts/check-page-js.cjs`. Tests require disposable config/user-data and free documented ports. `CAMCONTROL_NO_CONTROLLER=1` disables HID only; normal app startup may still read config and contact devices. Never run `pnpm start`, `pnpm dev`, or unisolated smoke on a configured rig. Never copy `.env`, PINs, operator config or signing/API credentials. Sony approval lives in local `config/sony-cameras.json`; remote PIN is local config; Electron user data is separate; signing/API credentials stay in local OS stores.

## Concurrent activity and checks

Process/descriptor inspection showed other Claude/Codex processes under Documents/Rhythm/Encompass, not an observed local FPS writer; opencode status returned `{}` before specialists. Remote PR #60 nevertheless advanced concurrently to `1c94e68` (Claude-coauthored), proving local process checks do not establish global quiescence. Its line is left untouched. Specialist writers finished before manager staging. Fresh checks and real failures are recorded in [verification receipt](2026-10-13-safe-verification.md). No hardware, live service, deployment, destructive cleanup or merge occurred.

## Files changed / next action

- Added `docs/camcontrol-development-handoff.md` and this preservation inventory.
- Updated `docs/ai/project-state.md` as a current snapshot; prior historical evidence remains in dated receipts.
- Manager rechecks worktrees/status and candidate hashes before commit and remote heads after push. Maintain separate candidate branches/drafts; no merge or deployment is authorized.

## Exact published candidate path inventory

These lists count paths per line, not distinct paths across branches. All listed existing work is included by its existing published branch; none is re-added to another line. New preservation changes: 53 original DeckLink paths plus one receipt; two fixture files plus two docs on PR #90; four documentation paths on PR #91 = **62 changed paths in three worktrees, including 55 recovered existing assets**. The detailed DeckLink 53-path inclusion reasons live in its own receipt. Initial local branch unpushed commits: zero; stash one; relevant abandoned commit `50ffc5f` represented by the stash, not replayed wholesale.

PR #91 at original tested head `1e7e1ad`: **35 paths since `aea1f13`**. Include source/UI/test/docs as current framing/phone work and retain already-published synthetic evidence as provenance:

```text
docs/ai/contracts/combined-studio-framing.json
docs/ai/contracts/keep-this-framing.json
docs/ai/project-state.md
docs/ai/runs/2026-10-07-combined-studio-framing.md
docs/tracking.md
src/tracking/trackingController.ts
src/tracking/trackingManager.ts
src/tracking/types.ts
src/ui/trackingRoutes.ts
tests/tracking/combined-studio-framing.test.cjs
tests/tracking/keep-this-framing.test.cjs
ui/remote/index.html
ui/remote/iphone/index.html
ui/remote/iphone/remote.css
ui/remote/iphone/remote.js
ui/remote/iphone/remoteModel.js
ui/remote/remote.css
ui/remote/remote.js
ui/tracking/tracking.js
```

Remaining 16 paths, each under `docs/ai/runs/keep-this-framing-evidence/2026-10-07T23-53-38-625Z/`: `desk-disabled.png`, `desk-held.png`, `desk-keyboard-hold.png`, `desk-keyboard-resume.png`, `desk-paused-ready.png`, `desk-poll-failure.png`, `desk-reset.png`, `remote-control-off.png`, `remote-disabled.png`, `remote-held.png`, `remote-keyboard-hold.png`, `remote-keyboard-resume.png`, `remote-paused-ready.png`, `remote-poll-failure.png`, `remote-reset.png`, `report.json`.

PR #90 original tested head `f708df3`: **15 paths since `aea1f13`**, all included as existing developer proof/qualification records, not completed production streaming:

```text
docs/ai/contracts/streaming-s1.json
docs/ai/contracts/streaming-wip-publication.json
docs/ai/project-state.md
docs/ai/runs/2026-10-07-streaming-checkpoint-results.json
docs/ai/runs/2026-10-07-streaming-s1-mp4-triage.md
docs/ai/runs/2026-10-07-streaming-s1.md
src/broadcast/avOffsetProbe.ts
src/broadcast/ffmpegArgs.ts
src/broadcast/mediaProcess.ts
src/broadcast/runtimeProbe.ts
src/broadcast/tsRelay.ts
src/testing/broadcastPipelineTest.ts
src/testing/broadcastRuntimeProbe.ts
tests/broadcast/ffmpegArgs.spec.ts
tests/broadcast/tsRelay.spec.ts
```

PR #60 observed `1c94e68`: **23 paths since `aea1f13`**, already included in its remote branch; not locally changed, copied or qualified in this run:

```text
.gitignore
src/app/health.ts
src/app/remoteEnabledStore.ts
src/app/state.ts
src/atem/atemClient.ts
src/atem/fakeAtemClient.ts
src/atem/switcherActions.ts
src/config/configLoader.ts
src/index.ts
src/model/controlStateMachine.ts
src/model/sonyZoomRouter.ts
src/testing/remoteEnabledStoreTest.ts
src/testing/sandbox/fakeSonySidecar.ts
src/testing/sandbox/sandbox.ts
src/testing/smokeTest.ts
src/testing/virtualAtem.ts
src/testing/zoomNoticeTest.ts
src/ui/statusServer.ts
ui/remote/iphone/index.html
ui/remote/iphone/remote.css
ui/remote/iphone/remote.js
ui/remote/iphone/remoteModel.js
ui/remote/remote.js
```

## Remaining exclusions, retained without cleanup

### Concurrent rewrite after initial inventory

Before committing, fresh `ls-remote` caught PR #91 force-updated by another owner to `ce2a951274b4ef978c03e2e1a59bc77b00d14670`, and main moved to `ce98b2d684ea31a4b8adda21d2fd1ee82b5f485b` when that owner merged PR #60. This manager performed no merge, rebase or force-push. Original framing/state/docs test surfaces compared equal; other integration paths changed, so a fresh bounded software re-gate was dispatched. Manager created `docs/camcontrol-preservation-handoff` from the new remote head using non-destructive `git switch -c`, carrying only four staged docs because their baseline paths were unchanged. Its draft is stacked on PR #91, not pushed over the active owner. The 62-path preservation total remains unchanged. Initial main/PR tables and historical tests above are snapshots, not claims that the old heads are still current. Old local `feat/combined-studio-framing` at `1e7e1ad` is retained without cleanup; its two pre-rewrite commits are superseded by the externally rebased framing/docs commits, not missing implementation.

- Three newly generated primary framing-evidence directories `2026-10-13T17-47-21-148Z`, `2026-10-13T17-51-55-770Z`, and current-head rerun `2026-10-13T18-06-07-827Z`: **48 nonignored files (45 screenshots, three reports)**. Excluded from publication as duplicate generated diagnostics; retained locally. Runnable tests and the concise verification receipt are published. No claim of a completely clean primary tree while these remain.
- Nine primary ignored root groups and three streaming ignored groups above: credentials, external tools, dependencies, cache/build/runtime configuration/logs; no maintained implementation omitted. Ignore groups are directory-level exclusions, not a misleading exact dependency-file total.
- Recovery archive has six historical worktree snapshots; the streaming archive alone has 476 regular files. Exactly two essential small fixtures were selected. Remaining media, old source snapshots, diagnostics, and incomplete superseded controller work are retained privately, excluded rather than replayed.
- All 56 reflog-only historical commits are retained locally/in the prior history bundle. DeckLink is preserved separately; Oct3 agent work was consolidated at `bf3921a` (code tree equal to `af5ffdb`, except state docs), and older pre-main consolidation history is represented by squash `3663090` and later fixes. Historical metadata is not allowed to overwrite current state. No reflog cleanup or stash drop.
