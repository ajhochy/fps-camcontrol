---
type: decision
---

# 2026-09-30 — Auto-tracking: Python vision sidecar, TypeScript control loop

## Context
We want click-to-track on a Sony camera mounted on a DJI gimbal. The only video in the app is
Sony live-view JPEG (browser-polled, ~8 fps, 150–500 ms end-to-end). Gimbal motion goes through
`MotionDevice.setPanTilt` over a rate-limited BLE path (≤ ~20 writes/s; 250 ms bridge watchdog).

## Decision
1. **Vision runs in a separate Python sidecar** (`tracker-sidecar/`) on the app's Mac, loopback only,
   speaking WebSocket/JSON (same pattern as `pi-bridge/` and `djiBridgeDevice.ts`).
2. **The control law and all safety live in TypeScript** (`src/tracking/`), behind the existing
   `MotionDevice` interface and `shouldSendMotion`. The sidecar never talks to a gimbal.
3. **Person detection + ByteTrack-style association**, not single-object OpenCV trackers.
4. Detector sits behind an interface; v1 uses ONNX Runtime with a permissively licensed model.
   `ultralytics` (AGPL-3.0) is not adopted without a license review.
5. Tracking is an **additional, lower-priority input**: operator stick, emergency stop, stale data,
   device loss and shutdown all stop it. Disabled by default; conservative speed cap.

## Alternatives considered
- **Node-only inference** (onnxruntime-node): one language, but a heavier native dependency and a weaker
  tracking ecosystem; rejected for v1.
- **Vision on the Pi**: the Pi has no video; rejected.
- **Sony in-camera touch tracking**: only steers focus, exposes no subject position; kept as a possible
  AF-assist follow-up.
- **Promptable trackers (SAM2/ClickTrack)**: heavier and unproven here; revisit if person tracking is brittle.

## Consequences
- A second long-lived process to supervise (launch/health UX is a follow-up).
- Tracking quality is bounded by the Sony polling path; a timestamp on frames (T2) is required to reason about delay.
- VISCA cameras are not covered until a video-ingest milestone exists.
