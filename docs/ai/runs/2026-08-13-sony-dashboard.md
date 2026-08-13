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
- Contract scope: criteria are judged on Sony feature ownership (`src/ui/statusServer.ts`, `src/testing/smokeTest.ts`). The branch diff is deliberately larger because it also carries the in-progress merge of latest PR #2 — see `scope` in the contract.

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
- Merge-resolution Phase 0 failing run: `STATUS_PORT=8176 pnpm test:smoke` failed before edits with TypeScript `TS1185` merge-conflict markers in `src/ui/statusServer.ts`.
- Merge-resolution verification: `git diff --check`, `pnpm build`, `STATUS_PORT=8176 pnpm test:smoke` (206 passed, 0 failed), and `python3 -m unittest discover -s pi-bridge/tests -v` (26 tests) passed.

### Integrated verification evidence (Sony + merged latest PR #2)
- `pnpm build` — pass.
- `STATUS_PORT=8176 pnpm test:smoke` — pass, 206/206 assertions across the combined Sony and PR #2 surface.
- `python3 -m unittest discover -s pi-bridge/tests -v` — pass, 26/26.
- `git diff --check` — pass.
- Browser fixture — pass: desktop four-up Sony grid, tablet two-column, mobile one-column, tab navigation, and dark mode. Replacement screenshots under `docs/ai/runs/artifacts/sony-dashboard/` (`desktop-status.png`, `desktop-device-config.png`, `mobile-300-status.png`); the tablet and dark-mode checks were confirmed in-browser without a saved capture.
- Verification gate outcome — failed on `task-sony-dashboard-c10` only. The failure was contract wording, not behavior: c10 still asserted "no controller/MotionDevice/ATEM/YAML/dependency changes", which held for the standalone Sony slice but reads as false against the combined branch, whose staged merge of latest PR #2 (MERGE_HEAD `54ba67e`) intentionally carries `config/devices.yaml`, `package.json`, `pnpm-lock.yaml`, `src/atem/switcherActions.ts`, `src/devices/motionDevice.ts`, `src/input/controllerSupervisor.ts`, and the rest of PR #2's own files. Confirmed by diff attribution against merge-base `2fbd51f`: the Sony-owned diff touches only `src/ui/statusServer.ts` and `src/testing/smokeTest.ts`. c10 and a new `scope` block in the contract now separate integrated branch scope from Sony feature ownership; no production or test file changed, so the gate needs a documentation-only re-run.

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
- Merge resolution retains Sony's cached explicit discovery, nested connection normalization, 30-second connect, six controls/touch/live preview, and 4/2/1 grid alongside PR #2 Profiles, Device Config non-VISCA preservation, controller/activity/dark-mode behavior, and bridge-aware gimbal status.
