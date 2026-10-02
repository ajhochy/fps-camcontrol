# Click-to-track — experimental operator-controlled camera assistance

Use this for one consenting subject on a secondary angle, with an operator
watching the live picture and ready to stop. It is not an unattended camera,
collision avoidance, primary safety system, or a substitute for a camera operator.
Physical calibration and safety drills are still MANUAL_PENDING; see the
[live verification record](ai/runs/2026-10-01-tracking-live-verification.md).

## Prerequisites

- Apple Silicon Mac, macOS 14 or newer for **FPS CamControl Tracking**. The
  separate manual-only installer supports macOS 13 and contains no tracker.
- The tracking app includes Python, native inference dependencies and the
  checksum-verified Apache-2.0 OpenCV Zoo YOLOX-s ONNX model. No Python, pip,
  Node, package manager or developer tools are required to launch the installer.
- Your own legally obtained Sony CameraWebApp/SDK and paired camera for live
  preview. Follow [Sony setup](sony-sidecar-setup.md). Neither Sony software nor
  acceptance of Sony terms is included in either installer.
- A configured DJI bridge/gimbal (good BLE range) or a VISCA head (e.g. V-BOT) and a matching
  active rig slot. The DJI bridge keeps its 250 ms dead-man; a VISCA head has none, so the app
  supplies one (see **VISCA heads** below).

The apps have separate identities and settings directories (`FPS CamControl`
and `FPS CamControl Tracking` under Application Support). Their shared hardware
ownership lease prevents simultaneous production backends. Quit one before
opening the other. There is no auto-updater or published release in this delivery.

## Configuration and source mapping

Tracking defaults to disabled and creates no helper, socket or tracking timer.
Quit the app before editing its **own** `config/devices.yaml` in userData, or
import an explicitly validated configuration using setup. Relaunch after changing
tracking settings. Never copy personal credentials or Sony approvals into an
installer. Back up your own configuration first.

```yaml
# Add alongside the existing devices/profiles/ATEM configuration.
tracking:
  enabled: false                 # enable only after setup and safe gain check
  autoSources: true              # default: every gimbal rig with a Sony camera becomes a source
  sidecarUrl: ws://127.0.0.1:7900 # developer mode only (TRACKER_WS_TOKEN set); the app-owned helper is private
  maxSpeed: 0.35                 # start lower until physical gain is verified
  viscaMaxSpeed: 0.3             # extra cap for VISCA heads; the effective cap is min(maxSpeed, viscaMaxSpeed)
  deadzone: 0.04
  lostHoldMs: 3000
  reacquireMs: 1000
  pipelineDelayMs: 300           # simulator assumption, NOT a measured real rig
  kp: 1.2
  kd: 0.12
  sources:                       # optional: only to override a derived source (e.g. invert) or pin one
    - sonyCameraId: AA:BB        # replace with your Sony camera's exact ID
      device: gimbal_one        # existing protocol: dji-bridge inventory key
      invertPan: false
      invertTilt: false
```

