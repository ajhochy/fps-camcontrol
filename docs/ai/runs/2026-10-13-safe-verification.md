# Safe preservation verification — 2026-10-13

## Identity and evidence boundary

Independent worker `verification-gate`, run `b5395f5b-40ec-47d8-9acd-8da63dc83265` / engine session `ses_ec9a13caaffeV5TK1a2VnGyI7D`, executed checks against primary product HEAD `1e7e1adf01f59b682e1e03eb97572f96705261da` and streaming product HEAD `f708df369cbaf8ab2e0c66fe1a00c426ffa47007`. Manager recovered actual command/output receipts from the worker's session; its final summary was initially empty, so no blanket independent PASS is inferred. Subsequent preservation changes are docs and existing fixture bytes only; checked product files remain unchanged. Developer host: Node 22.23.0, pnpm 11.1.2. No target-machine OS/runtime observation, hardware qualification, merge or deployment.

That verifier ultimately returned **FAIL with bounded passes**, consistent with the receipts below. Before publication another owner externally merged PR #60/main and rewrote PR #91 to `ce2a951`; the old checks do not automatically qualify the rewritten source. Manager switched its docs onto a new branch based on that remote head (no merge/rebase/force-push), and dispatched fresh bounded build/page/framing checks under run `2bb73b4d-18bc-40f3-a673-2293f1ed9408`. No physical or full-suite qualification is inferred from any rerun.

## Current rewritten-head re-gate

Independent run `2bb73b4d-18bc-40f3-a673-2293f1ed9408` executed against **`ce2a951274b4ef978c03e2e1a59bc77b00d14670`** on the separate docs branch. `pnpm build` exit 0 (2,324 ms), page-JS exit 0 (301 ms), serialized security/frame-access/controller/combined/framing command without a name filter exit 0: **32 tests, 32 pass, zero failures/skips** (31,394 ms). Source manifest before/after: `2d446ae14ac6e298b0047fc4872d0701c4ee66bf0a763d9d19e657381f9cd62d`; checked source diff empty; HEAD unchanged. Worker report is **PASS_BOUNDED_SOFTWARE**, not full gate. New local synthetic evidence directory `2026-10-13T18-06-07-827Z` is retained/excluded like the previous two. Total excluded new generated files: 48 (45 PNGs, three JSON reports). Broader contract/manager failures below were not rerun against the rewrite and remain unresolved, not freshly passed or re-proven failures on that head.

## Actual checks

| Command / scope | Actual result |
| --- | --- |
| `pnpm build` in primary | Exit 0, TypeScript typecheck/emit passes. |
| `node scripts/check-page-js.cjs` in primary | Exit 0; two embedded script blocks and seven standalone UI files parse. |
| `pnpm build` in streaming | Exit 0. |
| `node --test --test-concurrency=1 -r ts-node/register/transpile-only tests/broadcast/ffmpegArgs.spec.ts tests/broadcast/tsRelay.spec.ts` in streaming | Exit 0; 3/3 pass, no skips. In-memory/argument checks; no FFmpeg recording or capture executed. |
| Primary desktop-session/frame-access security, controller, combined-studio-framing, keep-this-framing suites, serialized with controller disabled | Completed bounded rerun exit 0; 32/32 pass, zero failures/skips, including real synthetic browser/API path. |
| Primary contract issue-23/24/28/33 suites | Exit 1; 23 tests, 22 pass, one failure: issue-23-c4 `Missing expected exception` at `tests/contract/issue-23.spec.ts:36`. |
| Initial focused set above plus manager suite | Assertion errors reading `rig-one` from missing `config.speeds` at `src/tracking/trackingManager.ts:64`; command exceeded 180-second tool timeout. No completed full-set summary/green result. |
| Isolated manager `--test-name-pattern='issue-26-c1:'` | Exit 1; one test, zero pass, same TypeError. |
| `git diff --check aea1f13..HEAD` primary | Exit 0. |
| `git diff --check origin/main...HEAD` primary | Exit 2; whitespace in four inherited Sony patch assets. Not silently normalized: patch context/bytes preserved. |
| Streaming PR diff and both current worktree text diff checks | Exit 0. |
| Bounded secret screening of primary/streaming added lines | Zero real credential findings; one credential-URL test sentinel reviewed, not a production secret. This is pattern screening, not exhaustive certification. |

Exact bounded primary rerun used:

