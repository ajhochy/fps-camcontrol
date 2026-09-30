# T8 — Sidecar frame ingest + person detection

**Labels:** `feature`, `tracking`, `python`, `vision` · **Size:** L · **Depends on:** T2, T7 · **Plan:** `docs/ai/current-plan.md`

## Goal
Pull live-view frames from the app's own endpoint, decode them, detect people, and report detections with correct capture timestamps and measured latency.

## Context
- Frame source: `GET http://127.0.0.1:<STATUS_PORT>/api/sony/cameras/<id>/live-view/frame` (JPEG) with `X-Frame-Captured-At` (T2). The URL arrives via `configure`; the sidecar has no Sony knowledge.
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
No locking/association (T9). **Never write frames, crops, or detections to disk or logs** (only counts/timings). Test images must be synthetic (generated shapes), not real people.
