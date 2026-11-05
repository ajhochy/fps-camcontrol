# 2026-11-05: pinned runtime close-out (#65), always-on capture with fan-out (#95), streaming config and sessions (#69, #70)

Branch `feat/streaming-s1-media-proof` (draft PR #90). Developer Mac (Apple Silicon). All evidence below is **synthetic** (helper `--synthetic`, fake helpers, local files) unless marked **physical**. Nothing was deployed; the live app and the operator's configuration were not touched.

## #65: the pinned FFmpeg 8.1.3 build

- Binary: `~/Developer/ffmpeg-runtime-build-8.1.3/ffmpeg` sha256 `5a9ff1ef…f057`, `ffprobe` `08ffd9c9…faba` (built 2026-10-28 by `scripts/build-ffmpeg-runtime.sh` from the pinned tarballs). `otool -L`: only `/usr/lib` and `/System/Library` dependencies.
- Notices: `scripts/stage-ffmpeg-runtime-notices.sh` copies `LICENSE.md` and `COPYING.LGPLv3` (FFmpeg) and `LICENSE.txt` → `OPENSSL-LICENSE.txt` (OpenSSL) byte-for-byte from the checksum-verified tarballs, plus `THIRD_PARTY_FFMPEG.md` from `scripts/ffmpeg-runtime/`. The build script now runs it. Manifest status `PINNED-BUILD`, all 7 files pinned; `node scripts/probe-ffmpeg-runtime.cjs verify-manifest <dir> --require-pinned` → ok ([manifest-verify.json](2026-11-05-pinned-runtime/manifest-verify.json)).
- Capability probe without `--allow-gpl`: pass ([probe-report.json](2026-11-05-pinned-runtime/probe-report.json)).
- Re-runs with `BROADCAST_FFMPEG`/`BROADCAST_FFPROBE` = the pinned pair (script steps below), results in [2026-11-05-pinned-runtime/](2026-11-05-pinned-runtime/):

| Harness | Result on the pinned binary | Earlier (Homebrew 8.1.2) |
| --- | --- | --- |
| `broadcastTeeProof --all` (#66) | 7/7 scenarios pass (baseline, reconnect, reconnect-late-phase, stall-sweep, initialRecordingFailure, recordingViaInheritedFd, recordingFailureMidSession) | 7/7 |
| `mp4FaultProof` graceful / kill-ffmpeg / kill-helper (#67) | closed / fragmented-open recovered 240 frames (8.02 s of 8.40 s, loss 0.38 s) / closed; all AVFoundation-playable | same shape; kill loss ≤ 0.58 s |
| `delayProof` 0/1/3/15 frames @30/1, 3 @30000/1001, 3 + reconnect (#68) | MP4 mean = expected ±0.02 ms (spread 0; first event of the 0-frame case -21 ms as before); FLV within the 1 ms FLV timebase | same |
| `tests/broadcast/*.spec.ts` | pass | pass |

  `tee-proof.json`'s runtime label was hardcoded to "Homebrew 8.1.2" by the harness; the run used the pinned binary (the harness reads `BROADCAST_FFMPEG`, set by the run script). The label in the saved file is corrected and says so; the harness now records the binary and its `-version` line. The MP4/delay re-runs used the refactored helper in single-output mode (a regression check of the #95 refactor).
- Finding: the manifest's `--enable-protocol=file,pipe,tcp,tls,rtmp,rtmps,subfile` did not narrow anything (FFmpeg only narrows with `--disable-protocols` first): the binary lists http, ftp, udp, unix and more. Not a license issue; a hardening follow-up that needs a rebuild and re-pin.
- Open on #65: installed/signed/notarized evidence (#86); the protocol narrowing rebuild.

## #95: one capture, many consumers

- Helper: `Pipeline` now fans out to `Sink`s (`src/sink.hpp`): per-consumer fd, bounded queue, writer thread, stall timeout, PTS rebased per consumer. `--serve` reads `attach ID FIFO` / `detach ID` on stdin; stdin EOF stops it. Single-output mode (stdout / `--output`) behaves as before. New `--stall-ms`, `--synthetic-format-change SEC`.
- Supervisor: `src/program/captureService.ts` (FIFOs in a private 0700 dir, consumer processes, backoff restarts, stale kill, `auto`/`never` consumers, separate signal/device/process status).
- App: started with the app when `programCapture.enabled` (not in a suspended-input instance), status in `/api/status` → `programCapture`; stopped after sessions on shutdown. `ProgramFeed` refuses Blackmagic devices while capture owns the card.

Evidence (synthetic):
- `make test` in `native/decklink-capture`: mkv unit + `synthetic_e2e.sh` (all pass, unchanged expectations) + new `serve_e2e.sh` (17 checks): consumer a kept **181/180** frames and decoded clean while b never read and was dropped as `stalled` after 1 s; c attached at 2 s and detached at 4 s got **60** frames starting at pts 0; d's reader vanished → `closed`; regular file / duplicate id / junk commands refused; per-consumer stats in status; `consumers_lost: 2`; control EOF → clean exit 0; synthetic format change → exit 5 and consumers ended.
- `tests/program/captureService.spec.ts` (6): attach/stats/detach and no FIFOs left; crash → backoff restarts, `auto` re-attached each time, `never` ended `capture-lost` and stayed ended, no false "lost" counts; busy card and missing device retry with growing backoff; format change restarts at once; wedged helper (no status) killed and replaced; stop escalates to SIGKILL; **real helper + real FFmpeg consumers**: stalled consumer dropped with 0 backpressure on the monitor, late consumer 55–75 frames in ~2 s, helper SIGKILL → restart, monitor re-attached with frames flowing.
- FIFO throughput: 1080p30 UYVY at full rate through one FIFO, 301/301 frames, 0 drops.

Physical: with Wirecast capturing from the UltraStudio (`--list-devices`: `busy_flags: 1`), `camcontrol-capture --serve` reported `device-busy`, exit 4, before enabling the input; Wirecast's capture was undisturbed (`busy_flags` still 1). **The ≤30 s two-consumer real-card run (frame counts within ±2 %, 0 decode errors) is NOT done**: the card was in use by Wirecast. It needs Wirecast closed.

## #69: streaming settings and locks

- `devices.yaml` `streaming:` (enabled, source `program-capture`, profile `1080p30`|`1080p2997`, videoBitrateKbps 2500–12000, recordingFolder, videoDelayFrames 0–15) and `programCapture:` (enabled, device, mode, queueFrames, stallMs); both optional, existing configs load idle/disabled, `program.fps/width` unchanged. Specific per-field errors; unknown profiles are refused, never substituted.
- Routes (loopback only, never `X-Remote`): `GET /api/streaming`, `PUT /api/streaming/config`, `PUT /api/streaming/capture`, `POST /api/streaming/session`, `POST /api/streaming/session/stop`. While a session runs: profile/bitrate/delay/folder/source, capture enabled/device/mode, and the legacy `PUT /api/program` input/kind are refused with `409` naming the fields; preview on/off and queue tuning still save.
- Tee recording paths may now contain inner spaces (verified with the pinned 8.1.3 into `Livestream Recordings/FPS 2026-11-05 1430.mp4`); tee separators, quoting, control whitespace and a trailing space are still refused.
- Evidence: `tests/contract/issue-69.spec.ts` (5, three consecutive passes), `tests/broadcast/teeArgs.spec.ts`.

## #70: sessions attach, never own

- `OutputSessions` (Record only): one encoder consumer with `restart: 'never'`; `MP4` named `FPS YYYY-MM-DD HHMMSS.mp4` in the chosen folder; refuses clearly when disabled, already running, capture down/busy/missing, folder unset/unwritable, runtime missing; Stream + record → 501 until #79–#83.
- Evidence: `tests/contract/issue-70.spec.ts` (5): preview and session on one capture process, removing the preview leaves the session running; `ProgramFeed` never spawns for the card while capture owns it (a non-Blackmagic device still does); status transitions `running/locked/ok → running/absent/ok → running/absent/disconnected → restarting`; no signal keeps the session with `warning: no-signal`; `device_ok: false` ends it `device-lost` with the recording finalized; helper exit ends it `capture-lost`, the capture returns, the session does not; **real helper + real FFmpeg**: Record only into a folder with spaces, a 2 s synthetic signal loss mid-session kept it running with the warning and left no hole (30 video packets per second throughout), Stop gave an h264+aac MP4; a second session ended `capture-lost` on helper SIGKILL with a playable partial MP4 and nothing restarted by itself.
- Open on #70: authorized cable/signal-loss and device-disconnect on the rig.

## Commands

```sh
pnpm build
make -C native/decklink-capture test                     # + DECKLINK_SDK_DIR=... for the real build (not needed for tests)
BROADCAST_FFMPEG=<pinned>/ffmpeg BROADCAST_FFPROBE=<pinned>/ffprobe CAMCONTROL_NO_CONTROLLER=1 \
  node --test --test-concurrency=1 -r ts-node/register/transpile-only tests/program/*.spec.ts tests/contract/issue-69.spec.ts tests/contract/issue-70.spec.ts tests/broadcast/*.spec.ts
# #65 re-runs (each with BROADCAST_FFMPEG/BROADCAST_FFPROBE = pinned pair):
node scripts/probe-ffmpeg-runtime.cjs probe "$BROADCAST_FFMPEG" --json probe-report.json
node scripts/probe-ffmpeg-runtime.cjs verify-manifest <runtime dir> --require-pinned
node dist/testing/broadcastTeeProof.js --all --summary tee-proof.json
node dist/testing/mp4FaultProof.js --scenario graceful|kill-ffmpeg|kill-helper --json mp4-<s>.json
node dist/testing/delayProof.js --delay 0|1|3|15 [--mode-name 1080p2997] [--reconnect --seconds 24] --json delay-<d>.json
node scripts/checks.cjs issue
```

## Verification gate (after the review fixes)

Every `scripts/checks.cjs` step run individually (the runner stops at its first failure): build, page JS, 9 unit suites, helper `make test`, Pi bridge, electron-release, sandbox `--smoke` and `--selftest`, `git diff --check`: pass. Focused tests 146/154, all new suites pass. Pre-existing and identical on clean `45a93c8`: 8 tracking-area failures (issue-23-c4, tracking-sidecar ×4, app-integration ×2, runtime-startup); `tests/tracking/manager.spec.cjs` + `calibration.spec.cjs` fail 16 and never exit; `check-tracking.cjs` needs the staged tracking runtime. An independent review found no high-severity defects; the six lower ones it raised that were real are fixed (attach timeout, startup watchdog, restart/stop race, double close in the refused-attach path, late attach event, auto-consumer retry).