```sh
CAMCONTROL_NO_CONTROLLER=1 node --test --test-concurrency=1 --test-name-pattern='^(?!c5 desk)' -r ts-node/register/transpile-only tests/security/desktop-session.spec.ts tests/security/tracking-frame-access.spec.ts tests/tracking/controller.spec.cjs tests/tracking/combined-studio-framing.test.cjs tests/tracking/keep-this-framing.test.cjs
```

Despite the name-filter expression, actual output includes the `c5 desk and iPad` browser test as pass; the executed 32-test count is reported rather than assuming a skip. Contract command:

```sh
CAMCONTROL_NO_CONTROLLER=1 node --test --test-concurrency=1 -r ts-node/register/transpile-only tests/contract/issue-23.spec.ts tests/contract/issue-24.spec.ts tests/contract/issue-28.spec.ts tests/contract/issue-33.spec.ts
```

Mock warnings about incomplete Sony/VISCA health fixtures were observed; do not call the run warning-free. Two local generated framing-evidence directories contain 30 screenshots/two reports, deliberately excluded from publication as duplicate diagnostics and retained on disk. Existing source tests remain runnable.

Those counts describe the first verifier's run; the current-head re-gate above adds a third directory, making the final count 48 excluded generated files.

## Not run / not qualified

- Full `scripts/checks.cjs pr` / full tracking suite: not completed, known focused blockers remain.
- Sandbox smoke/selftest: not rerun because runner deletes/recreates existing `sandbox/.run`; existing runtime data was preserved under the no-destructive-cleanup constraint. Synthetic controller/browser/security checks above are the safe simulated checks actually run.
- Pinned Python/model staging and actual inference, installed Electron package/runtime, signing/notarization, clean Mac/HID/TCC, real Safari, physical tracking/gain/override/dead-man/soaks: not run.
- No FFmpeg media/recovery/matrix/hour-soak, recording, camera capture, PTZ or drive test. Restored fixture presence/hash is not fresh recovery evidence.
- PR #60 changed remotely to `1c94e68` during inventory; no local runtime checks of that concurrent line are claimed.

## Separate DeckLink review

Independent static reviewer `ec23f068-b223-45c4-b5ac-c89ca1785430` confirmed all 53 stash bodies preserved (two docs add warning blocks), exactly 54 authorized paths, script syntax exit 0, all 49 license blocks unchanged, 399,286 candidate bytes plus 15,993-byte receipt, no credential pattern hits. Publication as draft only; unverified downloads/path handling/fixed scratch/SDK16 versus historical driver14.2 and preview-only runtime remain execution blockers. No script/build/enumeration executed.

After staging, manager `git diff --cached --check` for DeckLink exited **2**, with **982 upstream SDK whitespace findings**. The pre-staging check omitted untracked SDK files; this is not an all-payload green whitespace result. Header/source/license bytes were deliberately preserved, not reformatted. The receipt subsequently gained this qualification; the reviewer’s original receipt-size measurement is historical, not its final size. Primary and streaming staged whitespace checks exited 0.

Final staged reviewer `16b2d6ec-602a-4876-b860-a3eb1a876dbd` independently passed the 62-path allowlist, index fixture hashes, stash-byte/license preservation, secret screening, relative links and drift checks, but returned **FAIL** solely because the DeckLink receipt advertised an empty-index pre-staging snippet as repeatable after staging. Manager corrected the documentation to label it historical/pre-staging only and identify index-based final checks. No preserved source or test logic changed. Current-head recheck remains required after the concurrent rewrite.

## Readiness decision

Read-only failure-triage `fbb48aab-2f38-40b4-a063-02232f2cf058` classified issue-23-c4 as a stale expectation rejecting now-supported VISCA, and manager failure as handwritten fixture config omitting schema-defaulted `speeds`. The helper/test/schema blobs and failing manager expression match `aea1f13`; this proves source identity, **not an executed baseline pass/fail**. Normalize fixtures using existing `TrackingSchema.parse`, retain unknown/unsupported-device rejection while asserting VISCA support, and protect bridge cleanup around constructor failures in the next focused test repair. No product fallback or essential packaging defect is justified by this evidence. No test assertions were weakened or product code changed in this preservation run.

Preservation and further isolated development are supported; full software acceptance and CamControl hardware readiness are **not** established. Keep every PR draft. Repair/classify the disclosed test fixtures/configuration contract before relying on broad gates; qualify target SDK/runtime and conduct later explicitly authorized physical acceptance. Do not treat successful GitHub release-tooling validation as source-suite or hardware verification.
