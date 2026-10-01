---
type: run
status: unverified
---

# Tracking calibration (#34)

- Scope: scripts/tracking-calibrate.ts, src/tracking/calibration.ts, src/ui/trackingCalibrationRoutes.ts, manager/ledger reservation safety and focused contract/tests. Root registers the route behind the existing session/origin boundary; Python owner supplies bounded memory-only JPEG decoding.
- Acceptance:6 criteria,5 executable integration tests and1 explicit MANUAL_PENDING human physical rig result. Exact criterion text preserved in issue-34.json. RED command `node --test -r ts-node/register/transpile-only tests/tracking/calibration.spec.cjs` exits1 with5 expected absent-implementation assertions before source exists.
- Safety design: explicit consent, connected tracking/device checks, normal MotionDevice path with shared pacing, <=.15 speed, independently scheduled <=1s stop, abort/SIGINT/finally stop; no implicit production config read or YAML writes. Genuine pixel frame registration, not JPEG-byte comparison. Report processed pixels/s absent calibrated horizontal field of view.
- Architecture: the CLI owns no hardware socket. The backend owns the normal MotionDevice/shared-ledger pulse (fixed0.1 pan for800ms), reservation and independent stop deadline. Reject any active tracking session or any manual ledger motion; select/new calibration cannot compete. Manual override, cancel, emergency, disconnect, rebind and shutdown cancel the pulse without replay. Every pump checks sidecar/gimbal health. Stop exceptions clear timers/reservation but preserve a nonzero ledger fail-closed until a successful physical stop call.
- Real CLI reads only configured source IDs and the existing Sony live-view JPEG route on the explicit127.0.0.1 backend. Optional embedded session credential comes from FPS_CALIBRATION_SESSION only; neither argument nor output. JPEG2MiB cap, decoded8Mpixel cap in the Python helper, fixed160x90 grayscale return,2s subprocess/request bounds, in-memory data only. Ctrl-C/errors/video loss send same-operation stop; if the CLI dies, backend800ms deadline remains. Receipt timestamps are HTTP-receipt times, not sensor exposure times.
- Commands: `node -r ts-node/register scripts/tracking-calibrate.ts --help`; `node -r ts-node/register scripts/tracking-calibrate.ts --dry-run --trials 3`; real mode requires `--yes-move --backend-url http://127.0.0.1:PORT --source DEVICE`, optional `--horizontal-fov-degrees FOV` only when calibrated. This is a developer tool, not an app bundle command. No real mode was run against hardware.
- Checks: `node --test -r ts-node/register/transpile-only tests/tracking/calibration.spec.cjs tests/tracking/controller.spec.cjs tests/tracking/manager.spec.cjs tests/tracking/protocol.spec.cjs` exits0,37/37 (9 calibration); typed CLI help/dry-run exit0; `pnpm build` and `git diff --check` exit0. Compiled `node dist/testing/trackingIntegrationTest.js` exits0 with actual authenticated TS/Python/virtual-bridge override/resume/crash-stop proof. Root independently owns full PR gate and final packaged runtime.
- Quantization correction: inspecting dry-run numbers exposed biased20px/s for a known8px/s motion because an initial rate estimator dropped unchanged frames. Added a RED exact8px/s fixture and changed the estimator to least-squares displacement across all post-onset plateaus; GREEN rate now approximates the virtual model. This is genuine pixel registration, not JPEG-byte differences.
- Additional behavioral proof: actual CLI subprocess performs HTTP JPEG capture decoded by bundled Python/Pillow and moves an actual VirtualDjiBridge through normal DjiBridgeDevice. Actual SIGINT causes immediate owned-operation stop; HTTP503 video loss stops before800ms; stale/wrong operation IDs cannot stop new motion; sidecar loss, manual takeover, Cancel, stop exception and independent deadline are tested. No camera images or config were written.
- Full-gate test triage: root session18287 caught the video-loss assertion measuring CLI process exit rather than the actual backend stop. Exact focused rerun passed, indicating timing sensitivity. Fresh recon now timestamps the real normal-device.stop invocation and observes the same-operation HTTP stop request; the original <600ms threshold is retained, separate from child process teardown. Latest serial37-test command exits0 with videoLossToDeviceStopMs2 and videoLossToCliExitMs54. Backend800ms deadline and speed caps were unchanged. Source/tests frozen again for root full-gate rerun.

## Synthetic results only — not physical calibration

2026-10-01 final typed CLI three-trial run on branch codex/electron-tracking atop133ae8d, fixed0.1 velocity and800ms pulses,160px-wide synthetic image,18 virtual commands:

| Trial | Delay ms | Pixels/s | Pixels/s per velocity unit |
| --- | ---: | ---: | ---: |
|1|254|7.7321|77.3211|
|2|203|7.4543|74.5428|
|3|156|7.8838|78.8382|
|Median|203|7.7321|77.3211|

Spread98ms and0.42954pixels/s; reported consistent synthetic trials. Suggested starting config pipelineDelayMs203,kp1.2,kd0.12,maxSpeed0.15. Delay includes sampling and transport; integer-pixel resolution limits precision. Rates are pixels/s unless an explicitly calibrated field of view is supplied; no angular accuracy is invented. Recommendations remain starting defaults, not real-rig gain validation.

## Remaining acceptance

Issue34-c6 is MANUAL_PENDING: no authorized/available physical rig, therefore no human-run physical results table. Human must supervise the same explicit-consent CLI and record actual delay/rate/recommended gains before closing34. No whole-issue completion or physical safety certification is claimed.
