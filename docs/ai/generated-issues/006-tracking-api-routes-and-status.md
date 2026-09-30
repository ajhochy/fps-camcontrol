# T6 — Tracking API routes + AppState status

**Labels:** `feature`, `tracking`, `api` · **Size:** M · **Depends on:** T4, T5 · **Plan:** `docs/ai/current-plan.md`

## Goal
Expose tracking to the UI: status, select-by-click, cancel, resume. Routes adapt; the manager owns state.

## Context
`statusServer.ts` already validates normalized touch coordinates for `POST /api/sony/cameras/:id/touch` — mirror that validation. Routes must not hold tracking state or timers.

## Likely files
- `src/ui/statusServer.ts` (routes only)
- `src/app/state.ts` (types, if not finished in T4)
- `src/testing/smokeTest.ts`

## Routes
- `GET /api/tracking/status` → `{ enabled, sidecar: {state, version?}, sources: [{ sourceId, sonyCameraId, cameraId|null, state, reason?, target?: {cx,cy,w,h,conf}, ageMs? }] }`. Never includes frame data, file paths, or raw sidecar errors.
- `POST /api/tracking/select` `{ sourceId, x, y }` — finite numbers in [0,1].
- `POST /api/tracking/cancel` `{ sourceId }`; `POST /api/tracking/resume` `{ sourceId }`.

## Acceptance criteria
1. Invalid body/coords ⇒ `400`; unknown `sourceId` ⇒ `404`; tracking disabled ⇒ `409`; source unavailable (gimbal not in profile / detached) ⇒ `409` with a curated reason.
2. `select` while the gimbal's device is disconnected is refused, not queued.
3. `cancel` is idempotent and always results in `stop()` being sent.
4. `/api/status` remains backward compatible (only additive keys).
5. No route blocks on the sidecar: `select` returns after the command is handed to the client (state then flows through status).
6. Rate-limit or coalesce repeated `select` (e.g. ≥ 250 ms between accepted selects per source).

## Tests / evaluation
Smoke: validation table; 404/409 paths; cancel idempotency; status shape with a virtual sidecar and virtual gimbal; `/api/status` snapshot unchanged except additive keys. `pnpm build`; `STATUS_PORT=<free> pnpm test:smoke`.

## Out of scope / data safety
No UI (T10). Endpoints are as open as the existing status server (`0.0.0.0`); note in the PR that `select`/`cancel` can move a physical gimbal from anywhere on the LAN, consistent with the existing config/preset routes — do not add auth in this issue, but record it as a risk in `docs/ai/project-state.md` via the state updater.
