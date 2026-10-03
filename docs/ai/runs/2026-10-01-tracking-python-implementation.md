---
date: 2026-10-01
repo: fps-camcontrol
branch: codex/electron-tracking
pr: null
issues: [29, 30, 31, 34]
status: unverified
tags: [run, fps-camcontrol]
index: "[[fps-camcontrol]]"
---

# Python tracking implementation checkpoint

Scope: issues #29–31 and the private grayscale decoder used by #34. Source/test
freeze is based on foundation `133ae8d9620665b1e87b799a765a619ccae06ebc` plus the
uncommitted tracking integration. This is focused evidence, not full release,
physical-camera, notarization, or installed-app approval. The root orchestrator
owns the serial full gate, final PR body/license record, and packaged verification.

## Files changed

- `tracker-sidecar/`: authenticated loopback protocol/server, mock trajectories,
  bounded private frame ingestion, real pinned YOLOX/ONNX inference, exclusive
  appearance-checked target association, parent-death watchdog, developer-only
  model-fetch utility, exact requirements lock and third-party notices.
- `tracker-sidecar/calibration_frame.py`: bounded memory-only JPEG stdin to
  160×90 grayscale JSON stdout for actual pixel-difference calibration; no files.
- `tracker-sidecar/tests/`: executable acceptance and safety regressions using
  generated synthetic frames only. No real camera frames or model weights committed.
- `docs/ai/contracts/issue-{29,30,31}.json`: original criteria and executable
  test mappings. Per-test status is not a claim of physical tracking accuracy.

## Checks run

Initial RED: `python3 -m unittest discover -s tracker-sidecar/tests -v` produced
22 missing-implementation assertion failures before implementation.

Final Python source/test checkpoint:

```sh
TRACKER_TEST_MODEL="$PWD/dist/tracking-runtime/models/object_detection_yolox_2022nov.onnx" \
  dist/tracking-runtime/python/bin/python3 -I -B -m unittest discover -s tracker-sidecar/tests -v
```

Result: **38 tests, 9.966 seconds, OK, zero skips**, exit 0. This used the supplied
isolated Python 3.12.14 ARM64 runtime, actual NumPy/Pillow/ONNX Runtime, and pinned
model `c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063`.

Independent `pnpm exec ts-node src/testing/trackingIntegrationTest.ts` exited 0:
`PASS issue-29-c5: real TS to Python to virtual bridge (authenticated mock, commands, override/resume, crash stop/no replay)`.
Its bridge/backend sockets and Python child were disposable fixtures, not live hardware.

Actual model execution produced finite `[1,8400,85]` output for two distinct
synthetic inputs; outputs differed. CoreMLExecutionProvider was selected.
Measured inference-only durations were 16.136/21.736 ms (~52.81 inference/s).
Both images yielded zero people: this proves execution, not detector accuracy.

The 12-frame actual HTTP/JPEG→ONNX synthetic pipeline probe was run separately:

```sh
dist/tracking-runtime/python/bin/python3 -I -B tracker-sidecar/tests/model_pipeline_probe.py \
  "$PWD/dist/tracking-runtime/models/object_detection_yolox_2022nov.onnx"
```

Exit 0: 12 requests, 12 frames, 12 inferences; 5.709 frames/s; detect p50 33.961 ms,
p95 39.586 ms; frame age p50 38 ms, p95/max 45 ms; degradedTiming false;
CoreMLExecutionProvider; all person counts zero. This measures the target Mac's
synthetic transport/inference path, not Sony exposure latency, motion latency,
or real-person accuracy. It does not justify reducing the conservative
`pipelineDelayMs` setting; actual device calibration remains required.

## Decisions and deviations

- Preserved frozen v1 JSON wire. Process-only bounded `--reacquire-ms` and
  `--lost-hold-ms` default to 1000/3000 and receive validated backend config.
- Parent stdin heartbeat/EOF supervision remains active through asyncio executor
  shutdown, including a blocked native worker; force-exit affects only this helper.
- Mock mode has no vision-library imports. Credentials are required even for the
  historical naked mock example, following the current security contract.
- RGB top-left letterbox, 0–255 float32 CHW, stride decode, person class 0 and NMS
  match the pinned Zoo model; no normalized-input mismatch or AGPL substitution.
- Runtime/model acquisition is explicit build/developer work only. No host package
  installation, runtime downloads, private image persistence, or hardware actions.
- Shared TS/config/package/Electron files remain other owners' responsibility.

## Review regressions repaired

- Concurrent authenticated upgrades could both pass the pre-handshake check.
  Barrier-based RED exposed two owners; atomic pre-await handler acquisition now
  rejects the duplicate before any configure/select can affect the owner.
- A canceled frame queued for the inference lock had no native owner to close it.
  RED proved the image remained readable; pre-acquire cancellation now closes it
  without releasing another inference's lock. Final suite includes this regression.
- Parent watchdog originally closed before asyncio joined blocked executor work.
  Real subprocess EOF test reproduced a hung exit; watchdog now survives the runner.
- Deprecated Pillow pixel access wrote a warning to the private decoder's stderr.
  Supported `get_flattened_data` and actual subprocess quiet-output tests resolve it.
- Root review found timing settings initially hardcoded. Configurable bounded CLI
  values now reach LiveSource/TargetTracker and exact loss/expiry tests cover them.

## Remaining verification

Root serial full gate and final packaged tracking artifact tests are not represented
by this focused checkpoint. Physical Sony/gimbal latency calibration, real-person
identity reliability, and the 30-minute tracking soak require the explicitly
separate human hardware gate. No claim of universal identity preservation is made
for color histograms; ambiguous matches intentionally lose the target.
