# Streaming fixture preservation — 2026-10-13

## Scope / ownership

Assigned preservation slice only: `/Users/ajhochhalter/Documents/fps-camcontrol-streaming-s1`, branch `feat/streaming-s1-media-proof`, observed HEAD `f708df369cbaf8ab2e0c66fe1a00c426ffa47007`; initial status clean. User authorized these two essential existing synthetic test dependencies as a 13,976-byte exception to excluded large/generated media, plus this note and an additive current project-state fact. No production/test edits, new features, hardware, recording, other archive imports, staging, commits, push, PR, deployment, app or FFmpeg commands. Separate DeckLink agent is untouched; verifier owns all streaming/primary test, build and media execution; manager owns Git publication.

## Phase 0 — non-behavioral contract

WAIVED: behavioral acceptance execution for non-behavioral byte-preservation/documentation work; user reserves tests/build/media execution to the verifier. Loaded acceptance-contract first, then coding-agent. Static acceptance: exactly two regular archive members at exact relative paths, unchanged bytes with the sizes/hashes below; exclusive destination creation without symlink/traversal or overwrite; exactly four changed files; historical receipt retained; whitespace diff check clean. These are preservation checks, not recovery acceptance.

## Phase 1 — bounded impact review

Read AGENTS.md and all six canonical docs, both historical S1/triage run notes, and `src/testing/broadcastPipelineTest.ts:160–214`. Lines 189–195 reference exactly these paths: completed fragment expects 100 video/189 audio samples; uninitialized control expects 88 bytes. Those source lines do not assert SHA-256; hashes come from the user and historical repair receipt at `2026-10-07-streaming-s1.md:25`. Historical triage receipt lines 71–78 records synthetic 1280×720 25fps flash/impulse origin and the 13,888-byte flushed fragment; lines 30–43 records the uninitialized 88-byte header with no recoverable media. These are historical proof sources, not fresh media inspection.

GitNexus lists only the older primary index (`a7eaa935`, Oct3), not this worktree. `gitnexus_impact(target="docs/ai/project-state.md", direction="upstream", repo="fps-camcontrol", summaryOnly=true)` returned target not found / UNKNOWN, not LOW. Current-source fallback covers the entire four-file surface: additive docs and exact existing fixture dependencies only. Risks: overwrite of peer work, importing unrelated evidence, or implying qualification. Mitigation: prevalidate both unique exact regular members and hashes, reject existing destinations, traverse destination directories using no-follow directory descriptors, create with O_EXCL/O_NOFOLLOW, and explicitly preserve unresolved qualification. No consequential scope expansion.

## Phase 2 — exact restoration inventory

Source: private archive `/Users/ajhochhalter/Documents/fps-camcontrol-recovery/20261007-165931/5-fps-camcontrol-streaming-s1/untracked.tar.gz`. Read its member metadata; consumed only the two exact members below using Python stdlib tarfile, without blanket extraction or archive-controlled directories/permissions. Both destination files were absent; both members were unique regular files (not symbolic/hard links), with no absolute/traversal path. Validated archive bytes before writing; exclusive creation and post-write byte equality/hash verification succeeded. No source snapshots, scripts, logs, or other media imported.

| Restored path | Bytes | SHA-256 |
| --- | ---: | --- |
| `docs/ai/runs/artifacts/s1-mp4-triage-20261007-a/flush-completed-fragment.mp4` | 13888 | `eeaa806832e0a016d9aa65a1e1bdc517e24266f2fd2c84b50653bf47bd2f4e49` |
| `docs/ai/runs/artifacts/s1-mp4-repair-20261007-a/pre-repair-dist/pipeline/25-1-0-45/interrupted.mp4` | 88 | `a0a7a96330b3440e3bc4fddf5250dcd5f3da48e1d3c9c14563b70f0a85f530ed` |

Other changed files: `docs/ai/project-state.md` (current preservation fact only, historical text unchanged) and this note. Total: exactly four files; restored binary total 13,976 bytes. Final text-file hashes are returned in the handoff rather than self-embedded.

## Commands / validation / handoff

All shell commands used the assigned workdir. Read-only Git: `git status --short --branch`, `git diff --stat`, `git status --porcelain=v2 --branch`; `ls` confirmed documentation/artifact/archive parents. Restoration command: `python3 -` with stdlib tarfile/hashlib and descriptor-relative exclusive/no-follow creation, returned two RESTORED lines matching the table and `TOTAL 13976 bytes; no other archive member extracted`. No implementation repair loop needed.

Final static commands: `git diff --check` and `git status --short --branch`; `shasum -a 256` over exactly the four inventory files. Whitespace result is recorded below after execution. No tests/build/media execution occurred. Restoring dependencies does NOT mean recovery/pipeline tests reran or passed. `--recovery-contract` now has both referenced fixtures present; runtime/full S1, historical broad failures and existing reconnect/channel-1/queue/architecture gaps remain unresolved. No fresh-checkout publication claim before manager stages/commits these dependencies.

READY_FOR_VERIFICATION for this preservation slice only. Verifier can independently read/hash these files without write access and owns subsequent execution under its own authorization; manager owns staging/commit/push/PR. Existing approvals/exclusions above carry forward unchanged and must not be reopened for this same scope.

Static receipt: `git diff --check` exited 0 with no output. Status showed only project-state modified, this note untracked, and the two restored fixture directories untracked; tracked diff was exactly two additive project-state lines. No historical receipt erased. Final four-file hashes and expanded untracked inventory were obtained after this receipt update.
