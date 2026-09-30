# T3 — `TrackingController` control law + closed-loop simulator

**Labels:** `feature`, `tracking`, `control` · **Size:** M · **Depends on:** T1 (types only) · **Plan:** `docs/ai/current-plan.md`

## Goal
A pure, I/O-free control law that turns a tracked-target observation into pan/tilt velocity, plus a simulator that proves it is stable under the real pipeline's delay and rate limits **before** any hardware is involved.

## Context
Inputs arrive at ≤ ~8 Hz with 150–500 ms delay; output is paced at ≤ 20 Hz by the BLE path. Open-source and commercial experience says lag beyond the motor response time produces overshoot and hunting. Stability is prioritized over responsiveness.

## Likely files
- `src/tracking/trackingController.ts` (new)
- `src/testing/trackingSim.ts` (new)
- `src/testing/smokeTest.ts` (assertions)

## Spec (from the plan)
Input `{ cx, cy, w, h, conf, frameTs }` + `now`; output `{ pan, tilt, state }`, each axis within `±maxSpeed`.
- Error `e = (cx−0.5, cy−0.5)`; deadzone with hysteresis (still subject ⇒ exactly 0).
- Low-pass (EMA or one-euro) on `e`; PD with damping from filtered de/dt.
- Latency-aware gain: effective `Kp` decreases as `age + pipelineDelayMs` grows.
- Stale decay: scale → 0 over `age` 400→700 ms; `> 700 ms` ⇒ zero/stop.
- Sign: image right ⇒ `pan +`; image up ⇒ `tilt +` (manual convention `pan=rightX`, `tilt=−rightY`); `invertPan`/`invertTilt` flip.
- States: `tracking → holding (lost, within lostHoldMs) → idle`; `lost` ⇒ zero output immediately.

## Acceptance criteria
1. Pure module: no timers, sockets, or imports from devices/UI; time injected.
2. Simulator models: 8 fps frame arrival, configurable capture-to-command delay, 20 Hz output cap, command quantization, and a velocity→angle plant with a first-order lag.
3. For delays of **150, 300, and 500 ms** a step target offset settles inside the deadzone with no sustained oscillation (define and assert a concrete metric, e.g. ≤ 1 sign reversal after first crossing, and overshoot ≤ X% — record X in the PR).
4. Stationary subject ⇒ zero output for the full run; target leaving frame ⇒ zero output within one tick and stays zero.
5. Never outputs beyond `maxSpeed`; never NaN/Infinity for `conf=0`, NaN input, or out-of-range coordinates (treated as invalid ⇒ zero).
6. Sign-mapping and invert tests for all four quadrants.

## Tests / evaluation
Smoke assertions driven by the simulator; include the delay sweep table in the PR description. `pnpm build`; `STATUS_PORT=<free> pnpm test:smoke`.

## Out of scope / data safety
No device I/O, no zoom/framing, no prediction/feed-forward beyond what is needed to meet criterion 3 (note the gap as a follow-up if not). Simulator uses synthetic numbers only.
