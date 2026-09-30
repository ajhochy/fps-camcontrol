# T12 — Latency calibration + gain tuning tool

**Labels:** `feature`, `tracking`, `tooling` · **Size:** M · **Depends on:** T4, T9 · **Plan:** `docs/ai/current-plan.md`

## Goal
Measure the real command-to-visible-motion delay of the rig and turn it into recommended `pipelineDelayMs` / gain values, so tuning is evidence-based instead of guesswork.

## Context
End-to-end delay = Sony live-view latency + polling + sidecar + WS + control tick + BLE + gimbal response. The simulator (T3) needs a realistic delay number, and the control law's latency-aware gain depends on it. The gimbal's live gain (200 vs 80) is also unverified, so velocity→angular-rate is unknown.

## Likely files
- `scripts/tracking-calibrate.ts` (or `.py`; choose by where frame diffing is simplest) and a `pnpm` script
- `src/tracking/` (config hook for `pipelineDelayMs`, `kp`, `kd` if not already in T3/T4)
- `docs/ai/runs/` (results note), `docs/tracking.md`

## Acceptance criteria
1. Procedure: command a short, **capped** pan step (≤ 0.15, ≤ 1 s) through the normal device path, pull frames from the live-view endpoint, and detect motion onset by frame differencing; report onset delay and steady angular-rate per unit velocity (from frame displacement).
2. Runs against the mock/virtual stack in a dry-run mode that prints a plausible report without hardware.
3. Refuses to run unless tracking/gimbal are connected, the operator passes an explicit `--yes-move` flag, and always ends with `stop()` (also on Ctrl-C/exceptions).
4. Output is a recommended config snippet plus raw numbers; it does **not** edit `devices.yaml` automatically.
5. Repeats N trials and reports median/spread; flags high variance as "unreliable rig".
6. A results table (delay, rate, recommended gains) is added to a `docs/ai/runs/` note after a human-run on the real rig.

## Tests / evaluation
Dry-run test against virtual gimbal + synthetic frames; unit test for the onset detector on synthetic image sequences. Real-rig run is a **human gate** recorded in the run note.

## Out of scope / data safety
Not a continuous auto-tuner. Frames used for differencing stay in memory and are discarded; no captures saved. The script must never command motion above the stated cap.
