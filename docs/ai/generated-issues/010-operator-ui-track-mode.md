# T10 — Operator UI: Track mode, overlay, cancel

**Labels:** `feature`, `tracking`, `ui` · **Size:** M · **Depends on:** T6 · **Plan:** `docs/ai/current-plan.md`

## Goal
Let the operator click a person in the Sony preview to start tracking, see what the system thinks, and stop it instantly.

## Context
- The Sony widget already converts clicks to normalized image coordinates with letterbox handling (`sonyContainedPoint`) and currently sends **touch AF** (`sendSonyTouch`). Track mode must not break that.
- UI is inline JS/HTML inside `statusServer.ts`; `scripts/check-page-js.cjs` validates the page JS.

## Likely files
- `src/ui/statusServer.ts` (inline CSS/JS/HTML)
- `scripts/check-page-js.cjs`
- `docs/ai/runs/artifacts/tracking-ui/` (screenshots, like the Sony runs)

## Acceptance criteria
1. Per-preview mode toggle **Focus (touch)** / **Track**; default Focus; the choice is per camera and not persisted across reloads.
2. The Track toggle is shown only for Sony cameras that have a configured, currently resolvable tracking source; otherwise hidden or disabled with a reason.
3. In Track mode a click calls `POST /api/tracking/select` (not touch) and shows an immediate "Locking…" state.
4. Overlay shows the target box and a state badge: *Locking / Tracking / Holding / Target lost / Sidecar offline / Stale video / Override (stick)*. Colors and text meet contrast needs and work with the existing dark mode; states are announced via an `aria-live` region.
5. **Stop tracking** button always visible while a session exists, one click, calls `cancel`. `Esc` also cancels when the preview is focused.
6. After `operator_override`, the UI shows a clear "Paused — stick moved" state with an explicit **Resume** button; nothing resumes on its own.
7. Polling of `/api/tracking/status` pauses when `document.hidden` and uses the same backoff style as `pollSonyFrame`.
8. Focus-mode touch AF behaves exactly as before.
9. Mobile and tablet layouts of the Sony widget are not degraded.

## Tests / evaluation
`node scripts/check-page-js.cjs`; browser fixture run with a fake status payload for every state (desktop, tablet, mobile, dark); smoke for the routes already covered in T6. `pnpm build`; `STATUS_PORT=<free> pnpm test:smoke`.

## Out of scope / data safety
No settings editor, no zoom/framing controls, no recording. Overlay boxes are drawn client-side from status data; no frames are copied or stored by the page beyond the existing preview blob handling.
