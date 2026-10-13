# Tracking implementation handoff — 2026-10-01

Read-only preparatory work. Implementation is gated on the independently verified and committed foundation. No tracker source changes, package installations, hardware, or live services were touched by this handoff.

## Decisions ready for implementation

This handoff is preparatory, not evidence that tracking is implemented. The acceptance snapshot below supersedes historic issue summaries. Read-only source inspection confirmed no tracker modules yet. Root must first freeze and commit the verified manual foundation, retain its immutable installer, then switch the assigned worktree to the stacked tracking branch. The user's explicit no-cleanup request overrides AGENTS worktree deletion.

- Keep packaged HTTP private loopback with foundation authentication; #28's old LAN-open prose is superseded by the user's packaging boundary.
- #25's controller stale decay is 400–700 ms. #26's manager safety boundary is stricter: no genuinely fresh observation for 500 ms produces an uncapped stop. Prediction retains the last real observation timestamp and cannot refresh liveness.
- Stale video alone may recover on fresh valid observations (#26). Operator override requires explicit Resume; sidecar restart/disconnect, device loss, profile/binding change, emergency stop, sleep, and shutdown invalidate the target and require a fresh Select. No crash/reconnect replay.
- Stop precedes manual pan/tilt, preset, recenter, device replacement, or detach. Manual camera selection by itself does not cancel another camera's tracking.
- Use the already exposed and currently unused logical RS button for cancel/resume. It is present in xbox.yaml, xbox-bluetooth.yaml, switch-pro-bluetooth.yaml, wii-u-pro.yaml, and generic.yaml. Add a defaulted mapping key; do not modify existing chords or profiles.
- #34 and #35 retain explicit human gates: real rig gain/calibration, physical override/stop/BLE/sidecar/video-loss drills, 30-minute idle and active-tracking soaks. Simulator, fresh HOME, and packaged inference cannot be labeled as those passes.
- Sony SDK remains separately user-supplied; a bundled detector does not make Sony camera transport legal to redistribute.
- Pixel displacement is not angular velocity without calibrated field of view. Calibration reports pixels/s unless an explicit calibrated angular scale is supplied.

## Frozen v1 transport contract

Use identical strict discriminated unions in TypeScript/Zod and Python. Every envelope has protocol:1 and type; reject extra/unknown keys, unknown types, invalid states, nonfinite numbers, or invalid bounds. Maximum text payload is 65536 bytes; reject binary messages. No frame bytes on WebSocket.

Types: sourceId is a nonempty 1–128 character stable inventory device key (derive from sources[].device; reject duplicate device or Sony source mappings). sessionId is a UUID created for each explicit Select. seq is a nonnegative safe integer, strictly increasing within that source/session. nonce is a bounded string. Epoch timestamps are finite nonnegative integer milliseconds.

App to helper:

~~~typescript
type ToTracker =
  | { protocol: 1; type: 'hello' }
  | { protocol: 1; type: 'configure';
      sources: Array<{ sourceId: string; frameUrl: string }> }
  | { protocol: 1; type: 'select'; sourceId: string;
      sessionId: string; x: number; y: number }
  | { protocol: 1; type: 'cancel'; sourceId: string; sessionId: string }
  | { protocol: 1; type: 'ping'; nonce: string };
~~~

Helper to app:

~~~typescript
type FromTracker =
  | { protocol: 1; type: 'hello'; version: string;
      capabilities: ['person']; detector: string; provider: string;
      degradedTiming: boolean }
  | { protocol: 1; type: 'track'; sourceId: string; sessionId: string;
      seq: number; state: 'locking' | 'tracking' | 'lost' | 'idle';
      cx: number; cy: number; w: number; h: number; conf: number;
      frameTs: number; processedAt: number }
  | { protocol: 1; type: 'pong'; nonce: string }
  | { protocol: 1; type: 'error'; code: string; message: string;
      sourceId?: string; sessionId?: string }
  | { protocol: 1; type: 'status'; sourceId: string;
      fps: number; dropped: number; busy: number;
      detectP50Ms: number; detectP95Ms: number;
      frameAgeMs: number; degradedTiming: boolean };
~~~

- Keep geometry flat to match #27. For tracking: cx/cy/conf in [0,1], w/h in (0,1], all four box edges in [0,1], conf>0. For locking/lost/idle: geometry may be the last valid box or all-zero sentinel, conf=0. Manager never moves for non-tracking states. This resolves how a no-target idle can conform without fabricated geometry.
- frameTs is the Sony manager's complete-response receipt timestamp, not sensor exposure. processedAt >= frameTs; reject implausible future times (50 ms tolerance) and stale seq/session. Manager rejects motion from observations older than 500 ms even if newly delivered.
- In predicted dropout tracking, retain last measured frameTs and decay confidence; never call a predicted frame fresh. Lost/idle sentinel may set frameTs=0.
- Strict metric status messages contain only counts/timings, no boxes, pixels, IDs other than sourceId, filesystem paths, or raw exceptions. Emit at most once per source per second.
- Configure is sent only after successful hello and after every reconnect. Configure replaces the allowlist, clears every prior target, and cancels removed source tasks. Select is never queued or replayed across a disconnect.
- A duplicate/out-of-session cancel cannot cancel a newer session. Cancel is safe to repeat.
- Heartbeat: send ping every 1 s, require matching pong within 3 s, then close/reconnect. Manager sees connection loss immediately and is independently protected by its 500 ms observation deadline. Reconnect 250 ms, 500 ms, 1 s, 2 s, 4 s, then capped 5 s with injected jitter; cancel on stop.
- Packaged helper binds 127.0.0.1 on port 0 and reports its actual port via a bounded one-line ready message on its owned stdout pipe. TS parent passes a per-launch WebSocket credential and separate frame-only credential via child environment/inherited pipe, never command line/URL/logs/status. WebSocket upgrade requires the credential. Stdout is protocol/readiness only; bounded stderr carries curated classes/counts.
- frameUrl must be exactly the known private backend origin plus an allowlisted Sony frame route generated by TS. Reject credentials/fragments/redirects, non-HTTP(S), non-loopback hosts, and arbitrary localhost routes. Use the frame-only token only for those GET routes; never give the Python worker a generic operator token.
- Developer sidecarUrl defaults to ws://127.0.0.1:7900 per #23. Nonloopback requires explicit TRACKING_ALLOW_REMOTE=1; packaged mode refuses it irrespective of YAML. Packaged helper URL is the supervised actual port, not a guessed free port.

## Interfaces and ownership map

Root/integration owns shared files; two disjoint coding agents can implement TS-only modules and Python-only modules after this contract is committed. No two writers touch configLoader.ts, statusServer.ts, index.ts, state.ts, controlStateMachine.ts, emergencyStop.ts, package.json, lockfiles, or context docs.

| Owner | Files | Responsibility / issues |
| --- | --- | --- |
| Root contract/config | src/config/configLoader.ts, src/config/paths.ts as needed, src/tracking/protocol.ts, docs/ai/contracts/tracking-electron-v1.json | #23 config defaults/env/validation, deviceKey through every resolveProfile and working-rig path, strict schema shared with Python, source resolver. Add kp/kd/pipelineDelayMs validated knobs for #34. Do not include personal config files. |
| TS control agent | src/tracking/trackingController.ts, trackingManager.ts, trackingClient.ts, src/testing/trackingSim.ts, virtualTrackingSidecar.ts, tracking focused tests | #25 pure law and metrics, #26 sessions/safety, #27 client/virtual helper. Imports only agreed config/types; no shared-file integration edits. |
| Python vision agent | tracker-sidecar/**, its tests/notices/requirements only | #29–31 mock server, authenticated protocol, bounded HTTP ingest, real ONNX detector, association/click/appearance-lock, aggregate metrics. No TS or package script edits. |
| Root safety integration | src/model/controlStateMachine.ts, src/safety/emergencyStop.ts, src/app/state.ts, src/index.ts, src/ui/statusServer.ts reconciliation | Construct manager/client after actual backend port available; shared per-physical-device motion budget; manual hooks; exact stop-before-close/sleep/rebind order; fresh state map; disabled inert lifecycle. #26/#33. |
| Root Sony/API/UI | src/sony/sonyManager.ts, src/ui/statusServer.ts, focused route/UI tests, existing Sony tests | #24 receipt timestamp after arrayBuffer and coalesced identity; #28 auth/validation/status; #32 Focus/Track/letterbox/overlay/Stop/Esc/Resume and accessible state. Minimal source setup UI for actual Sony-to-DJI association. |
| Root package/calibration/docs | scripts/package-electron-tracking.cjs, scripts/tracking-calibrate.*, electron variant/supervision, package metadata, build manifest, docs | #50 runtime/model staging/signing/offline checks, #34 capped consented calibration and dry run, #35 runbook and explicitly pending human results. Existing manual artifact untouched. |

Suggested TS APIs (implementation may choose constructor injection but keep ownership):
- resolveTrackingSources(config) -> [{sourceId, sonyCameraId, device, cameraId:null|string, invertPan, invertTilt}].
- TrackingController.update(observation|null, now) -> {pan,tilt,state}; reset() clears filters. No timers or devices.
- TrackingClient.configure(sources), select(sourceId, sessionId, x, y), cancel(sourceId, sessionId), start(), stop(); emits connected/disconnected/track/status/error after validation.
- TrackingManager.select(sourceId,x,y), cancel(sourceId), resume(sourceId), operatorOverride(cameraId), emergencyStop(), reconcile(config,devices), tick(now), stop(), getStatus(). Error classes map to 400/404/409 without exposing raw exceptions.
- Suspend on override while retaining the Python lock and latest valid observation; Resume only arms that same healthy lock with current device binding and fresh data, after resetting control filter. Do not resume by selecting an arbitrary new neighbor from an old click.
- One shared motion ledger must govern manual and tracking pan/tilt on the same physical device. Keep the existing shouldSendMotion predicate and a narrow injected hook/budget. Two independent lastSent maps can send 40 Hz at handoff and fail the acceptance even when each path separately passes.
- Existing emergencyStopAll must invalidate manager sessions before looping over devices so the next tracking tick cannot reissue motion. Avoid duplicate manager/device stop counting by one deliberate ownership path.
- Profile reconcile must stop the old bound MotionDevice object before it is replaced/closed, invalidate sessionId, then resolve the new slot. Do not reuse cam4's old target for a different physical device.

## Required acceptance tests

Tests should exercise public behavior and own disposable homes/ports/processes. Existing isolated suite names remain authoritative; do not boot the production config.

1. #23: absent/default disabled, all field bounds/nonfinite input, env true/false/1/0/invalid, unknown/non-DJI device, duplicate mappings, deviceKey through profile and working copy, active source cam4→null→different slot without target replay, YAML comments/unknown keys survive UI save.
2. #24: two concurrent frame callers receive the same capturedAt from one body read; header/no-store/body/content-type exact; busy 503 and Retry-After unchanged. Run SonyManager tests explicitly.
3. #25: inject time; closed loop at 8 fps, 20 Hz output, delay 150/300/500 ms, command quantization, first-order plant lag. Require deadzone settling by 30 s, overshoot <=20% initial offset, <=1 post-crossing sign reversal, no sustained oscillation in final 10 s. Also stationary zero, immediate lost zero, invalid/conf0/out-of-range zero, sign/invert four quadrants, cap/finiteness. Record delay table; do not weaken metrics to make a gain pass.
4. #26: real virtualDjiBridge command stream <=20 Hz with <=150 ms heartbeat while active; exact stop order/count on manual override, other camera unchanged, emergency, >500 ms genuine frame age, loss, bridge/gimbal detach, sidecar disconnect, sleep, shutdown, profile rebinding, and same-camera manual preset/recenter. No later movement after invalidating interruptions without fresh Select/explicit permitted Resume.
5. #27/#29: actual TS client ↔ bundled Python mock handshake/select/cancel, trajectory ordering, missing heartbeat, malformed/unknown/binary/>64 KiB/NaN/out-of-bounds/future/session/seq table, configure after reconnect and no replay, auth/Origin rejection, disconnect cleanup, per-source task cancellation, disabled no sockets/timers.
6. #30: fake HTTP 200/503 Retry-After/timeout/corrupt JPEG/too-large JPEG/redirect/missing timestamp; one request per source; duplicate timestamp skip; no tight loops; metrics throttled; in-memory frames. Real ONNX model load+run separately with generated RGB data, provider and p50/p95/throughput/frame-age table. Synthetic detector stubs validate known boxes; actual ONNX execution with no detected person must not be misrepresented as vision accuracy.
7. #31: synthetic colored people-shaped blobs with known detections, containing/smallest/nearest-radius/no-target click, exclusive identity crossing, short dropout, appearance mismatch, ambiguous neighbor -> lost, reacquire deadline, cancel clears histogram/state, unchanged genuine timestamp during prediction.
8. #28/#32/#33: auth and 400/404/409/429 cases, repeated cancel sends stop, >=250 ms select gate, nonblocking route, additive /api/status only; browser every state desktop/tablet/mobile/dark, keyboard Escape/focus/aria-live, Focus touch unchanged, letterbox click and overlay exact; virtual pad RS rising edge cancel/resume/noop and all existing chords.
9. #34: dry-run against virtual device plus synthetic frame sequence; no motion absent --yes-move/connected rig; <=0.15 and <=1 s; finally-stop on cancellation/errors/SIGINT; N trial median/spread and unreliable-variance label, no config writes. Human calibration result remains pending.
10. #50: exact Python/model checksums, corrupt model rejected before inference, relocated signed resources with empty HOME/minimal PATH/random cwd/offline, actual bundled interpreter imports native deps and runs actual model from mounted DMG; helper crash/quit/sleep cleanup, no host Python/pip, no residual child; archive/size/minOS/architecture/notice checks. Manual DMG must contain no tracking runtime/model/controls.
11. #35: runnable docs/commands and all individual physical drill items explicitly MANUAL_PENDING until witnessed; root independently reruns baseline and incremental gates, then records result in project state.

## Pinned runtime and model evidence

Primary metadata checked 2026-10-01. This is a build manifest proposal, not an installation/inference result.

### Runtime

- CPython 3.12.14 from python-build-standalone release 20260929, target aarch64-apple-darwin, install_only_stripped.
- URL: https://github.com/astral-sh/python-build-standalone/releases/download/20260929/cpython-3.12.14%2B20260929-aarch64-apple-darwin-install_only_stripped.tar.gz
- SHA256: 1bb3e53d231ee2c8881e8daf6426f4dd95bff0dda496af0f3af300357aa998d0
- Size: 25,017,608 bytes, from authenticated GitHub release asset metadata.
- Upstream runtime/redistribution guidance: https://github.com/astral-sh/python-build-standalone/blob/main/docs/running.md and https://github.com/astral-sh/python-build-standalone/blob/main/docs/distributions.md . Use install-only for shipping; preserve CPython/component license files. Upstream documents libedit instead of GPL readline and globally disabled gdbm. Inspect the exact downloaded archive licenses/native link graph before final package sign-off; repository license alone is not a component audit.
- Build-only pip/uv is permitted; users do not need it. Stage dependencies at build time with hashes, never runtime pip install. Set PYTHONNOUSERSITE=1 and PYTHONDONTWRITEBYTECODE=1; run absolute bundled Python with -I (isolated) and explicit script/resource locations. Do not inherit host PYTHONPATH/PYTHONHOME.
- Stage real files under Contents/Resources/python, outside ASAR, sign nested .so/.dylib/extensionless Python executable before the app. Preserve runtime-relative @loader_path dependencies; reject Homebrew/developer link paths. Never copy the global uv symlink itself into the app.

### Exact model with explicit weight-directory license

Use OpenCV Zoo's YOLOX-s ONNX, not an arbitrary third-party export.

- Repository commit: 47534e27c9851bb1128ccc0102f1145e27f23f98.
- Model: models/object_detection_yolox/object_detection_yolox_2022nov.onnx.
- URL: https://media.githubusercontent.com/media/opencv/opencv_zoo/47534e27c9851bb1128ccc0102f1145e27f23f98/models/object_detection_yolox/object_detection_yolox_2022nov.onnx
- SHA256 from its git LFS pointer: c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063.
- Size: 35,858,002 bytes.
- Exact README: https://github.com/opencv/opencv_zoo/blob/47534e27c9851bb1128ccc0102f1145e27f23f98/models/object_detection_yolox/README.md .
- Exact license: https://github.com/opencv/opencv_zoo/blob/47534e27c9851bb1128ccc0102f1145e27f23f98/models/object_detection_yolox/LICENSE .
- The README's license section says all files in that directory are Apache 2.0; the actual ONNX weight file is inside that directory. This is stronger artifact-specific evidence than inferring weight rights from a repository badge. Retain Apache text, authorship and any upstream NOTICE; identify our adapted decoder implementation.
- Official Megvii YOLOX ONNX releases are listed at https://github.com/Megvii-BaseDetection/YOLOX/tree/6ddff4824372906469a7fae2dc3206c7aa4bbaee/demo/ONNXRuntime . The repository is Apache2 but its direct weight-only clarification request https://github.com/Megvii-BaseDetection/YOLOX/issues/1865 was unanswered at this check. Do not claim that issue was resolved.
- The initial preparatory author downloaded no binaries. The later cache-only audit below has now fetched and verified exact model/runtime bytes; no tracking source or runtime installation was performed. Use only checksum-verified assets and revalidate before loading. A copied/truncated Git LFS pointer must fail checksum.

### Detector implementation strategy

Use ONNX Runtime + NumPy + Pillow only; avoid OpenCV/FFmpeg/Torch/Ultralytics and their extra payloads. Pillow decodes JPEG to RGB with an explicit decoded-pixel bound, source size bound, and EXIF behavior fixed. Runtime source images/crops never reach disk.

The pinned OpenCV Zoo example converts BGR to RGB, top-left letterboxes to 640x640 with fill=114 and bilinear resize, then CHW float32 without /255 or mean/std normalization. Its decoder adds stride grid offsets to xy and exponentiates wh at strides 8/16/32; output is expected [1,8400,85]. Use the pinned example as provenance; verify actual model input/output metadata at load and fail curatedly if incompatible. Clip logits before exp to avoid overflow, multiply objectness*class0(person) score, NMS person candidates, undo letterbox scale, clip to original frame, normalize xywh, reject zero/nonfinite boxes. A focused test compares pure preprocessing/decoding against known synthetic tensors.

Prefer CoreMLExecutionProvider only if ort.get_available_providers() includes it; list CPUExecutionProvider as fallback. If accelerated session creation or first inference fails, reopen on CPU and report the actual provider. CoreML availability is not proof every model node ran on accelerator. Official provider guide: https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html . Do not save optimized graphs or image data to user files; compiler cache, if needed, contains model-only data in the tracking userData cache.

Use a small in-house constant-velocity Kalman + IoU association with appearance gating (NumPy, no scipy needed) for the exclusive selected target. Require appearance similarity for reacquire and reject ambiguous matches. Keep normalized histograms only in memory and clear on cancel/idle/configure/disconnect. For dropout predictions, preserve the last actual frameTs and low confidence, so motion safety cannot be extended by prediction.

Actual inference proof must invoke the real bundled ONNX session on at least two distinct generated synthetic RGB images, check model input/output metadata, output shape [1,8400,85], all finite tensor values, and an input-dependent output digest. Record provider, model hash, actual inference count and timing; do not print raw detections or pixels. A zero-length post-NMS person list is a valid synthetic-image result, but does not establish detection accuracy. Positive lock/association behavior is tested separately against synthetic known detections and clearly identified as such. Do not add OpenCV basketball images or other real-person photos: #30 explicitly requires synthetic test images. If a procedural humanoid produces a real positive detection, preserve its generation recipe and assert the result without introducing real-person fixtures.

### Wheels (CPython 3.12 / ARM64 / tracking macOS 14 minimum)

Pin the exact filenames below rather than asking pip for latest on this newer host. Static inspection of the downloaded ONNX Runtime 1.23.2 macosx_13_0_arm64 wheel found actual `LC_BUILD_VERSION minos 13.4` in both its runtime dylib and pybind module: the wheel tag alone was insufficient. The initial NumPy macosx_11_0 candidate actually bundles libquadmath (LGPL-2.1-or-later) and GCC/Fortran runtime libraries. Root approved selecting the same NumPy 2.5.3 **macosx_14_0_arm64** wheel instead. Its actual core links Apple's system Accelerate and ships no `.dylibs`, OpenBLAS, libquadmath, libgcc or libgfortran payload. Its actual Mach-O minimum is 14.0. Therefore **tracking advertises macOS 14.0 minimum; manual remains macOS 13.0**. Retain all NumPy notices, including upstream generic cross-platform license text, without claiming absent native libraries are shipped. SymPy requires mpmath<1.4, so mpmath1.3.0 remains selected.

PyPI metadata is a starting license inventory: retain every wheel's .dist-info licenses/NOTICE and inspect bundled libraries, including NumPy BLAS/compiler-runtime exceptions and Pillow JPEG/zlib/etc, before redistribution claims. The listed permissive package labels do not replace exact wheel notices.

| Package | Exact wheel | SHA256 | Bytes | Metadata license |
| --- | --- | --- | --- | --- |
| onnxruntime 1.23.2 | onnxruntime-1.23.2-cp312-cp312-macosx_13_0_arm64.whl | b8f029a6b98d3cf5be564d52802bb50a8489ab73409fa9db0bf583eabb7c2321 | 17195929 | MIT License |
| numpy 2.5.3 | numpy-2.5.3-cp312-cp312-macosx_14_0_arm64.whl | a72f874bc9e10e4b8f80426fb49716d5141f64442a0c8418065093ec8017fbb0 | 5445405 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| pillow 12.3.0 | pillow-12.3.0-cp312-cp312-macosx_11_0_arm64.whl | ffd0c5368496f41b0944be820fcb7a838aa6e623d250b01acf2643939c3f99d7 | 4780323 | MIT-CMU |
| websockets 17.1 | websockets-17.1-cp312-cp312-macosx_11_0_arm64.whl | 87f0d5e77548b0c40c8464cdb6108792e7e53f487c6400028a4ec28a8afbe5ab | 214959 | BSD-3-Clause |
| coloredlogs 15.0.1 | coloredlogs-15.0.1-py2.py3-none-any.whl | 612ee75c546f53e92e70049c9dbfcc18c935a2b9a53b66085ce9ef6a6e5c0934 | 46018 | MIT |
| flatbuffers 25.12.19 | flatbuffers-25.12.19-py2.py3-none-any.whl | 7634f50c427838bb021c2d66a3d1168e9d199b0607e6329399f04846d42e20b4 | 26661 | Apache 2.0 |
| packaging 26.3 | packaging-26.3-py3-none-any.whl | d7193f7c8e4e93f444fde0262bf90af30e16fa0ad0ad44cb553c87339b23cd1c | 129956 | Apache-2.0 OR BSD-2-Clause |
| protobuf 7.36.2 | protobuf-7.36.2-py3-none-any.whl | bdb3a345d48db958e6ce1f18e508beb0cc981d64f24088427549c866cd039f1e | 179806 | 3-Clause BSD License |
| sympy 1.14.0 | sympy-1.14.0-py3-none-any.whl | e091cc3e99d2141a0ba2847328f5479b05d94a6635cb96148ccb3f34671bd8f5 | 6299353 | BSD |
| humanfriendly 10.0 | humanfriendly-10.0-py2.py3-none-any.whl | 1697e1a8a8f550fd43c2865cd84542fc175a61dcb779b6fee18cf6b6ccba1477 | 86794 | MIT |
| mpmath 1.3.0 | mpmath-1.3.0-py3-none-any.whl | a0b2b9fe80bbcd81a6647ff13108738cfb482d481d826cc0e02f5b35e5c88d2c | 536198 | BSD |

Build manifest (primary PyPI URLs; runtime-only dependencies, no extras):

~~~json
[
  {
    "name": "onnxruntime",
    "version": "1.23.2",
    "filename": "onnxruntime-1.23.2-cp312-cp312-macosx_13_0_arm64.whl",
    "url": "https://files.pythonhosted.org/packages/1b/9e/f748cd64161213adeef83d0cb16cb8ace1e62fa501033acdd9f9341fff57/onnxruntime-1.23.2-cp312-cp312-macosx_13_0_arm64.whl",
    "sha256": "b8f029a6b98d3cf5be564d52802bb50a8489ab73409fa9db0bf583eabb7c2321",
    "size": 17195929
  },
  {
    "name": "numpy",
    "version": "2.5.3",
    "filename": "numpy-2.5.3-cp312-cp312-macosx_14_0_arm64.whl",
    "url": "https://files.pythonhosted.org/packages/9c/59/a312e95696e5f601914dd8b6dd844692ba61670807417e24b68e337b5c70/numpy-2.5.3-cp312-cp312-macosx_14_0_arm64.whl",
    "sha256": "a72f874bc9e10e4b8f80426fb49716d5141f64442a0c8418065093ec8017fbb0",
    "size": 5445405
  },
  {
    "name": "pillow",
    "version": "12.3.0",
    "filename": "pillow-12.3.0-cp312-cp312-macosx_11_0_arm64.whl",
    "url": "https://files.pythonhosted.org/packages/d8/66/9a386a92561f402389a4fc70c18838bf6d35eb5eb5c6850b4b2dc64f5048/pillow-12.3.0-cp312-cp312-macosx_11_0_arm64.whl",
    "sha256": "ffd0c5368496f41b0944be820fcb7a838aa6e623d250b01acf2643939c3f99d7",
    "size": 4780323
  },
  {
    "name": "websockets",
    "version": "17.1",
    "filename": "websockets-17.1-cp312-cp312-macosx_11_0_arm64.whl",
    "url": "https://files.pythonhosted.org/packages/8f/e7/df821761772beaa48c211ee0e234930b35c1473778470773823f56d3911b/websockets-17.1-cp312-cp312-macosx_11_0_arm64.whl",
    "sha256": "87f0d5e77548b0c40c8464cdb6108792e7e53f487c6400028a4ec28a8afbe5ab",
    "size": 214959
  },
  {
    "name": "coloredlogs",
    "version": "15.0.1",
    "filename": "coloredlogs-15.0.1-py2.py3-none-any.whl",
    "url": "https://files.pythonhosted.org/packages/a7/06/3d6badcf13db419e25b07041d9c7b4a2c331d3f4e7134445ec5df57714cd/coloredlogs-15.0.1-py2.py3-none-any.whl",
    "sha256": "612ee75c546f53e92e70049c9dbfcc18c935a2b9a53b66085ce9ef6a6e5c0934",
    "size": 46018
  },
  {
    "name": "flatbuffers",
    "version": "25.12.19",
    "filename": "flatbuffers-25.12.19-py2.py3-none-any.whl",
    "url": "https://files.pythonhosted.org/packages/e8/2d/d2a548598be01649e2d46231d151a6c56d10b964d94043a335ae56ea2d92/flatbuffers-25.12.19-py2.py3-none-any.whl",
    "sha256": "7634f50c427838bb021c2d66a3d1168e9d199b0607e6329399f04846d42e20b4",
    "size": 26661
  },
  {
    "name": "packaging",
    "version": "26.3",
    "filename": "packaging-26.3-py3-none-any.whl",
    "url": "https://files.pythonhosted.org/packages/63/34/ba1c580383c9eada3711951fef0795c80b829a078d72188184bcab9dd527/packaging-26.3-py3-none-any.whl",
    "sha256": "d7193f7c8e4e93f444fde0262bf90af30e16fa0ad0ad44cb553c87339b23cd1c",
    "size": 129956
  },
  {
    "name": "protobuf",
    "version": "7.36.2",
    "filename": "protobuf-7.36.2-py3-none-any.whl",
    "url": "https://files.pythonhosted.org/packages/e4/04/d52c7016b04b6c5108f26691f9d33ec82a9b65d041f1a9c771137693d618/protobuf-7.36.2-py3-none-any.whl",
    "sha256": "bdb3a345d48db958e6ce1f18e508beb0cc981d64f24088427549c866cd039f1e",
    "size": 179806
  },
  {
    "name": "sympy",
    "version": "1.14.0",
    "filename": "sympy-1.14.0-py3-none-any.whl",
    "url": "https://files.pythonhosted.org/packages/a2/09/77d55d46fd61b4a135c444fc97158ef34a095e5681d0a6c10b75bf356191/sympy-1.14.0-py3-none-any.whl",
    "sha256": "e091cc3e99d2141a0ba2847328f5479b05d94a6635cb96148ccb3f34671bd8f5",
    "size": 6299353
  },
  {
    "name": "humanfriendly",
    "version": "10.0",
    "filename": "humanfriendly-10.0-py2.py3-none-any.whl",
    "url": "https://files.pythonhosted.org/packages/f0/0f/310fb31e39e2d734ccaa2c0fb981ee41f7bd5056ce9bc29b2248bd569169/humanfriendly-10.0-py2.py3-none-any.whl",
    "sha256": "1697e1a8a8f550fd43c2865cd84542fc175a61dcb779b6fee18cf6b6ccba1477",
    "size": 86794
  },
  {
    "name": "mpmath",
    "version": "1.3.0",
    "filename": "mpmath-1.3.0-py3-none-any.whl",
    "url": "https://files.pythonhosted.org/packages/43/e3/7d92a15f894aa0c9c4b49b8ee9ac9850d6e63b03c9c32c0367a13ae62209/mpmath-1.3.0-py3-none-any.whl",
    "sha256": "a0b2b9fe80bbcd81a6647ff13108738cfb482d481d826cc0e02f5b35e5c88d2c",
    "size": 536198
  }
]
~~~

### Local tool/cache facts

**Later cache/static audit (same delivery, no tracking source or runtime installation):** All 13 initial runtime/model/wheel downloads matched exact digest and size; the chosen NumPy14 replacement also matched its primary PyPI digest. Cache root is the git-ignored `dist/tracking-cache/` in the assigned worktree. The original NumPy11 archive is retained only as rejected-candidate evidence; **stage exactly the current manifest filenames, never every wheel in the cache**. `cache-evidence-1790882930516.json` records initial downloads; `license-candidates-evidence-1790883060058.json` records NumPy14 and the Python license source. Original static audit `inspection-evidence-1790883004873.json` inspected 63 Mach-O files, all arm64, and found the real ORT13.4 requirement. Apparent `/DLC/...` paths on wheel dylibs were their `LC_ID_DYLIB` identifiers, not imports; after excluding IDs, actual import graphs have no developer/Homebrew absolute dependencies. Relocated load/inference still must be executed after implementation.

The install-only Python archive omits its complete component notices. Its matching full build is
`cpython-3.12.14+20260929-aarch64-apple-darwin-pgo+lto-full.tar.zst`,
54,996,639 bytes, SHA256 `332588681afefc98045995122657a64f8e708d0fb56e683733b1f7cc42157f97`,
at `https://github.com/astral-sh/python-build-standalone/releases/download/20260929/cpython-3.12.14%2B20260929-aarch64-apple-darwin-pgo%2Blto-full.tar.zst`.
The GitHub release asset digest and downloaded bytes agree. `python/PYTHON.json` and
`python/licenses/` are cached under `dist/tracking-cache/python-build-licenses/`.
Copy those notices into the tracking distribution. Exact manifest licenses cover
CPython/CNRI, bzip2, libffi MIT, ncurses X11, mpdecimal BSD-2, OpenSSL/Apache2,
liblzma0BSD, SQLite, Tcl/Tk, libuuid BSD-3, expat MIT, libedit BSD-3 and Zlib.
The manifest refers to a missing `LICENSE.zlib-ng.txt` for modules that actually
link the system zlib (`system:true`); no separate zlib-ng is shipped by this Python
archive. Retain the supplied zlib text and all exact build notices. Pillow's wheel
separately includes full component notices for its bundled codecs. Its liblzma
notice distinguishes the public-domain library from GPL command-line/build tools
that are not shipped; select FreeType's included FTL option and retain attribution.
ONNX Runtime includes its MIT license and `ThirdPartyNotices.txt` (6,156 lines);
both must ship. This cache audit is static evidence, not packaged inference or
final redistribution verification.

The coloredlogs and humanfriendly wheels omit standalone license files. Their
exact-version PyPI source distributions were separately downloaded, digest-checked,
and their MIT `LICENSE.txt` files cached under `dist/tracking-cache/extra-notices/`.
The flatbuffers wheel has Apache2 headers but no full license text and PyPI has no
source distribution for that version. Its exact release tag `v25.12.19` resolves
to `7e163021e59cca4f8e1e35a7c828b5c6b7915953`; upstream `LICENSE` is cached as
`dist/tracking-cache/flatbuffers-LICENSE.txt`, SHA256
`cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`.
Copy these additional notices into the tracking distribution as well.

Read-only checks on the supplied Mac confirmed arm64, uv at /Users/ajhochhalter/.local/bin/uv, full Xcode clang and codesign. uv has managed CPython 3.12.13 installed at /Users/ajhochhalter/.local/share/uv/python/cpython-3.12.13-macos-aarch64-none (3.12 alias is a symlink), build date 20260602, deployment target 11.0. Other managed versions 3.10/3.11/3.13 and Homebrew versions are present, but shipping must not depend on any of them. The managed 3.12 interpreter has none of onnxruntime/numpy/PIL/websockets installed. No matching wheel filename cache was found in the narrow cache query; do not assume wheels are cached. No package installations occurred.

The agent-reach update check returned installed v1.5.0 current. No unrelated memory facts were used: the lightweight MEMORY.md search had no fps-camcontrol hit.


## Refreshed GitHub issue snapshot

Authenticated GitHub CLI refresh on 2026-10-01. This full snapshot is the acceptance source for implementation; do not re-fetch unless the user requests changed scope or later evidence establishes drift. The initial combined output was truncated, so one recovery fetch captured complete bodies below.

### #23 — tracking: Tracking config block + device-key resolution

URL: https://github.com/ajhochy/fps-camcontrol/issues/23

State: OPEN; updated: 2026-09-30T21:39:43Z

**Labels:** `feature`, `tracking`, `config` · **Size:** S · **Depends on:** none · **Plan:** `docs/ai/current-plan.md`

## Goal
Add an optional, disabled-by-default `tracking:` block to `config/devices.yaml`, validated like the `sony:` block, and make a configured tracking source resolvable to the **currently active camera slot** for its gimbal.

## Context
- `resolveProfile()` in `src/config/configLoader.ts` turns profile slots into `config.cameras` and **drops the inventory device key** (`rs3`, `rs3pro-a`, …). A tracking source is tied to physical hardware (a Sony camera mounted on a specific gimbal), so it must reference the inventory key and be mapped to whichever slot uses that device in the active profile.
- `resolveSonyConfig()` (zod schema + env overrides) is the template to copy.

## Likely files
- `src/config/configLoader.ts` (schema, `resolveTrackingConfig`, `CameraConfig.deviceKey`, `AppConfig.tracking`)
- `config/devices.yaml` — **comment block only**; the file has unrelated uncommitted local edits, do not include them in this change
- `docs/ai/decisions/2026-09-30-auto-tracking-architecture.md` (link only if wording needs to change)

## Acceptance criteria
1. Absent `tracking` block ⇒ `config.tracking` is `{ enabled: false, … defaults }` and nothing else changes.
2. Schema fields: `enabled`, `sidecarUrl` (ws/wss URL, default `ws://127.0.0.1:7900`), `maxSpeed` (0.05–1, default 0.35), `deadzone` (0–0.3, default 0.04), `lostHoldMs` (default 3000), `sources[]` = `{ sonyCameraId, device, invertPan=false, invertTilt=false }`.
3. Env overrides `TRACKING_ENABLED` (true/false/1/0, else throws like `SONY_ENABLED`) and `TRACKING_SIDECAR_URL` take precedence over YAML.
4. `sources[].device` must exist in `devices:` inventory and be a `dji-bridge` device (v1); otherwise config load fails with a message naming the source.
5. `CameraConfig` gains `deviceKey` (set by `resolveProfile`; unset for the legacy `cameras:` form). Existing config behavior, saved YAML, and the UI config editor are unaffected.
6. A pure helper `resolveTrackingSources(config)` returns, per source, the active `cameraId` or `null` when the device is not in the active profile. A source whose device is absent is **not an error**.
7. Comments in `devices.yaml` document the block and stay intact across a UI save (see `writeDevicesYaml`).

## Tests / evaluation
- Smoke assertions: default when absent; valid block; each invalid field; env precedence and bad env value; unknown device; non-DJI device; profile switch flips resolver between `cam4` and `null`.
- `pnpm build`; `STATUS_PORT=<free> pnpm test:smoke`; `git diff --check`.

## Out of scope / data safety
No runtime tracking code. No UI editor. Do not commit local changes to `config/devices.yaml`, `config/presets.json`, or `config/sony-cameras.json`. Do not put real Sony camera IDs in committed examples.


---
Source: click-to-track plan (`docs/ai/current-plan.md`, issue ID T1). Plan docs are local to the working tree until committed.


### #24 — tracking: Sony live-view frame capture timestamp

URL: https://github.com/ajhochy/fps-camcontrol/issues/24

State: OPEN; updated: 2026-09-30T21:39:45Z

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


---
Source: click-to-track plan (`docs/ai/current-plan.md`, issue ID T2). Plan docs are local to the working tree until committed.


### #25 — tracking: `TrackingController` control law + closed-loop simulator

URL: https://github.com/ajhochy/fps-camcontrol/issues/25

State: OPEN; updated: 2026-09-30T21:39:46Z

**Labels:** `feature`, `tracking`, `control` · **Size:** M · **Depends on:** #23 (types only) · **Plan:** `docs/ai/current-plan.md`

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


---
Source: click-to-track plan (`docs/ai/current-plan.md`, issue ID T3). Plan docs are local to the working tree until committed.


### #26 — tracking: `TrackingManager`: sessions, 20 Hz tick, arbitration, safety stops

URL: https://github.com/ajhochy/fps-camcontrol/issues/26

State: OPEN; updated: 2026-09-30T21:39:47Z

**Labels:** `feature`, `tracking`, `safety` · **Size:** L · **Depends on:** #23, #25 · **Plan:** `docs/ai/current-plan.md`

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
1. A session binds a source to its active slot via #23's resolver; unresolvable source ⇒ status `unavailable`, no error.
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
No WebSocket client (#27), no HTTP routes (#28), no UI. No VISCA support in v1 (registered device must be `dji-bridge`). No persistence of targets or observations. `controlStateMachine.ts` changes limited to the override hook — no refactor.


---
Source: click-to-track plan (`docs/ai/current-plan.md`, issue ID T4). Plan docs are local to the working tree until committed.


### #27 — tracking: `TrackingClient` + sidecar protocol + virtual sidecar

URL: https://github.com/ajhochy/fps-camcontrol/issues/27

State: OPEN; updated: 2026-09-30T21:39:48Z

**Labels:** `feature`, `tracking`, `protocol` · **Size:** M · **Depends on:** #23 · **Plan:** `docs/ai/current-plan.md`

## Goal
A WebSocket client for the tracker sidecar (handshake, reconnect/backoff, heartbeat, strict message validation) and a scripted fake sidecar for tests. **This issue freezes the v1 protocol** that #29–#31 implement.

## Context
`src/devices/djiBridgeDevice.ts` and `pi-bridge/dji_bridge.py` already implement this pattern (hello/capabilities, pings, reconnect backoff). Reuse its shape and conventions, not its code. Protocol (from the plan):

- App → sidecar: `hello`, `configure {sources:[{sourceId, frameUrl}]}`, `select {sourceId, x, y}`, `cancel {sourceId}`, `ping`
- Sidecar → app: `hello {version, capabilities:["person"], detector}`, `track {sourceId, state, cx, cy, w, h, conf, frameTs, processedAt}` with `state ∈ locking|tracking|lost|idle`, geometry normalized 0–1 in frame space, `pong`, `error {code, message}`

## Likely files
- `src/tracking/trackingClient.ts` (new)
- `src/tracking/protocol.ts` (new; types + zod validators — `zod` is already a dependency)
- `src/testing/virtualTrackingSidecar.ts` (new)
- `docs/ai/current-plan.md` (paste the final frozen schema into the protocol section)

## Acceptance criteria
1. Client connects lazily only when tracking is enabled; reconnects with capped exponential backoff + jitter; surfaces `connected/disconnected` events.
2. Every inbound message is validated; malformed, oversized, unknown-type, or out-of-range (`cx`,`cy` outside 0–1, NaN) messages are dropped and counted, never forwarded, never crash the client.
3. `track` for an unconfigured `sourceId` is ignored.
4. Heartbeat: missing `pong` for N seconds ⇒ treated as disconnected (manager's stale logic then stops the gimbal).
5. `configure` is re-sent after every reconnect, and any active `select` is **not** silently replayed (operator must re-select after a sidecar restart).
6. Virtual sidecar can: complete handshake, emit a scripted `track` sequence, go silent, drop the connection, and send malformed frames.
7. Protocol schema is versioned (`protocol: 1`) and documented in the plan.

## Tests / evaluation
Smoke: handshake; scripted sequence delivered in order; reconnect after drop; malformed-message table; silence ⇒ disconnect detection. `pnpm build`; `STATUS_PORT=<free> pnpm test:smoke`.

## Out of scope / data safety
No frame bytes ever cross this socket (the sidecar pulls frames itself). Bind/connect to loopback by default; refuse non-loopback `sidecarUrl` unless an explicit override is set. No logging of message payloads beyond type, sourceId, and state.


---
Source: click-to-track plan (`docs/ai/current-plan.md`, issue ID T5). Plan docs are local to the working tree until committed.


### #28 — tracking: Tracking API routes + AppState status

URL: https://github.com/ajhochy/fps-camcontrol/issues/28

State: OPEN; updated: 2026-09-30T21:39:50Z

**Labels:** `feature`, `tracking`, `api` · **Size:** M · **Depends on:** #26, #27 · **Plan:** `docs/ai/current-plan.md`

## Goal
Expose tracking to the UI: status, select-by-click, cancel, resume. Routes adapt; the manager owns state.

## Context
`statusServer.ts` already validates normalized touch coordinates for `POST /api/sony/cameras/:id/touch` — mirror that validation. Routes must not hold tracking state or timers.

## Likely files
- `src/ui/statusServer.ts` (routes only)
- `src/app/state.ts` (types, if not finished in #26)
- `src/testing/smokeTest.ts`

## Routes
- `GET /api/tracking/status` → `{ enabled, sidecar: {state, version?}, sources: [{ sourceId, sonyCameraId, cameraId|null, state, reason?, target?: {cx,cy,w,h,conf}, ageMs? }] }`. Never includes frame data, file paths, or raw sidecar errors.
- `POST /api/tracking/select` `{ sourceId, x, y }` — finite numbers in [0,1].
- `POST /api/tracking/cancel` `{ sourceId }`; `POST /api/tracking/resume` `{ sourceId }`.

## Acceptance criteria
1. Invalid body/coords ⇒ `400`; unknown `sourceId` ⇒ `404`; tracking disabled ⇒ `409`; source unavailable (gimbal not in profile / detached) ⇒ `409` with a curated reason.
2. `select` while the gimbal's device is disconnected is refused, not queued.
3. `cancel` is idempotent and always results in `stop()` being sent.
4. `/api/status` remains backward compatible (only additive keys).
5. No route blocks on the sidecar: `select` returns after the command is handed to the client (state then flows through status).
6. Rate-limit or coalesce repeated `select` (e.g. ≥ 250 ms between accepted selects per source).

## Tests / evaluation
Smoke: validation table; 404/409 paths; cancel idempotency; status shape with a virtual sidecar and virtual gimbal; `/api/status` snapshot unchanged except additive keys. `pnpm build`; `STATUS_PORT=<free> pnpm test:smoke`.

## Out of scope / data safety
No UI (#32). Endpoints are as open as the existing status server (`0.0.0.0`); note in the PR that `select`/`cancel` can move a physical gimbal from anywhere on the LAN, consistent with the existing config/preset routes — do not add auth in this issue, but record it as a risk in `docs/ai/project-state.md` via the state updater.


---
Source: click-to-track plan (`docs/ai/current-plan.md`, issue ID T6). Plan docs are local to the working tree until committed.


### #29 — tracking: Tracker sidecar skeleton (Python)

URL: https://github.com/ajhochy/fps-camcontrol/issues/29

State: OPEN; updated: 2026-09-30T21:39:51Z

**Labels:** `feature`, `tracking`, `python` · **Size:** M · **Depends on:** #27 (frozen protocol) · **Plan:** `docs/ai/current-plan.md`

## Goal
Create `tracker-sidecar/`: an asyncio WebSocket server speaking the v1 protocol with a **mock source driver** that emits scripted targets, so the whole app-side chain can be exercised end to end with no vision dependencies.

## Context
Follow `pi-bridge/` conventions: `websockets`, a pluggable driver interface (`drivers/base.py`, `mock_driver.py`), `requirements.txt`, `tests/` with `unittest`, README, optional systemd unit. Runs on the app's Mac; loopback only.

## Likely files
- `tracker-sidecar/tracker_sidecar.py` (entry, `--port`, `--source mock`)
- `tracker-sidecar/protocol.py`, `sources/base.py`, `sources/mock_source.py`
- `tracker-sidecar/requirements.txt`, `README.md`, `.gitignore`
- `tracker-sidecar/tests/`
- `docs/ai/testing-guide.md`, `docs/ai/repo-map.md`

## Acceptance criteria
1. `python3 tracker-sidecar/tracker_sidecar.py --source mock --port 7900` starts, binds **127.0.0.1** by default, and completes the `hello` handshake with `capabilities:["person"]`, `detector:"mock"`.
2. `select` starts a scripted trajectory (configurable: stationary, sine sweep, exit-frame); `cancel` ends it; `lost` and `idle` are emitted per script.
3. Invalid/oversized/unknown messages produce an `error` frame, not a crash; the server survives client disconnects.
4. Emits `frameTs`/`processedAt` from a clock it controls so the app can test latency logic.
5. The real TypeScript `TrackingClient` (#27) connects to it and the manager (#26) drives `virtualDjiBridge` from its scripted output in one smoke scenario or a documented manual script.
6. No imports of any vision library at this stage.

## Tests / evaluation
`python3 -m unittest discover -s tracker-sidecar/tests -v` covering protocol validation, mock trajectories, and a websocket round-trip. Document the command in `docs/ai/testing-guide.md`. `git diff --check`.

## Out of scope / data safety
No frame fetching, no detection (#30/#31). No launch-supervision UX. A `.venv/` must be git-ignored. No model files or sample footage committed.


---
Source: click-to-track plan (`docs/ai/current-plan.md`, issue ID T7). Plan docs are local to the working tree until committed.


### #30 — tracking: Sidecar frame ingest + person detection

URL: https://github.com/ajhochy/fps-camcontrol/issues/30

State: OPEN; updated: 2026-09-30T21:39:52Z

**Labels:** `feature`, `tracking`, `python`, `vision` · **Size:** L · **Depends on:** #24, #29 · **Plan:** `docs/ai/current-plan.md`

## Goal
Pull live-view frames from the app's own endpoint, decode them, detect people, and report detections with correct capture timestamps and measured latency.

## Context
- Frame source: `GET http://127.0.0.1:<STATUS_PORT>/api/sony/cameras/<id>/live-view/frame` (JPEG) with `X-Frame-Captured-At` (#24). The URL arrives via `configure`; the sidecar has no Sony knowledge.
- The endpoint coalesces reads and returns `503`/`Retry-After` when a camera lane is busy; the browser polls the same endpoint. The sidecar must not starve the UI.
- Detector sits behind an interface (see decision record). **License check is part of this issue.**

## Likely files
- `tracker-sidecar/frames.py` (HTTP poller), `detector.py` (interface + ONNX implementation), `sources/live_source.py`
- `tracker-sidecar/requirements.txt`, `tests/`, `README.md`

## Acceptance criteria
1. At most **one** in-flight frame request per source; honors `Retry-After`; capped backoff on 503/timeouts/decode errors; never tight-loops.
2. Skips frames it has already processed (same `capturedAt`) instead of re-detecting.
3. Uses `capturedAt` as `frameTs`; if the header is missing, falls back to receive time and flags `degradedTiming` in `hello`/status.
4. Detection interface: `detect(image) -> [ {x,y,w,h,conf} ]` normalized, person class only; a stub detector for tests.
5. ONNX Runtime implementation with a **permissively licensed** model; model and runtime licenses are recorded in the PR and `tracker-sidecar/THIRD_PARTY_NOTICES.md`. `ultralytics` is **not** used without an explicit license decision.
6. Execution provider selection prefers CoreML/Apple acceleration when available, falls back to CPU; chosen provider reported in `hello`.
7. Measured end-to-end numbers (frames/s, detect ms p50/p95, frame age at emit) on the target Mac are pasted into the PR and feed the plan's `pipelineDelayMs` default.
8. Model weights are **not** committed; a documented script/command fetches them to a git-ignored path.
9. Per-source metrics (fps, dropped, 503 count) available via an `error`-free status message or log line (throttled).

## Tests / evaluation
Unit tests with the stub detector and a fake HTTP server (200, 503 with Retry-After, timeout, corrupt JPEG, missing header). One opt-in integration test (skipped without model/env). `python3 -m unittest discover -s tracker-sidecar/tests -v`.

## Out of scope / data safety
No locking/association (#31). **Never write frames, crops, or detections to disk or logs** (only counts/timings). Test images must be synthetic (generated shapes), not real people.


---
Source: click-to-track plan (`docs/ai/current-plan.md`, issue ID T8). Plan docs are local to the working tree until committed.


### #31 — tracking: Sidecar click-to-lock, association, lost/reacquire

URL: https://github.com/ajhochy/fps-camcontrol/issues/31

State: OPEN; updated: 2026-09-30T21:39:53Z

**Labels:** `feature`, `tracking`, `python`, `vision` · **Size:** L · **Depends on:** #30 · **Plan:** `docs/ai/current-plan.md`

## Goal
Turn a click into a locked person and keep that identity across frames, emitting `locking → tracking → lost → idle` with stable geometry.

## Context
Prior art favors detector + ByteTrack-style association over single-object OpenCV trackers (CSRT/KCF drift and lose identity on occlusion). v1 is exclusive single-target lock.

## Likely files
- `tracker-sidecar/tracker.py` (association + lock state machine), `association.py` (Kalman + IoU matching, or a permissively licensed library)
- `tracker-sidecar/tests/`, `requirements.txt`, `THIRD_PARTY_NOTICES.md`

## Acceptance criteria
1. `select{x,y}` picks the detection containing the click (smallest area if nested); if none, the nearest detection whose center is within a configurable radius; otherwise responds with `idle` + `error{code:"no_target"}`.
2. Lock is exclusive: a new person entering or standing near the target never takes over the ID.
3. Tracks through short detection dropouts (Kalman predict) and brief occlusion; emits `tracking` with the last good geometry flagged by `conf`.
4. On loss beyond `reacquireMs`, emits `lost`; attempts reacquire only with an appearance check (e.g. color-histogram similarity against the locked crop, stored **in memory only**) above a threshold; otherwise stays `lost` until timeout ⇒ `idle`.
5. `cancel` clears all lock state and memory of the target appearance immediately.
6. Geometry is smoothed only lightly (the app owns the control filter) and always normalized; `frameTs` is that of the frame it was derived from.
7. Tracker library license (MIT/Apache/BSD) recorded; AGPL/GPL dependencies are not added without a recorded decision.

## Tests / evaluation
Synthetic scenes (rendered moving boxes/people-shaped blobs): correct person locked; no ID swap when paths cross; survives N-frame occlusion; `lost` fires at the right time; `cancel` clears state; click in empty space handled. `python3 -m unittest discover -s tracker-sidecar/tests -v`.

## Out of scope / data safety
No face recognition or persistent embeddings; appearance data lives only in process memory and is wiped on cancel/idle/restart. No generic-object tracking. No disk/log persistence of crops. Synthetic fixtures only.


---
Source: click-to-track plan (`docs/ai/current-plan.md`, issue ID T9). Plan docs are local to the working tree until committed.


### #32 — tracking: Operator UI: Track mode, overlay, cancel

URL: https://github.com/ajhochy/fps-camcontrol/issues/32

State: OPEN; updated: 2026-09-30T21:39:54Z

**Labels:** `feature`, `tracking`, `ui` · **Size:** M · **Depends on:** #28 · **Plan:** `docs/ai/current-plan.md`

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
`node scripts/check-page-js.cjs`; browser fixture run with a fake status payload for every state (desktop, tablet, mobile, dark); smoke for the routes already covered in #28. `pnpm build`; `STATUS_PORT=<free> pnpm test:smoke`.

## Out of scope / data safety
No settings editor, no zoom/framing controls, no recording. Overlay boxes are drawn client-side from status data; no frames are copied or stored by the page beyond the existing preview blob handling.


---
Source: click-to-track plan (`docs/ai/current-plan.md`, issue ID T10). Plan docs are local to the working tree until committed.


### #33 — tracking: Controller binding: toggle/cancel tracking

URL: https://github.com/ajhochy/fps-camcontrol/issues/33

State: OPEN; updated: 2026-09-30T21:39:55Z

**Labels:** `feature`, `tracking`, `input` · **Size:** S · **Depends on:** #26 · **Plan:** `docs/ai/current-plan.md`

## Goal
Give the operator a gamepad way to cancel/resume tracking on the controlled camera without touching the web UI. (Stick override already suspends tracking — #26.)

## Context
Existing chords: `LB + A/B/X/Y` save presets, `LB + RB` recenter, `RB` auto-transition, d-pad speed/lower-thirds, `back` emergency stop. `config/mappings.yaml` and `MappingSchema` define named inputs; controller profiles live in `controller-profiles/*.yaml`.

## Likely files
- `config/mappings.yaml` (**UI-managed file — check for local edits first**)
- `src/config/configLoader.ts` (`MappingSchema`)
- `src/model/controlStateMachine.ts`
- `controller-profiles/*.yaml` (only if a new logical button is needed)

## Acceptance criteria
1. Choose an input that is unused in every shipped profile (document the choice and why; verify against `xbox.yaml`, `xbox-bluetooth.yaml`, `switch-pro-bluetooth.yaml`, `wii-u-pro.yaml`, `generic.yaml`).
2. Press while tracking the controlled camera ⇒ cancel (with `stop()`); press while suspended ⇒ resume; press with no session ⇒ no-op (no error).
3. The binding is edge-triggered (`risingEdge`) and appears in the activity log with the existing context style.
4. No change to existing chords or `emergencyStop` behavior.
5. Mapping name/default added to `MappingSchema`; existing `mappings.yaml` without the new key still loads.

## Tests / evaluation
Smoke via `virtualController`: toggle/cancel/resume/no-op; existing chord regression assertions still pass. `pnpm build`; `STATUS_PORT=<free> pnpm test:smoke`. Real-pad verification is manual-only (see testing guide).

## Out of scope / data safety
No "start tracking" from the pad (needs a pointer) — cancel/resume only. No new controller profile work. Do not commit local edits to `config/mappings.yaml`.


---
Source: click-to-track plan (`docs/ai/current-plan.md`, issue ID T11). Plan docs are local to the working tree until committed.


### #34 — tracking: Latency calibration + gain tuning tool

URL: https://github.com/ajhochy/fps-camcontrol/issues/34

State: OPEN; updated: 2026-09-30T21:39:56Z

**Labels:** `feature`, `tracking`, `tooling` · **Size:** M · **Depends on:** #26, #31 · **Plan:** `docs/ai/current-plan.md`

## Goal
Measure the real command-to-visible-motion delay of the rig and turn it into recommended `pipelineDelayMs` / gain values, so tuning is evidence-based instead of guesswork.

## Context
End-to-end delay = Sony live-view latency + polling + sidecar + WS + control tick + BLE + gimbal response. The simulator (#25) needs a realistic delay number, and the control law's latency-aware gain depends on it. The gimbal's live gain (200 vs 80) is also unverified, so velocity→angular-rate is unknown.

## Likely files
- `scripts/tracking-calibrate.ts` (or `.py`; choose by where frame diffing is simplest) and a `pnpm` script
- `src/tracking/` (config hook for `pipelineDelayMs`, `kp`, `kd` if not already in #25/#26)
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


---
Source: click-to-track plan (`docs/ai/current-plan.md`, issue ID T12). Plan docs are local to the working tree until committed.


### #35 — tracking: Live verification runbook, docs, and project-state update

URL: https://github.com/ajhochy/fps-camcontrol/issues/35

State: OPEN; updated: 2026-09-30T21:39:57Z

**Labels:** `docs`, `tracking`, `verification` · **Size:** S (plus human time) · **Depends on:** #23–#34 · **Plan:** `docs/ai/current-plan.md`

## Goal
Make the feature safely operable: a written runbook, updated project memory, and a recorded human-run safety drill before anyone uses tracking live.

## Likely files
- `docs/tracking.md` (new: setup, config, sidecar launch, operating guidance, limits)
- `docs/ai/testing-guide.md`, `docs/ai/repo-map.md`, `docs/ai/architecture.md`, `docs/ai/project-state.md`
- `docs/ai/runs/<date>-tracking-live-verification.md` (new)
- `README.md` (short pointer)

## Acceptance criteria
1. `docs/tracking.md` covers: prerequisites, sidecar setup/launch, config block, mapping a Sony camera to a gimbal, speed cap guidance, what tracking is good for (single subject, secondary angle) and not, known limits.
2. Testing guide lists every new check command (`tracker-sidecar` unittest, sim, smoke additions) and the manual-only items.
3. Architecture/repo-map reflect the new `tracker-sidecar/`, `src/tracking/`, and the tracking data flow.
4. **Human-run drill recorded** with pass/fail per step, operator watching video, gimbals powered and within good BLE range:
   - small-deflection check of gimbal gain first (existing unverified risk);
   - track at the default cap (0.35);
   - stick override; resume only via explicit action;
   - emergency stop during active tracking;
   - kill the sidecar mid-track ⇒ gimbal stops within ~0.5–1 s;
   - walk the gimbal out of BLE range / power it off ⇒ session ends, no runaway on return;
   - Sony preview goes stale ⇒ stops;
   - target leaves frame ⇒ stops, holds, goes idle;
   - 30-minute idle soak and 30-minute active-tracking soak.
5. `project-state.md` updated via `project-state-updater` (what shipped, what is unverified, LAN-exposed control route risk, follow-ups).
6. Follow-up issues filed locally for the out-of-scope list in the plan.

## Tests / evaluation
Docs review plus the human drill. Automated baseline re-run: `pnpm build`, `STATUS_PORT=<free> pnpm test:smoke`, `python3 -m unittest discover -s tracker-sidecar/tests`, `python3 -m unittest discover -s pi-bridge/tests`, `node scripts/check-page-js.cjs`, `git diff --check`.

## Out of scope / data safety
No new features. Run notes must not embed screenshots or footage showing identifiable people; use test subjects who consent or redacted captures.


---
Source: click-to-track plan (`docs/ai/current-plan.md`, issue ID T13). Plan docs are local to the working tree until committed.


### #50 — electron: Tracker sidecar packaging

URL: https://github.com/ajhochy/fps-camcontrol/issues/50

State: OPEN; updated: 2026-09-30T23:28:04Z

# E11 — Tracker sidecar packaging

**Size:** L · **Depends on:** tracking #29–#31, #47 · **Plan:** `docs/ai/plans/2026-09-30-electron-wrapper.md`

## Goal
python-build-standalone + pinned wheels, model fetch w/ checksum/resume

## Likely files
`resources/python/`, `electron/`

## Tests / evaluation
Offline-after-first-run start; checksum failure handled; size recorded

## Notes
- Decisions D1–D6 are resolved in §3 of the plan (Sony not shipped, Tailscale remote access, open source, Apple Silicon only, GitHub Releases).
- If scope grows beyond this issue, file a follow-up instead of expanding it.
- Data safety: no credentials, Sony approvals/pairing material, or camera frames in logs, fixtures, diagnostics, or release assets.
