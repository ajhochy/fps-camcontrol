# T7 — Tracker sidecar skeleton (Python)

**Labels:** `feature`, `tracking`, `python` · **Size:** M · **Depends on:** T5 (frozen protocol) · **Plan:** `docs/ai/current-plan.md`

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
5. The real TypeScript `TrackingClient` (T5) connects to it and the manager (T4) drives `virtualDjiBridge` from its scripted output in one smoke scenario or a documented manual script.
6. No imports of any vision library at this stage.

## Tests / evaluation
`python3 -m unittest discover -s tracker-sidecar/tests -v` covering protocol validation, mock trajectories, and a websocket round-trip. Document the command in `docs/ai/testing-guide.md`. `git diff --check`.

## Out of scope / data safety
No frame fetching, no detection (T8/T9). No launch-supervision UX. A `.venv/` must be git-ignored. No model files or sample footage committed.