**Automatic sources.** With `autoSources` (default `true`) you do not need to list
sources. Every rig in the active profile (or unsaved working copy) whose controller
is a DJI gimbal (`protocol: dji-bridge`) or a VISCA head (`protocol: visca`, e.g. V-BOT or
BirdDog) and that has a Sony camera bound (the slot's `camera:` with a `sonyCameraId`) becomes
a source, with `sourceId` = the controller's inventory key. A rig without a Sony camera is not
a source. An explicit `sources`
entry for the same device overrides the derived one (use it for `invertPan` /
`invertTilt`); a Sony camera already claimed by an explicit entry is never derived onto a
second gimbal. Set `autoSources: false` to use only the explicit list. Derived sources
follow profile and rig edits, with the same stop-and-clear on any change. The minimal
setup is just `tracking: { enabled: true, maxSpeed: 0.45 }`.

`device` is the stable inventory key, not a mutable cam1/cam2 slot number. It
must resolve to a DJI or VISCA device in the current profile. A missing active slot is
shown unavailable. Source rebinding/profile changes stop and clear every target;
they never transfer the old target to another physical rig. Duplicate gimbal
bindings and invalid Sony IDs are rejected. Limits: eight sources, maxSpeed and
viscaMaxSpeed 0.05–1, deadzone 0–0.3, lostHoldMs 0–30000, reacquireMs 100–5000,
pipelineDelayMs 0–2000, kp 0–5 and kd 0–2. Raising maxSpeed is not advised until
the human gain/calibration gate has passed.

## VISCA heads (V-BOT, BirdDog)

A VISCA head keeps moving at its last commanded speed until it is told to stop; unlike the DJI
bridge it has no dead-man of its own. Tracking therefore drives a VISCA head through a driver
(`src/tracking/viscaTrackingDriver.ts`) that adds the protection in the app:

- **Dead-man.** While the head is being driven, a timer owned by that source (independent of the
  tracking loop) sends an explicit pan/tilt stop when no fresh velocity has been issued for more
  than 300 ms: stalled loop, stale or lost observation, helper silent. It is checked every 50 ms.
- **Explicit stop on every end path.** Cancel, target lost, stale video, operator override,
  emergency stop, profile/source/rig change, device reconnect, helper disconnect or exit, the head
  ceasing to answer, and app shutdown (SIGINT/SIGTERM and normal stop) all send a VISCA stop. A
  stop is never rate-limited and is repeated once ~120 ms later in case the datagram is lost
  (skipped if an operator has started moving the head meanwhile; zoom is never stopped by it).
- **Speed mapping.** Tracking's normalized velocity is capped at `min(maxSpeed, viscaMaxSpeed)`
  (default 0.3 = pan step 7 of 24, tilt step 6 of 20), then mapped by the same VISCA code manual
  control uses (pan 1–24, tilt 1–20). Any axis under 0.05 becomes a stop for that axis, and a
  command with both axes under it becomes an explicit stop, never a speed-1 creep.
- **Rate.** A command is sent only when its discrete speed/direction changes (at most every
  100 ms) and re-sent every 200 ms while held. VISCA does not need the refresh; the resend only
  recovers a lost UDP datagram quickly, at the same order of rate as the manual heartbeat.
- **Readiness.** The head must be answering VISCA inquiries (the same signal as the Status page's
  *Answering*). Otherwise the source shows **unavailable** with the reason (for example "VISCA
  head is not answering"), selecting is refused, and an active session ends with a stop.
  "Replies Not Heard" (port 52381 held by another app) also counts as not answering.
- **Operator override** works as for gimbals: the stick (desk gamepad or the iPad touch arrows,
  which arrive as the same input frames) on the same camera stops the head and leaves tracking
  **Paused — stick moved**; **Resume** is required.
- Direction follows the VISCA convention (pan right and tilt up are positive). If the head or
  image is mirrored/inverted, set `invertPan`/`invertTilt` in an explicit `sources` entry.
- Calibration remains DJI-only.

## Operation

1. Confirm preview and gimbal connection. Each preview starts in **Focus (touch)**;
   ordinary touch autofocus is unchanged. Mode choices reset on reload.
2. Select **Track**, then click the intended person's torso in the image.
   Letterbox margins are not selection targets. The initial state is Locking.
3. Watch the box and text state. Stop tracking is always available during a
   session; Escape cancels when that preview has keyboard focus.
4. Moving the right stick for the same camera stops tracking first and leaves it
   **Paused — stick moved**. Release alone does not resume. Use **Resume**, or
   press the otherwise unused RS button explicitly, with a fresh healthy target.
   RS while active cancels; RS without a session does nothing. Existing Back
   emergency stop, LB chords, camera selection and speed curves remain intact.
5. Control of another camera does not cancel this camera's tracking. Keep an
   operator watching all active motion. Recenter and preset recall on this camera
   take manual ownership before motion.

Emergency stop, gimbal/bridge loss, helper disconnect, rebinding, shutdown and
sleep recovery invalidate selection; reconnection never replays it. Video older
than 500 ms stops motion. A short same-session video recovery may continue only
with a genuinely fresh observation; manual override always requires Resume.
Target loss stops immediately and holds briefly for conservative reacquisition,
then clears the target. Ambiguous crossing prefers loss over switching identity.

## Calibration

`pnpm tracking:calibrate --dry-run --trials 5` exercises virtual motion and
synthetic in-memory image differencing. This is not physical calibration.
Real calibration requires explicit `--yes-move`, an available source, connected
tracking/gimbal and no active motion/session. The backend owns the capped step
(0.1, 800 ms) through its normal device and shared motion budget; the CLI never
opens another hardware connection. It stops in finally/on interruption, and a
backend timer stops independently if the CLI disappears. No configuration is
written automatically. Use `pnpm tracking:calibrate --help` for the exact
backend/source/Python arguments and the private session environment variable.
Never put session credentials in command arguments or reports.

Reports include raw trial timing, median/spread, pixels/second/unit velocity and
a recommended snippet. Angular rates require independently calibrated field of
view/geometry; pixel displacement alone is not degrees. High variance is labeled
unreliable rig. Physical results are deliberately blank in the run record.

## Developer sidecar setup/launch

The app launches and owns its helper (private random tokens, parent watchdog on, loopback
backend origin `http://127.0.0.1:<port>`) whenever `tracking.enabled` is true, packaged or not;
no manual sidecar command is needed. Non-packaged runs use `dist/tracking-runtime` (staged by
`scripts/stage-tracking-runtime.cjs`) and `tracker-sidecar/main.py` from the repository. If the
runtime is missing, tracking shows unavailable with the reason (`/api/tracking/status` ->
`sidecar.state: "unavailable"`, `sidecar.reason`) and the app starts normally. If the helper dies
it shows **Sidecar offline** and is restarted with a backoff (1, 2, 5, 10, then 30 s); any active
target is cleared and never replayed. The explicit developer path below is used only when
`TRACKER_WS_TOKEN` is set in the environment (the app then connects to `sidecarUrl` and does not
launch anything). For isolated development,
stage pinned dependencies with `node scripts/stage-tracking-runtime.cjs --download`
after reviewing the manifest. Subsequent builds use the verified cache offline.
Run the bundled `dist/tracking-runtime/python/bin/python3 -I -B
tracker-sidecar/main.py --help` for live/mock options. Developer launches require
`TRACKER_WS_TOKEN`, `TRACKER_FRAME_TOKEN` (independent random values of at least
32 characters) and `TRACKER_BACKEND_ORIGIN` (exact loopback backend origin).
Pass the same WS token to the Node client and frame token to the backend; never
commit or print them. `--no-parent-watchdog` is for an explicitly supervised
developer terminal only; shipping code never disables its watchdog. Mock mode
uses synthetic trajectories and does not import the vision model.

`TRACKING_ENABLED` and `TRACKING_SIDECAR_URL` override developer configuration;
the packaged app always launches its own loopback helper and private credentials, and ignores `TRACKER_WS_TOKEN`.
Remote tracking is disabled unless a developer explicitly opts in, and is never
allowed by the packaged app. This is not remote-control support.

## Limits and data safety

- The timestamp is the backend's completed JPEG **receipt**, not sensor exposure.
  Sony encoding/network latency is not measured by this header. Real rig latency
  and gain must be calibrated before live use.
- Real inference on synthetic inputs and simulated delays are tested. Detection
  accuracy on people, physical direction/gain/BLE behavior and clean-OS/TCC are
  not established by those tests. Single-person identity can still be lost.
- CPU fallback is allowed if acceleration is unavailable; degraded timing must
  not bypass stale-video stops. Multi-source throughput has no physical benchmark.
- Frames and appearance features remain in memory, are discarded on cancel, and
  are not saved to logs or evidence. Tests use synthetic images only.
- The packaged backend is private loopback with operator-session authentication;
  the helper gets only a frame-scoped credential, not operator API access.
  Developer CLI loopback endpoints are not hardened for LAN exposure. Do not
  proxy them onto a LAN or the internet; remote security remains out of scope.
- No multi-target tracking, automatic zoom, face recognition, unattended live
  operation, remote gamepad, or automatic updates are included.

See [testing guide](ai/testing-guide.md) for exact automated commands and the
separate physical and clean-machine acceptance boundaries.
