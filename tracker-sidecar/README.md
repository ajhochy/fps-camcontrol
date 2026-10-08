# FPS tracker helper

Python3.12, loopback-only, authenticated v1 WebSocket metadata. Production uses
the bundled interpreter and pinned model; users need no Python, pip, compiler,
download or host packages. Mock mode imports no NumPy/Pillow/ONNX Runtime.

## Run and test

Use the package-owned Python. For the implementation checkout:

```sh
dist/tracking-runtime/python/bin/python3 -I -B -m unittest discover -s tracker-sidecar/tests -v
TRACKER_TEST_MODEL="$PWD/dist/tracking-runtime/models/object_detection_yolox_2022nov.onnx" \
  dist/tracking-runtime/python/bin/python3 -I -B -m unittest discover -s tracker-sidecar/tests -v
```

The second command runs actual ONNX inference on two generated synthetic images;
zero person detections are valid and are **not detection-accuracy proof**.
Actual physical Sony/gimbal calibration, video latency, identity reliability and
30-minute tracking soaks remain separate human verification.

The supervising parent supplies `TRACKER_WS_TOKEN`, `TRACKER_FRAME_TOKEN` (two
distinct random secrets, each at least32 characters) and
`TRACKER_BACKEND_ORIGIN=http://127.0.0.1:<backend-port>`. Do not put credentials
in arguments, URLs or logs. Launch `python -I -B tracker-sidecar/main.py --source
live --port 0 --model <absolute-bundled-model>`. The actual bound port is reported
as one stdout line: `{"type":"ready","protocol":1,"port":12345,"pid":123}`.
Write `heartbeat\n` to stdin every500ms. EOF, malformed input or a3-second gap
stops the helper; an independent watchdog forcibly exits only this process if
native inference prevents graceful shutdown. Never use PID discovery.

For developer mock sessions, use `--source mock --trajectory stationary|sine|exit-frame`
and the same credentials. An interactive terminal may explicitly use
`--no-parent-watchdog`; packaged launches must never use this flag. The naked
historical `python3 ... --source mock --port7900` example now also requires the
credential environment because unauthenticated packaged tracking is prohibited.

The parent passes `--reacquire-ms` (100..5000, default1000) and `--lost-hold-ms`
(0..30000, default3000) from validated tracking configuration. Use the same values
for developer live runs. Prediction lasts at most reacquire-ms; it never refreshes
the real frame timestamp, so the backend's500ms freshness stop remains stricter.
Lost-hold starts at loss onset and limits appearance-checked reacquisition; timeout
wipes the target. The JSON protocol does not carry these process-wide options.

The WebSocket client uses `Authorization: Bearer <TRACKER_WS_TOKEN>` and no
Origin header. Browser origins and uncredentialed connections are rejected.
Send hello, then configure, then select a new UUID session. Heartbeat with ping
every1 second; matching pong deadline3 seconds. Configure/disconnect/cancel wipes
target state; stale-session cancel cannot cancel a newer lock. No target is
replayed. The exact wire shapes are in the committed implementation handoff.

Frame GET uses only the separate frame-only bearer credential, an exact backend
origin and generated `/api/sony/cameras/<id>/live-view/frame` route. Redirects,
proxies, other routes, oversized bodies/pixels and invalid timestamps fail closed.
One HTTP request per source, including across canceled sessions; busy/error
backoff and capturedAt duplicate skipping preserve the browser's Sony lane.
Missing capturedAt falls back to receipt time and marks degraded timing.

## Model and licenses

Build tooling stages the exact audited model/runtime from its verified cache.
For an explicit developer download only:

```sh
python3 tracker-sidecar/fetch_model.py
```

This fetches the immutable HTTPS model to git-ignored `tracker-sidecar/models/`,
checks exact size/SHA256, then atomically promotes a bounded partial file. Runtime
never invokes this script and never downloads silently. A missing/corrupt model
keeps tracking unavailable; it must not prevent manual control in the parent.
See `THIRD_PARTY_NOTICES.md` and the exact hashed ARM64 wheel closure in
`requirements.lock`. Preserve complete upstream/native notices when packaging.

## Privacy and limits

No source frames, crops, histograms, detections or target coordinates are written
to disk or logs. WebSocket geometry is transient control metadata only. Metrics
contain only counts/timings and are emitted at most once per source per second.
Appearance exists in memory and is overwritten on cancel/idle/disconnect. This
coarse color-histogram tracker deliberately chooses loss over ambiguous identity
swaps; it cannot establish person identity or guarantee physical tracking safety.
Predictions retain the last genuine frame timestamp, never refreshing liveness.
