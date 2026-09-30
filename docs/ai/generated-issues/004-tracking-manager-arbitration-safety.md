# T4 — `TrackingManager`: sessions, 20 Hz tick, arbitration, safety stops

**Labels:** `feature`, `tracking`, `safety` · **Size:** L · **Depends on:** T1, T3 · **Plan:** `docs/ai/current-plan.md`

## Goal
Own per-gimbal tracking sessions: feed observations to the control law, send results through `MotionDevice.setPanTilt` using the existing rate limiter, and guarantee `stop()` on every exit path. Tracking must never fight the operator.

## Context
- `ControlStateMachine` only sends when a stick moves or a transition occurs, and it early-returns when input is missing/stale — so the manager needs its **own** loop (20 Hz = `GIMBAL_MIN_SEND_MS`).
- `shouldSendMotion(protocol, changed, lastSentAt, now)` is already exported. A stop is **never** rate-limited (a dropped stop is a camera that keeps moving).
- `emergencyStopAll(state, config, atem, devices)` currently only calls `device.stop()`.

## Likely files
- `src/tracking/trackingManager.ts` (new)
- `src/model/controlStateMachine.ts` (override hook only)
- `src/safety/emergencyStop.ts`
- `src/index.ts` (construct, wire, shutdown)
- `src/app/state.ts` (`tracking` status map; follow the `cameraConnected` pattern incl. `createInitialState`)

## Acceptance criteria (each is a separate test)
1. A session binds a source to its active slot via T1's resolver; unresolvable source ⇒ status `unavailable`, no error.
2. Output goes through `shouldSendMotion`; with `virtualDjiBridge` the observed command rate never exceeds 20/s and heartbeats keep it inside the 250 ms bridge watchdog.
3. **Operator override:** stick motion on the camera that is both *controlled* and *tracked* ⇒ session suspended (`operator_override`), one `stop()`, no tracking motion afterward until an explicit `resume`. Stick motion on a *different* camera does not affect tracking.
4. **Emergency stop** ⇒ every session cancelled and `stop()` sent (manager is notified from `emergencyStopAll` or the machine's back-button path).
5. **Stale data:** no fresh observation for 500 ms ⇒ `stop()`, state `stale`; fresh data does not auto-resume a suspended session but does resume a merely stale one.
6. **Device loss:** `connected` or `gimbalAttached` false ⇒ `stop()` and session ends with reason.
7. **Shutdown:** SIGINT/SIGTERM path stops all sessions before exit.
8. `lost` ⇒ immediate `stop()`, hold `lostHoldMs`, then `idle`.
9. Disabled config ⇒ manager is inert (no timers, no sockets).
10. All state transitions emit an event and are reflected in `AppState` for the status API.

## Tests / evaluation
Smoke with `virtualDjiBridge` (hello, moveVelocity, 250 ms safety timeout) and a stub observation source; assert exact `stop` counts per scenario. `pnpm build`; `STATUS_PORT=<free> pnpm test:smoke`.

## Out of scope / data safety
No WebSocket client (T5), no HTTP routes (T6), no UI. No VISCA support in v1 (registered device must be `dji-bridge`). No persistence of targets or observations. `controlStateMachine.ts` changes limited to the override hook — no refactor.
