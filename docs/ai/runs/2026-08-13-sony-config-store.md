date: 2026-08-13
repo: fps-camcontrol
branch: feat/sony-dashboard
slice: sony-config-store
status: ready_for_verification

## Contract
- `docs/ai/contracts/sony-config-store.json`
- Phase 0 failing command: `pnpm exec ts-node src/testing/sonyConfigStoreTest.ts`
- Failure before implementation: missing `../sony/sonyStateStore`, missing `AppConfig.sony`, and dependent implicit type errors.

## Changed files
- `src/config/configLoader.ts`
- `src/sony/sonyStateStore.ts`
- `src/testing/sonyConfigStoreTest.ts`
- `docs/ai/contracts/sony-config-store.json`
- `docs/ai/runs/2026-08-13-sony-config-store.md`

## Checks
- `pnpm exec ts-node src/testing/sonyConfigStoreTest.ts` — pass, 8 checks: defaults/env precedence/backcompat save preservation; restart persistence; update/forget; unsupported metadata rejection; duplicate-schema quarantine; serialized writes; pre-rename preservation; output mode.
- `pnpm build` — pass.
- `git diff --check` — pass.
- GitNexus pre-edit impact: `loadConfig` low risk, one direct caller (`main`); this slice does not modify its caller.

## Interface handoff
- `AppConfig.sony?: SonyRuntimeConfig` exposes `enabled`, `apiUrl`, optional absolute `executable`, and resolved `stateFile`.
- `SonyStateStore` exposes `load()`, `approve(approval)`, and `forget(id)`; its constructor accepts a state path plus narrow `fs.rename` and `now` dependencies for focused tests.

## Risks
- `SONY_API_URL` accepts any valid URL here; loopback-only managed launch belongs to the later manager slice.
- Existing unrelated `docs/ai/current-plan.md` worktree modification was present before this slice and remains untouched.
