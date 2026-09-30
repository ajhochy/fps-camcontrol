# T2 — Sony live-view frame capture timestamp

**Labels:** `feature`, `tracking`, `sony` · **Size:** S · **Depends on:** none · **Plan:** `docs/ai/current-plan.md`

## Goal
Give every live-view frame a server-side capture time so downstream consumers can compute frame age and pipeline latency. Expose it as a response header; no browser behavior change.

## Context
`SonyManager.liveViewFrame()` returns `SonyFrame { contentType, body }` with no timing. Tracking needs `age = now − capturedAt` (plan: latency-aware gain, stale decay). `readOnce` coalesces concurrent reads onto one upstream request, so a second consumer (the tracker sidecar) shares the cost with the browser.

## Likely files
- `src/sony/sonyManager.ts` (`SonyFrame`, `liveViewFrame`, `requestBinary`)
- `src/ui/statusServer.ts` (`GET /api/sony/cameras/:id/live-view/frame`)
- `src/testing/sonyManagerTest.ts`

## Acceptance criteria
1. `SonyFrame` has `capturedAt: number` (epoch ms, set when the upstream response body is fully received).
2. The frame route sets `X-Frame-Captured-At` (epoch ms) and `Cache-Control: no-store`; body/content-type unchanged.
3. Two concurrent callers of `liveViewFrame` receive the **same** `capturedAt` (coalesced) — documented by a test.
4. `503`/`Retry-After` busy-lane and error paths are unchanged.
5. Existing Sony preview polling in the browser keeps working (it ignores the new header).

## Tests / evaluation
- Extend `sonyManagerTest.ts`: header/field present; coalesced callers share the timestamp; busy lane still yields the retryable error.
- **To verify while implementing:** `sonyManagerTest.ts` is not referenced by `package.json` or `smokeTest.ts` — confirm how it runs (likely `ts-node` directly) and, if it is orphaned, wire it into `pnpm test:smoke` or document the command in `docs/ai/testing-guide.md`.
- `pnpm build`; `STATUS_PORT=<free> pnpm test:smoke`.

## Out of scope / data safety
No frame storage, caching, or logging of frame bytes. No change to polling cadence. No tracking code.
