# DeckLink capture helper + real UltraStudio capture — 2026-10-15

Worktree `fps-camcontrol-stream` (branch tracking `feat/streaming-s1-media-proof`, draft PR #90), parent `b5b78c1`, evidence is for the commit that adds this note. Results JSON: [2026-10-15-decklink-capture-helper-results.json](2026-10-15-decklink-capture-helper-results.json). Design and transport rationale: ADR addendum in [2026-10-13-streaming-session-architecture.md](../decisions/2026-10-13-streaming-session-architecture.md).

Environment: Mac Studio, macOS 26, Blackmagic Desktop Video 14.2, UltraStudio Recorder 3G, DeckLink SDK 14.2 (at `~/Developer/blackmagic-sdk/`, referenced only through `DECKLINK_SDK_DIR`), Homebrew FFmpeg 8.1.2 (gpl, videotoolbox, no decklink), clang arm64. Live app, launchd services, `~/Developer/fps-camcontrol-live`, :8080/:8181, ATEM, cameras and Pis were not touched; no driver/Desktop Video setting changed; no download; no streaming off-host (receiver is a local 127.0.0.1 `ffmpeg -listen`).

## Build and run

```
# SDK-free (CI): synthetic producer only
make -C native/decklink-capture && pnpm capture:test
# real card (SDK referenced in place, never copied)
DECKLINK_SDK_DIR="$HOME/Developer/blackmagic-sdk/Blackmagic DeckLink SDK 14.2" pnpm capture:build
native/decklink-capture/build/camcontrol-capture --list-devices                 # JSON on stdout, read-only
native/decklink-capture/build/camcontrol-capture --duration 20 | ffmpeg -f matroska -i pipe:0 ...   # or use src/broadcast/decklinkCapture.ts
pnpm build && node dist/testing/decklinkCaptureRun.js --synthetic --seconds 10 [--loss 3:2[:nosignal]]
pnpm build && node dist/testing/decklinkCaptureRun.js --real --seconds 20 --json <file>              # refuses if Wirecast is running; <= 30 s; nice; deletes media
```

Options: `--device N|NAME`, `--mode` (fallback when nothing is detected, default 1080p30), `--detect-timeout`, `--channels 2|8|16`, `--sample-bits 16|32`, `--queue-frames`, `--duration`, `--output FILE|-`, `--synthetic`. Exit codes 0 clean, 2 usage, 3 no driver/device, 4 busy/enable failed, 5 input format changed, 6 write failure. Status/events are JSON lines on stderr (`status` each second, `event`, `error`, `exit`).

## Real capture (hardware, 20 s, serial, under `nice -n 15`)

Gates: `pgrep -il wirecast` empty; device `busy_flags` 0 before the run. Pipeline: helper -> single FFmpeg (`captureTeeArgs`: h264_videotoolbox 6000k, AAC 128k) -> tee { MP4 hybrid_fragmented slave 0, fifo/FLV publisher slave 1 to the local sink }. Media deleted after verification (nothing committed).

| Check | Result |
| --- | --- |
| Detected input | 1080p30, `format-detected` after 1.7 s; YCbCr 4:2:2 10-bit flag; helper requested 8-bit UYVY and the card converted |
| MP4 video | h264 1920x1080, `r_frame_rate` 30/1, yuv420p, progressive, bt709 tagged |
| Frames | 601 for 600 expected (+0.17 %), helper `frames_in` 579 at last status (+ final second); filler 0, dropped_backpressure 0, dropped_late 0, max writer block 0 ms |
| Decode | `ffmpeg -v error -xerror` over the MP4: 0 error lines |
| Timestamps | video dts strictly increasing, first pts 0.000 s, last 20.021 s, max gap 54.7 ms (same encoder start artifact as the #66 baseline); audio strictly increasing, max gap 21.3 ms, last dts 20.053 s |
| Audio track | present: AAC 48 kHz stereo, 941 packets (silent: the input has no embedded audio) |
| Local RTMP sink | connected, FLV 601 video / 941 audio tags, both monotonic, 11 key frames (2 s GOP) |
| Rates | pipe about 115 MB/s (2.41 GB in 21 s of UYVY), signal 30 fps measured |
| Exit | helper 0, ffmpeg 0 |

Audio facts: the card delivers 48 kHz 32-bit stereo packets even with nothing embedded; they decode as digital silence (volumedetect max -90.3 dB; status peak about -97.6 dBFS), so `audio_packets` is true while `audio_present` (peak above -90 dBFS) is false. Picture confirmed by decoding one frame (readable slide, correct colours); the frame was deleted.

Other real-card observations (4 s probes, deleted): `--detect-timeout 0` starts the container with black filler (26 filler frames, `signal locked:false`), then real frames take over at 0.98 s: 119 frames over 4 s with uniform 33.33 ms packet spacing and monotonic pts (filler -> real handoff works on hardware). A format-change callback with the same mode does not re-enable the input (no loop).

## Synthetic evidence (no card)

- `make -C native/decklink-capture test`: `mkv_test` ok; `synthetic_e2e.sh` 19/19 (exit codes, 4 s = 121 frames, 1920x1080 uyvy422 30/1, container decodes clean, pcm_s32le 48 kHz stereo, 720p5994 header, SIGTERM clean with exit line, EPIPE exit 0, backpressure dropped 116 frames during a 4 s reader stall with RSS about 40 MB and block time reported).
- `tests/broadcast/decklinkCapture.spec.ts`: parser, health reducer, argument/profile contracts, helper -> ffmpeg -> MP4 + local RTMP 6 s (241/240 frames at 8 s, decode clean, monotonic), and signal loss (`stall` and `nosignal`, 2 s loss in 7 s): timeline continuous within +-2 % frames, max gap under 120 ms, signal events true,false,true, 50+ filler frames.
- Validation: `pnpm build`; `tests/broadcast/*.spec.ts` all pass (16); every `dist/testing/*Test.js` except smokeTest passes (broadcastPipelineTest takes about 6.5 min; trackingIntegrationTest reports UNVERIFIED and exits 1: no bundled Python runtime, same as before); `pnpm sandbox:check` 279/279 and `pnpm test:smoke:isolated` passed 279, both under the sandbox lock.

## SDK redistribution findings

See the ADR addendum: `/Mac/Include` (headers + `DeckLinkAPIDispatch.cpp`) is exempt from EULA clauses 1, 4.3, 4.4, 5, 7, 8; the helper links nothing else from the SDK and `dlopen`s the installed `DeckLinkAPI.framework`. The SDK itself may only be sub-licensed in full (clause 1.4), so it is neither vendored nor packaged; "DeckLink" is a Mark (clause 6) usable only as "compatible with / for Blackmagic Design DeckLink". Warranty disclaimed. Needs AJ/Blackmagic confirmation before a public release ships the compiled helper. `.gitignore` excludes `native/decklink-capture/build*/`, `blackmagic-sdk/`, SDK folders and `DeckLinkAPI*` files.

## Not done / remaining

- Embedded audio, L/R mapping and A/V offset with real audio (no embedded audio on the input today); real cable-pull / signal-loss and device-disconnect on the card (only synthetic loss and the detect-timeout filler handoff were exercised on hardware); format change mid-session on hardware (exit 5 path is code-only).
- #65 pinned FFmpeg + delivery manifest (helper path is a developer build); #67 MP4 finalization on forced kill and #68 delay offsets through this path; re-run `broadcastTeeProof` against the capture command at production bitrates; interlaced policy; helper packaging/signing for the app.
