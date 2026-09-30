---
type: project
---

# Current Plan — Click-to-Track Auto-Tracking

> Previous plan (Sony auto-connect, design-only at the time) is archived verbatim at
> `docs/ai/plans/2026-08-13-sony-auto-connect.md`. Its implementation is on `main`
> (`src/sony/`); this plan builds on it.

## Status
Plan only. No product code yet. Issues are drafted under `docs/ai/generated-issues/`
(local files; no remote GitHub issues created).

## Intent and constraints pass

**Goal (one sentence).** The operator clicks a person in a camera's live preview in the
web UI, and the app drives that camera's gimbal so the person stays centered, until the
operator cancels, grabs the stick, or hits emergency stop.

**In scope (v1)**
- Person tracking (click selects a detected person) on a **Sony camera whose video already
  reaches the app** (Sony live-view JPEG via the sidecar) mounted on a **DJI gimbal** that the
  app already drives (`DjiBridgeDevice.setPanTilt`).
- Pan + tilt only. Velocity control through the existing `MotionDevice` interface.
- Safety: operator override, emergency stop, stale-data and lost-target stops, conservative
  speed cap, human-gated live verification.
- Web UI: track mode on the Sony preview, status overlay, cancel.

**Out of scope (v1), file as follow-ups**
- VISCA cameras (BirdDog / V-BOT). Their video goes to the ATEM, **not into the app**
  (`inputId` only); tracking them needs a new video ingest (RTSP/NDI) — a separate milestone.
- Zoom / auto-framing, roll, generic (non-person) object tracking, face re-identification,
  multi-subject tracking, using Sony's in-camera touch-tracking.
- Saving/recalling tracked targets, recording footage, any cloud inference.

**Hard constraints**
- Do not regress manual control. `ControlStateMachine` stays the owner of operator input;
  tracking is an additional input source with strictly lower priority than the stick.
- A dropped *stop* is a camera that keeps moving (comment in `controlStateMachine.ts`): every
  exit path must send `stop()`, and stops must never go through the rate limiter.
