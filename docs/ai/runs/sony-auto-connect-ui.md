# Sony auto-connect UI repair, final attempt 2 — 2026-08-14

repo: `/Users/ajhochhalter/Documents/fps-camcontrol-sony-worktree`  
branch: `feat/sony-dashboard`  
PR: #2 integration branch; no commit or push performed  
status: READY_FOR_VERIFICATION

## Contract
- `docs/ai/contracts/sony-auto-connect-ui.json`
- Red baseline: `STATUS_PORT=18781 pnpm test:smoke` — 211 passed, 4 failed (c11 reusable service retry, c12 setup route/link, c13 error persistence/recovery, c14 dashboard long-ID wrapping).
- Focused repair run: 214 passed, 1 failed because the route-content assertion expected `Sony sidecar` instead of the document's current `Sony CameraWebApp sidecar setup`; corrected the fixture wording without changing product behavior.
- Green evidence: `STATUS_PORT=18781 pnpm test:smoke` — 215 passed, 0 failed. Prior 211 checks remain passing and c11-c14 are `pass` only from this run.
- Physical pairing numeric classifier: `not_tested`; exact live sidecar failure codes are not pinned.

## Files changed
- `src/ui/statusServer.ts` — reusable service-retry pending guard, fixed setup-document route/link target, persistent dashboard refresh errors, and scoped dashboard ID wrapping while retaining stable rows and four-up layout.
- `src/testing/smokeTest.ts` — four executable c11-c14 assertions while retaining the prior 211 checks.
- `docs/ai/contracts/sony-auto-connect-ui.json` — c11-c14 acceptance criteria and evidence.
- `docs/ai/runs/sony-auto-connect-ui.md` — this final focused repair receipt.

## Checks run
- `pnpm build` — pass (`tsc`).
- `pnpm exec ts-node src/testing/sonyConfigStoreTest.ts` — 8 checks passed.
- `pnpm exec ts-node src/testing/sonyManagerTest.ts` — 103 checks passed across 12 criteria.
- `pnpm exec ts-node src/testing/sonyManagerTest.ts` — second run, 103 checks passed across 12 criteria.
- `STATUS_PORT=18781 pnpm test:smoke` — 215 passed, 0 failed; port checked free before launch.
- `node scripts/check-page-js.cjs` — pass; emitted page script parses.
- `git diff --check` — pass after contract and run-note finalization.
- GitNexus impact before edit: `statusHtml` and `createStatusServer` LOW risk; direct production caller is `main` in `src/index.ts`.
- Pre-change API impact for `/docs/sony-sidecar-setup` found no existing route or consumers. The new route has no path input and serves only the fixed setup Markdown file as plain text; arbitrary docs paths remain 404.
- GitNexus change detection: medium aggregate worktree risk because this branch also contains previously completed config/manager integration; one indexed process affected (`Main → WaitForConnection`).

## Notes
- Scope remained limited to the four assigned files. Other modified/untracked files shown by worktree status are inherited manager/config/setup work and were not edited in this repair.
- Existing stable row reconciliation, focus retention, pending camera actions, four-up dashboard, Device Config wrapping, and manager/config implementation were preserved.
- No dependencies, API response shapes, packaged runtime, performance-sensitive paths, or public symbol names changed. One fixed-path readable setup-document GET route was added.
- Live two-camera/power-cycle and physical pairing classifier evidence remain required; prior ordinary a7S III success is historical evidence only.
