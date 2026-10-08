---
date: 2026-10-01
repo: fps-camcontrol
branch: feat/electron-foundation
pr: null
issues: [40]
status: pass
tags: [run, fps-camcontrol]
index: "[[fps-camcontrol]]"
---

### 2026-10-01 — issue-40-app-home-paths

- Files modified: `src/config/paths.ts` adds side-effect-free mutable-home and read-only resource resolution; `src/config/configLoader.ts`, `src/index.ts`, `src/ui/statusServer.ts`, and `src/model/presetManager.ts` use it for mutable config/profile/preset paths and the packaged Sony guide.
- Checks run: initial `node -r ts-node/register/transpile-only tests/contract/issue-40.spec.ts` failed as required because `src/config/paths.ts` was absent; final contract passed 3/3. `pnpm build` passed. `pnpm exec ts-node src/testing/sonyConfigStoreTest.ts` passed 8 checks; `pnpm exec ts-node src/testing/workingProfileTest.ts` passed 33 checks; `CAMCONTROL_NO_CONTROLLER=1 pnpm test:smoke:isolated` passed 268/268 using virtual hardware; `CAMCONTROL_NO_CONTROLLER=1 pnpm sandbox:check` passed 104/104; `git diff --check` passed.
- Decisions made: `CAMCONTROL_HOME` is resolved on every helper call and never creates files at import. Per-file overrides (`DEVICES_CONFIG`, `SPEEDS_FILE`, `MAPPINGS_FILE`, `PRESETS_FILE`, `PROFILES_DIR`, `SONY_STATE_FILE`) retain precedence. `CAMCONTROL_RESOURCES` remains separate for read-only bundle content; absent overrides preserve cwd-based development behavior.
- Deviations from spec: none.
- Verification limitation: `ai-workflow checks` was unavailable because `scripts/run_ai_workflow.py` is missing; its fallback `npm run typecheck` is also unavailable because the script is not defined. The local checks above are the documented fallback evidence.
- Concerns: this slice deliberately does not seed user data, alter embedded lifecycle, or validate a packaged Electron bundle; those remain later planned slices. The repository had pre-existing dirty Electron lifecycle changes in `src/index.ts` and `src/ui/statusServer.ts`; this run changed only their path-resolution hunks. The worktree remains dirty with uncommitted changes; no commit or PR was created. Whole Electron delivery remains in progress, with P1.2 / issue #41 embedded backend lifecycle next.