- BLE budget: gimbal writes are capped (`GIMBAL_MIN_SEND_MS = 50`, heartbeat 150 ms vs the
  bridge's 250 ms watchdog). Tracking must reuse `shouldSendMotion`, not invent its own pacing.
- **Live gimbal motion at gain 200 is still unverified** (see `project-state.md` risk). Tracking
  ships with a low default speed cap and a human-watched first run.
- Data safety: footage of people. No frames, crops, or embeddings are written to disk or logs;
  test fixtures must be synthetic.
- The smoke suite boots the real app as an import side effect — run with a free `STATUS_PORT`.
- `ai-workflow checks` does not work here. Checks are `pnpm build`, `STATUS_PORT=<free> pnpm test:smoke`,
  `python3 -m unittest discover -s <dir>/tests`, `node scripts/check-page-js.cjs`, `git diff --check`.

**Design tensions**
1. *Smooth vs. safe*: higher gain tracks better but, with ~8 fps video and 150–500 ms of delay,
   becomes an oscillator. Stability wins over responsiveness in v1.
2. *Vision in Python vs. one-language repo*: good detectors/trackers live in Python; the repo already
   has a Python sidecar pattern (`pi-bridge/`) and a WebSocket client pattern (`djiBridgeDevice.ts`).
3. *Detector quality vs. licensing*: the most convenient YOLO package is AGPL-3.0.
4. *Stale target vs. fresh frame*: the controller runs at 20 Hz but frames arrive at ≤ ~8 Hz.

**Cheapest version that proves the idea.** A sidecar with a **mock** source emitting a scripted target,
the TS control law + manager driving `virtualDjiBridge`, and a closed-loop simulator proving no
oscillation at 150/300/500 ms delay. That is Phase 1 and needs no vision at all; real detection is
layered on afterward.

## Existing code this plan builds on (verified)

| Fact | Where |
|---|---|
| Only in-app video is Sony live-view JPEG, polled by the browser (`delay = 125 ms`), via `GET /api/sony/cameras/:id/live-view/frame`; 3 s frame timeout | `src/sony/sonyManager.ts` (`liveViewFrame`, `FRAME_TIMEOUT_MS`), `src/ui/statusServer.ts` `pollSonyFrame` |
| Frame reads coalesce onto one in-flight upstream request, and return `503` when a camera lane is busy. A second consumer (sidecar) shares the cost; it also sees busy-lane 503s | `SonyManager.readOnce` / `operation` |
| Frames carry **no capture timestamp** | `SonyFrame { contentType, body }` |
| Preview click → normalized (0–1) image coords already computed, letterbox-aware; currently sends Sony touch (AF) | `sonyContainedPoint`, `sendSonyTouch`, `POST /api/sony/cameras/:id/touch` |
| `MotionDevice.setPanTilt(pan, tilt)` takes normalized −1..1 velocity; `stop()`; `capabilities`; `connected`; `gimbalAttached` | `src/devices/motionDevice.ts` |
| Manual control sign convention: `pan = rightX`, `tilt = −rightY` | `controlStateMachine.ts` tick |
| `shouldSendMotion(protocol, changed, lastSentAt, now)` is exported | `controlStateMachine.ts` |
| Machine only sends on stick movement/transitions; early-returns when no input/stale input | `controlStateMachine.ts` tick |
| `emergencyStopAll` stops every device | `src/safety/emergencyStop.ts` |
| Camera slots are `config.cameras`; `resolveProfile` **drops the inventory device key**, so a slot can't currently be mapped back to e.g. `rs3` | `src/config/configLoader.ts` |
| Config style: zod schema + env overrides + `resolveXConfig` (Sony is the template) | `configLoader.ts` |
| WS client w/ reconnect/heartbeat/capabilities handshake exists for the Pi bridge | `src/devices/djiBridgeDevice.ts`, `pi-bridge/dji_bridge.py` |
| Link state published through `AppState` + `/api/status` | `src/app/state.ts` |
| Virtual hardware test doubles | `src/testing/virtualDjiBridge.ts`, `smokeTest.ts` |
| `sonyManagerTest.ts` / `sonyConfigStoreTest.ts` exist but are **not referenced** by `package.json` or `smokeTest.ts` — how they run is **To verify** | `src/testing/` |

## Assumptions to confirm (plan proceeds on these defaults)
1. **Target rig**: a Sony camera (live view through the sidecar) is physically mounted on a DJI RS-series
   gimbal. If the tracked video comes from somewhere else (NDI/RTSP/ATEM), add a video-ingest issue and
   the frame-source interface below absorbs it.
2. The app and the tracker sidecar run on the same Apple-Silicon Mac; the sidecar is loopback-only.
3. v1 tracks **people** only.
4. Default tracking speed cap **0.35** of full gimbal velocity, configurable.
5. Issues stay local (`docs/ai/generated-issues/`); no `gh issue create` until asked.

## Prior art (swarm summary — Haiku-sourced, unverified; treat as leads)
- **Consensus pattern**: detector + multi-frame association (ByteTrack-style) beats single-object OpenCV
  trackers (CSRT/KCF drift and lose identity on occlusion). Velocity control, never bang-bang; low-pass the
  target; PD/PID with deadzone; feed-forward/prediction for smoothness. AutoPTZ (ONNX person detect + PD +
  one-euro smoothing) and TrackingPanTiltCam (YOLOv8 + Kalman) are the closest open-source references.
- **Latency is the dominant failure**: lag beyond the motor's response time produces overshoot and hunting.
  Gimbal literature for ~100 ms delayed feedback uses low-pass filtering plus a damping term.
  Our budget (8 fps polling + sidecar + BLE) is worse, so the plan includes a delay-aware simulator and a
  measured-latency calibration step before any live use.
- **Product behavior to copy**: commercial trackers work as a *secondary* angle for a single subject, offer an
  exclusive single-target lock, return to a safe state on loss, and always keep a manual override.
- **Not adopting**: ClickTrack / SAM2-style promptable trackers (research-grade, heavier, no production
  evidence here). Revisit if person-only ByteTrack proves too brittle.
- **License flag**: `ultralytics` (YOLOv8/11) is AGPL-3.0. The sidecar's detector sits behind an interface and v1
  uses ONNX Runtime with a permissively licensed model (e.g. YOLOX, Apache-2.0); confirm model + tracker
  licenses in issue T7/T8 before adding dependencies.

## Architecture

```
Browser UI ──click(x,y normalized)──▶ /api/tracking/select ─┐
                                                            ▼
Sony sidecar ─JPEG─▶ /api/sony/.../live-view/frame ──▶ tracker-sidecar (Python, Mac, loopback)
   (frames + capturedAt header)                         detect persons → lock on click → ByteTrack
                                                            │  WS/JSON: track{state,cx,cy,w,h,conf,frameTs}
                                                            ▼
                      TrackingClient (src/tracking)  ──▶ TrackingManager (per-gimbal session, 20 Hz)
                                                            │ control law: offset → pan/tilt velocity
                                                            ▼
        shouldSendMotion ──▶ MotionDevice.setPanTilt ──▶ DjiBridgeDevice ─WS─▶ Pi ─BLE─▶ RS3
   arbitration: ControlStateMachine (stick/e-stop) can suspend/cancel any session
```

**Component ownership**
- `tracker-sidecar/` (new, Python): frame pull, detection, click-to-lock, association, target messages.
  Knows nothing about gimbals.
- `src/tracking/trackingController.ts` (new, pure): control law. No I/O; fully simulatable.
- `src/tracking/trackingManager.ts` (new): sessions, 20 Hz tick, arbitration, all safety stops.
- `src/tracking/trackingClient.ts` (new): WS client to the sidecar, reconnect/backoff/heartbeat.
- `statusServer.ts`: routes + overlay UI only; owns no tracking state.

### Sidecar ↔ app contract (v1 — freeze before parallel work)
App → sidecar: `hello`, `select {sourceId, x, y}` (normalized coords in frame space), `cancel {sourceId}`,
`ping`.
Sidecar → app: `hello {version, capabilities:["person"], detector}`, `track {sourceId, state, cx, cy, w, h,
conf, frameTs, processedAt}` where `state ∈ locking | tracking | lost | idle`, all geometry normalized
0–1 in **frame space**, `frameTs` = capture time in epoch ms, `pong`, `error {code, message}`.
Frame source per `sourceId` is `http://127.0.0.1:<STATUS_PORT>/api/sony/cameras/<id>/live-view/frame` (configured
in the app; the app pushes the URL in `hello`/`configure`, so the sidecar holds no Sony knowledge).

### Control law (v1 spec)
Inputs: target center error `e = (cx−0.5, cy−0.5)` (+ `w,h` for future framing), `age = now − frameTs`,
`conf`. Outputs `pan, tilt ∈ [−maxSpeed, +maxSpeed]`.
- Deadzone (default ±0.04) and hysteresis so a still subject produces zero motion.
- One-euro / EMA low-pass on `e`; PD with a damping term from filtered `de/dt`.
- **Latency-aware gain**: effective `Kp` scaled down as `age` (+ configured pipeline delay) grows.
- **Stale decay**: velocity scaled to 0 linearly as `age` goes 400→700 ms; `> 700 ms` ⇒ stop.
- Sign mapping: image right ⇒ `pan +`, image up ⇒ `tilt +` (matches the manual convention), with per-source
  `invertPan` / `invertTilt` because mount orientation varies.
- Lost policy: `lost` ⇒ immediate `stop()`, hold `holdMs` (default 3 s) for reacquire, then `idle`
  and UI shows "Target lost". Never "search" by moving in v1.

### Arbitration and safety (ordered, all tested)
1. Operator stick on the **controlled and tracked** camera ⇒ suspend that session (`operator_override`).
   Resume only by an explicit operator action, never automatically.
2. `emergencyStopAll` ⇒ cancel every session + `stop()` (back button path is unchanged).
3. No fresh `track` for 500 ms, or sidecar WS down ⇒ `stop()`, state `stale`.
4. Device `connected`/`gimbalAttached` false ⇒ `stop()`, session ends.
5. App shutdown (SIGINT/SIGTERM in `index.ts`) ⇒ `stop()` all sessions before exit.
6. Bridge's 250 ms watchdog is the last line, not the first.
7. Output hard-capped by `maxSpeed`; first live run at the default cap with the operator watching video.

### Config (`config/devices.yaml`, new optional block — disabled by default)
```yaml
tracking:
  enabled: false
  sidecarUrl: ws://127.0.0.1:7900
  maxSpeed: 0.35
  deadzone: 0.04
  lostHoldMs: 3000
  sources:
    - sonyCameraId: "<sony id>"     # from /api/sony/cameras
      device: rs3                   # inventory key (NOT slot id)
      invertPan: false
      invertTilt: false
```
Env overrides follow the Sony pattern: `TRACKING_ENABLED`, `TRACKING_SIDECAR_URL`. Because
`resolveProfile` discards the inventory key, **T1 adds `deviceKey` to the resolved `CameraConfig`** so the
manager can find the active slot (or none) for `device: rs3`.
`config/devices.yaml` currently has uncommitted local edits — the implementer must not sweep them into
a tracking commit.

## Issue table

Sizes: S ≤ ½ day, M ≈ 1 day, L ≈ 2 days. Track A = TypeScript control, B = Python vision, C = plumbing.

| Order | ID | Title | Goal | Likely files | Tests / evaluation | Dependencies |
|---|---|---|---|---|---|---|
| 1 | T1 | Tracking config block + device-key resolution | Optional zod `tracking` block, env overrides, `CameraConfig.deviceKey`, source→slot resolver | `src/config/configLoader.ts`, `config/devices.yaml` (comments only), `docs/ai/decisions/…` | Smoke: schema valid/invalid, env precedence, profile switch resolves/unresolves source; `pnpm build` | — (S) |
| 2 | T2 | Sony frame capture timestamp | `capturedAt` on `SonyFrame`, exposed as `X-Frame-Captured-At` on the frame route; no browser behavior change | `src/sony/sonyManager.ts`, `src/ui/statusServer.ts`, `src/testing/sonyManagerTest.ts` | Header present + monotonic; two concurrent consumers share one upstream read; 503 path unchanged | — (S) |
| 3 | T3 | `TrackingController` control law + closed-loop simulator | Pure control law per spec; `trackingSim.ts` models delay, 8 fps frames, 20 Hz BLE cap, velocity→angle | `src/tracking/trackingController.ts`, `src/testing/trackingSim.ts`, `src/testing/smokeTest.ts` | Sim: settles with no sustained oscillation at 150/300/500 ms delay; deadzone = zero output; stale decay; sign mapping; caps | T1 types (M) |
| 4 | T4 | `TrackingManager`: sessions, 20 Hz tick, arbitration, safety stops | Drive `device.setPanTilt` through `shouldSendMotion`; all stop paths; status state | `src/tracking/trackingManager.ts`, `src/model/controlStateMachine.ts`, `src/safety/emergencyStop.ts`, `src/index.ts`, `src/app/state.ts` | Smoke w/ `virtualDjiBridge`: override, e-stop, stale, device drop, shutdown each produce `stop`; no motion sent when suspended; rate cap respected | T1, T3 (L) |
| 5 | T5 | `TrackingClient` + sidecar protocol + virtual sidecar | WS client (reconnect/heartbeat) and a scripted fake sidecar for tests | `src/tracking/trackingClient.ts`, `src/testing/virtualTrackingSidecar.ts`, protocol doc in plan | Smoke: handshake, reconnect, malformed-message rejection, `track` → manager wiring | T1 (M) |
| 6 | T6 | Tracking API routes + AppState status | `GET /api/tracking/status`, `POST /api/tracking/select`, `POST /api/tracking/cancel`; validated coords; status in `state` | `src/ui/statusServer.ts`, `src/app/state.ts`, `src/testing/smokeTest.ts` | Smoke: coord validation (mirrors touch route), unknown source 404, disabled ⇒ 409, status shape | T4, T5 (M) |
| 7 | T7 | Tracker sidecar skeleton (Python) | `tracker-sidecar/`: WS server, hello/capabilities, mock source driver, config, README, tests dir | `tracker-sidecar/**`, `docs/ai/testing-guide.md` | `python3 -m unittest discover -s tracker-sidecar/tests`; contract round-trip with T5 fake/real client | T5 contract (M) |
| 8 | T8 | Sidecar frame ingest + person detection | Pull frames from app endpoint, decode, ONNX person detection, latency/fps metrics, `frameTs` propagation | `tracker-sidecar/frames.py`, `detector.py`, `requirements.txt` | Unit: synthetic-image detector stub; backoff on 503/timeouts; measured detect ms on the target Mac recorded in the PR; license check | T2, T7 (L) |
| 9 | T9 | Sidecar click-to-lock, association, lost/reacquire | Select detection containing click; ByteTrack-style association; `locking/tracking/lost`; short appearance-based reacquire | `tracker-sidecar/tracker.py`, `tests/` | Synthetic multi-person scenes: lock correct person, survive brief occlusion, don't swap to neighbor, `lost` after timeout | T8 (L) |
| 10 | T10 | Operator UI: Track mode, overlay, cancel | Toggle Focus-touch vs Track on the Sony preview; click ⇒ select; status/box overlay; Stop Tracking; visible override/lost states | `src/ui/statusServer.ts`, `scripts/check-page-js.cjs` | `node scripts/check-page-js.cjs`; browser fixture for each state (locking/tracking/holding/lost/stale/disabled); AF touch still works in Focus mode; a11y live region | T6 (M) |
| 11 | T11 | Controller binding: cancel/toggle tracking | Stick already overrides (T4); add an unused button chord to toggle tracking on the controlled camera | `config/mappings.yaml`, `controller-profiles/*.yaml`, `controlStateMachine.ts`, `configLoader.ts` `MappingSchema` | Smoke: toggle, no conflict with existing chords (LB+A/B/X/Y, LB+RB); profile coverage | T4 (S) |
| 12 | T12 | Latency calibration + gain tuning tool | Measure end-to-end command→visible-motion delay (frame differencing) and recommend `pipelineDelayMs`/gains | `scripts/tracking-calibrate.*`, `src/tracking/`, docs | Dry-run against mock; results table committed to the run note; human-run on the real rig | T4, T9 (M) |
| 13 | T13 | Live verification runbook + docs + state update | `docs/tracking.md`, manual-smoke checklist, e-stop / BLE-drop / sidecar-kill drills, testing-guide + repo-map + architecture updates | `docs/**`, `docs/ai/*` | Human gate: first run at cap 0.35 with operator on video; drills pass; results recorded in `docs/ai/runs/` | all (S) |

### Dependency graph / parallelism
```
T1 ─┬─ T3 ─┐
    ├─ T5 ─┼─ T4 ─ T6 ─ T10
T2 ─┘      │          └ T11
T7 ─ T8 ─ T9 ─ T12 ─ T13
```
- Independent tracks that can run in parallel with disjoint write ownership: **A** (T1→T3→T4),
  **B** (T7→T8→T9, needs only the frozen contract + T2), **C** (T2, T5).
- **Shared hot files — serialize**: `statusServer.ts` (T2, T6, T10), `controlStateMachine.ts` (T4, T11),
  `smokeTest.ts` (T3–T6, T11), `configLoader.ts` (T1, T11).
- Branch strategy: currently on `main` with unrelated uncommitted edits ⇒ per-issue branches off `main`
  in **isolated worktrees**, removed when each PR opens (AGENTS.md worktree hygiene).

## Validation plan
- Per issue: `pnpm build`; `STATUS_PORT=<free> pnpm test:smoke`; Python tests where touched;
  `node scripts/check-page-js.cjs` for UI; `git diff --check`.
- Stability evidence before any live use: T3 simulator results at 150/300/500 ms delay in the PR.
- Live gates (human, gimbal powered, watching video): small-deflection check of gimbal gain first; tracking
  at `maxSpeed 0.35`; stick override; e-stop; kill sidecar mid-track; drop BLE (walk gimbal out of range);
  Sony preview stale; 30-minute soak with tracking idle and with tracking active.

## Risks
1. **Latency/oscillation** — mitigated by simulator-first design, latency-aware gain, calibration tool (T12).
2. **Gimbal gain unverified live** (200 vs 80) — the speed mapping `velocity → joystick` may be hotter than assumed;
   cap + human-gated first run.
3. **Shared frame lane** — sidecar polling adds load on the Sony sidecar and can make the browser's frame
   reads see 503 busy; T2/T8 must bound sidecar polling (≤ 1 in-flight, backoff on 503).
4. **Wrong-person lock / lost subject** in multi-person scenes — exclusive lock + reacquire limits; document
   that this is a single-subject secondary-angle feature.
5. **Licensing** of detector/tracker dependencies — checked in T8/T9.
6. **Privacy** — no frame/crop persistence; synthetic fixtures only.
7. **Slot ↔ device mapping** changes with profile switches — T1 resolver must tolerate a source whose gimbal is
   not in the active profile (session unavailable, not error).

## Out-of-scope follow-ups (not issues yet)
VISCA-camera video ingest (RTSP/NDI) and BirdDog tracking · zoom/auto-framing · generic-object tracker ·
face/appearance re-ID · Sony AF assist on lock · multi-subject / subject switching · UI editor for `tracking`
block · launchd/systemd unit for the sidecar.

## Completion checklist
- [x] Plan written to `docs/ai/current-plan.md`
- [x] Issues atomic, with likely files
- [x] Dependencies clear
- [x] Tests/evaluation specified
- [x] Data-safety risks documented
- [ ] Issues generated (`issue-writer`)
- [ ] User confirms assumptions 1–5
