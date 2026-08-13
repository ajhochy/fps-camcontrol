date: 2026-08-13
repo: fps-camcontrol
branch: feat/sony-dashboard
pr: "#8 (b3715b0)"
issues: focused Sony dashboard request
status: ready_for_verification

## Contract
- `docs/ai/contracts/task-sony-dashboard.json`
- Phase 0 failing run: `pnpm test:smoke` failed in Test 9b with six missing Sony UI assertions and `/api/sony/cameras` returning the homepage instead of JSON.
- Correction-attempt failing run: `pnpm test:smoke` reported 77 passed / 3 failed for exact hyphenated property names, six forwarded upstream routes, and escaped camera-ID HTML attributes.
- UI review repair attempt 1 failing run: `pnpm test:smoke` reported 80 passed / 8 failed for reconciliation, narrow layout, accessible preview/discovery/connect states, 44px targets, and widget headings.
- UI review repair attempt 2 failing run: `pnpm test:smoke` reported 88 passed / 1 failed because preview aria-live updates were not guarded by per-camera announcement state.
- Current Phase 0 failing run: `pnpm test:smoke` reported 90 passed / 4 failed for cached list checks and desktop/tablet/mobile layout guards; the final run passes 94/94.
- Automated criteria c1-c11 and c15-c24 now pass. Manual hardware criteria c12-c14 remain `not_tested`.

## Files changed
- `src/ui/statusServer.ts`
- `src/testing/smokeTest.ts`
- `docs/ai/contracts/task-sony-dashboard.json`
- `docs/ai/runs/2026-08-13-sony-dashboard.md`

## Checks run
- `pnpm build` — pass.
- `pnpm test:smoke` — pass, 94/94 assertions; covers cached discovery/connection checks, nested live response normalization, four connected plus one disconnected fixture, and exact responsive grid guards.
- `git diff --check` — pass.
- GitNexus pre-edit impact — low risk; `createStatusServer` has one direct caller (`main`) and `statusHtml` has one direct caller (`createStatusServer`), affecting the indexed main flow.
- GitNexus `detect_changes(scope=all)` — low risk, four changed symbols and no affected indexed processes.

## Notes
- Native Node `fetch`, inline Express UI, and existing dependencies only.
- `SONY_API_URL` remains server-side and defaults to `http://127.0.0.1:8181`.
- Live sidecar property contract preserved exactly: `aperture`, `shutter-speed`, `iso`, `white-balance`, `focus-mode`, `focus-area`; underscores remain absent from upstream routes and lookups.
- Camera IDs remain MAC-only at proxy validation; generated HTML attribute values now use the existing `esc` helper, extended to quote escaping.
- Live a7S III success confirmed. Explicit discovery and connect cache camera identities; list refreshes use lightweight per-camera connection GETs, with a deduplicated 45-second discovery window when cache is empty. Discovery failure preserves the cache.
- Nested `camera` and `data` responses are merged and derive `camera.connected`; connect has a 30-second timeout while property/touch paths stay short and literal-colon IDs remain intact.
- AJ sizing repair: desktop uses four equal columns, tablet two, mobile one; Sony cards are compact with 16:9 previews and two-column settings. Initial oversized-card smoke failure is resolved; AJ visual recheck remains pending.
- Preview start non-OK responses are surfaced and stop polling; frame polling remains sequential, hidden-aware, and bounded.
- Preview visual loading/stale classes are unchanged; only aria-live writes are gated by the per-camera preview announcement state.
- Manual smoke targets (`not_tested`): two physical Sony cameras concurrently; touch focus action on physical FX3; live HDMI coexistence.
- Initial final smoke attempt encountered `EADDRINUSE` because importing `statusServer` also starts `index.ts`; the smoke harness now sets `STATUS_PORT=0` before that import. No production startup behavior changed.
