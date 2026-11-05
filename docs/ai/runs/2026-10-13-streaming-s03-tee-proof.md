# Streaming S03 (#66) — static tee/fifo proof — 2026-10-13

Worktree `fps-camcontrol-stream`, local `stream-work` -> `feat/streaming-s1-media-proof` (draft PR #90), base main `ce16149`. Synthetic evidence on a developer runtime only (Homebrew FFmpeg 8.1.2, VideoToolbox, no DeckLink). Not pinned/packaged (#65), not physical (#63/#64), not YouTube. Live app, services, hardware, capture devices and ports 8080/8181 were not touched; receiver is a local `ffmpeg -listen 1` on 127.0.0.1:19351.

Decision: [2026-10-13-streaming-session-architecture.md](../decisions/2026-10-13-streaming-session-architecture.md) (static tee/fifo; S1 Node TS relay superseded). Full numbers: [results JSON](2026-10-13-streaming-s03-tee-proof-results.json) (`overallPass: true`, all scenarios incl. one negative control).

## Reproduce

```
pnpm build
CAMCONTROL_NO_CONTROLLER=1 node dist/testing/broadcastTeeProof.js --all --summary docs/ai/runs/2026-10-13-streaming-s03-tee-proof-results.json   # ~5 min, serial
CAMCONTROL_NO_CONTROLLER=1 node dist/testing/broadcastTeeProof.js --scenario <baseline|reconnect|reconnect-late-phase|stall-sweep|initialRecordingFailure|recordingViaInheritedFd|recordingFailureMidSession> [--keep]
CAMCONTROL_NO_CONTROLLER=1 node dist/testing/broadcastPipelineTest.js --soak-smoke    # 30 s smoke of the S1 soak runner (the 60-minute soak stays deferred)
CAMCONTROL_NO_CONTROLLER=1 node --test --test-concurrency=1 -r ts-node/register/transpile-only tests/broadcast/*.spec.ts
```

Media goes to an `os.tmpdir()` directory that is deleted on exit (`--keep` retains it). All FFmpeg children run under `nice -n 15`; every session is <= 36 s wall at 640x360/30; scenarios never run in parallel. The harness refuses non-127.0.0.1 publish URLs, >720p, >30 fps and >90 s.

## How the proofs measure

- Recording: ffprobe packet times (frame count vs `-t`, gaps over 2 video frames / 3 AAC packets), full decode with `-v error` (error line count).
- Receiver: stdout of the local receiver is an FLV stream parsed in Node; every tag is wall-clock stamped on arrival. Received video packets are matched to recorded packets by MD5 of the encoded access unit, giving exact drop ranges, key-frame-at-resume checks and per-frame age on arrival (arrival wall minus recorded pts, relative to steady state; reconnected segments subtract the receiver's measured ~1.2 s probe latency).
- Stall: SIGSTOP/SIGCONT on the receiver (connected but not reading). Endpoint loss: SIGKILL the receiver (port refuses until restart).
- Encoder back-pressure: FFmpeg `-stats_period 1` lines (wall vs media time).
- Channels: decode to f32le stereo, Goertzel at 440/1000 Hz per 100 ms window per channel.
- Recording failure mid-session: `ulimit -f` with SIGXFSZ ignored (EFBIG on write). Memory: `ps rss` of the FFmpeg child once per second.

## Results summary

See the ADR table. Headlines: recording 1020/1020 frames with 0 gaps across a 7.8 s and a 10 s endpoint outage; reconnect 0.13-0.20 s after the endpoint returns, first media at the next key frame 1.2-1.3 s after, nothing stale replayed; stalled publisher with a 60-packet fifo never blocks the encoder (RSS 47.4 -> 48.1 MB), while the no-drop control lags the whole session 6.95 s; channel tones intact; initial recording failure prevents publish only with `onfail=abort`, so the product uses a supervisor-opened `/dev/fd` recording descriptor with `onfail=ignore`.

## Commands/results of this change

- `pnpm build`: pass. `tests/broadcast/*.spec.ts`: 9/9 (3 pre-existing + 6 new: tee args contract, FLV tag reader).
- `broadcastTeeProof --all`: pass (3 full runs while iterating; the committed JSON is the final run). Two earlier iterations were discarded after harness defects (receiver probe latency inflating ages; receiver readiness polling stuck after accept); no assertion was weakened.
- `broadcastPipelineTest --soak-smoke` (30 s, 720p, 29.97 fps, delay 3, includes SIGKILL recovery): pass.

## Limits / not claimed

Synthetic only; one developer machine; 30 fps/2.5 Mbps; no TLS/RTMPS; no YouTube; no DeckLink; loopback kernel buffering is not representative of a WAN; stderr message text is runtime-specific. The 60-minute soak, MP4 forced-termination timing, pinned runtime and rig qualification remain open (#65, #67, #86-#89). This note does not close #66.
