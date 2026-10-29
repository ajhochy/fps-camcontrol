# Streaming S05 (#68): video content delay and A/V offset through MP4 and streaming - 2026-10-22

Evidence: [results JSON](2026-10-22-streaming-s05-delay-results.json), [real-audio data](2026-10-22-decklink-audio-qualification.json) (for #64). Harness `src/testing/delayProof.ts` (analysis `src/broadcast/mediaAnalysis.ts`); source = helper `--synthetic --synthetic-impulse`: a white flash frame and a 5 ms 1 kHz click on both channels at the SAME stream time every 2 s, plus a burnt-in 24-bit frame counter. Pipeline = helper -> ONE FFmpeg (`captureTeeArgs`, delay applied once before the encoder) -> tee: MP4 (slave 0) + fifo/FLV to a local 127.0.0.1 sink. Offsets are measured from DECODED content in the MP4 and in the FLV the sink received: flash-frame rising edge (decoded luma, original timeline `-copyts`) minus click onset (first decoded sample > 0.3 FS), per event. Developer FFmpeg 8.1.2 (pinned runtime is #65, open). #68 stays open (see Open).

## Mechanism chosen: `tpad=start=N:start_mode=add:color=black` after `fps=<rational>`

| Mechanism | Result |
| --- | --- |
| `tpad` (N black frames in front, same origin for both outputs) | every event after the first AND the first: delay exact in both outputs (table below) |
| `setpts=PTS+(N*den/num)/TB` (positive PTS offset) | later events correct, but the muxers start the track at 0 and hold the first picture, so the FIRST event is early by N frames (flash-click -21.33 ms instead of +100 ms at N=3; +500 ms expected at N=15 measured -21.33 ms): rejected, as the plan warned a positive PTS offset is only a candidate |

Delay is ONE filter in front of the single encoder, so MP4 and FLV inherit it identically (`captureTeeArgs`, `videoDelayFilter`; 0-15 integer frames, anything else throws; unit-tested including 30000/1001 and 60000/1001).

## Content delay, 30/1 and 30000/1001 (`tpad`, 1080p, 16 s runs, 8-9 events each, all within one frame)

| Rate | delay | expected | MP4 flash-click (every event) | FLV flash-click |
| --- | --- | --- | --- | --- |
| 30/1 | 0 | 0 | 0.02 ms (event 1: -21.33, see below) | -0.33 ms |
| 30/1 | 1 | 33.333 ms | 33.35 ms | 32.67 ms |
| 30/1 | 3 | 100 ms | 100.02 ms | 99.67 ms |
| 30/1 | 15 | 500 ms | 500.02 ms | 499.67 ms |
| 30000/1001 | 3 | 100.1 ms | 100.10 ms | 99.67 ms |
| 30000/1001 | 15 | 500.5 ms | 500.50 ms | 500.67 ms |

Errors are <= 0.7 ms (0.02 frame). The FLV differs from the MP4 by -0.33 ms: FLV timestamps are integer milliseconds (video ts 21 vs 21.33 ms). The only outlier is event 1 of the MP4 at delay 0 (-21.33 ms, 0.64 frame): the first picture (the flash itself at stream time 0) is shown from container time 0 while the click, delayed by the AAC priming shift, sounds at 21.3 ms; it is the first-sample hold below, inside one frame.

Beginning/middle/end: all events (8-9 per 16 s run; 31 in the 60 s run) carry the same offset, so there is no start-up or tail bias.

Reconnect: the publisher sink killed at 35% and restarted at 55% of the run (down at 8.4 s, back at 13.2 s of a 24 s run): delay 3, segment 2 (after reconnect) 100.00 ms; delay 15, segment 2 500.00 ms (expected 100/500). A new FLV segment starts with timestamps restarted (video 0, audio 0.016 s) and a key frame; relative A/V timing is preserved. The MP4 is unaffected (13 events, 100.02 / 500.02 ms).

Drift: 60 s run, delay 3, 31 events: MP4 100.02 ms on every event, FLV 99.67 ms on every event, fitted slope 0 ms/s. The synthetic source takes video PTS and the audio sample counter from one monotonic clock, so this proves the FFmpeg/mux path adds no drift over 60 s but says nothing about the card's video/audio clocks; the 60-MINUTE acceptance run was not executed (<= 60 s synthetic rule) and no extrapolation is claimed.

## Common origin, rational conversions, pacing, mux limits

- Origin: FFmpeg's MP4/FLV muxers start all streams at the most negative timestamp (AAC priming = -1024 samples = -21.333 ms at 48 kHz). MP4: both tracks start at 0, video samples after the first are +21.33 ms and the first picture is held 54.7 ms (fragmented MP4 writes no edit list); FLV: audio ts 0, video ts 21 ms. Audio content and video content shift together, so A/V is preserved; the whole recording is 21 ms later than the helper's origin. This is an inherent AAC property, no correction applied.
- Rationals: delay seconds = frames x den / num, exact in the filter timebase (integer frame count; `fps` filter output timebase is the frame period). 1/3/15 frames = 33.3333/100/500 ms at 30/1, 33.3667/100.1/500.5 ms at 30000/1001 (measured), 16.6833/50.05/250.25 ms at 60000/1001 (arithmetic and unit tests only; no 60000/1001 hardware or media run is claimed: `captureTeeArgs` still refuses that rate).
- Frame pacing: `fps=<rational>` in front of the delay; the burnt-in counter is sequential in all MP4s (one repeat of frame 0 at the start, no drops or duplicates elsewhere).
- Mux buffers: the delay is realised physically by the interleaver holding video until audio reaches its DTS: capture-to-local-sink latency of the flash (helper impulse line -> FLV tag at the sink, includes helper queue/pipe, demux, filter, VideoToolbox encode, tee/fifo/flv, loopback TCP and the sink ffmpeg) is a steady **302 ms median at delay 0** (299-305 ms), **370 ms at 3**, **670 ms at 15** (event 1 is inflated to 1.5-1.6 s by the receiver's input probing; the last event of each run reports about 19 ms, an unexplained pairing artefact kept in the JSON). The queue holds at most delay x bitrate (about 0.4 MB at 6 Mbps and 0.5 s) plus audio, far below `max_muxing_queue_size` 128 packets; no drop, no stall observed.

## Real capture path (UltraStudio Recorder 3G, program video + real embedded audio, Wirecast closed)

Two 20 s runs (delay 0 and 3, `tpad`), kept briefly for analysis, deleted:
- Pipeline alignment identical to the synthetic one: MP4 video pts 0.000, 0.055, 0.088, 0.121 ...; FLV 0.021, 0.054, 0.088, 0.121 ...; audio starts 0 in both.
- Delay 3 on the real picture: three black pad frames (luma 16) then the real picture (luma 108) in BOTH MP4 and FLV, picture cuts at identical times in the two outputs (for example 0.121 s and 3.255 s vs 3.254 s).
- Helper health: frames_in == frames_out, filler 0, dropped_backpressure 0, queue_depth 0/12, audio resyncs 0; `source_age_ms` (card frame age at delivery, last status line of each real run): 4, 9, 16, 22, 23 and 29 ms in six runs. One 95 ms stdout block seen in one run.
- **True lip-sync is NOT measured: there is no usable reference.** The program audio is continuous (50 ms RMS -47..-28 dBFS, no sharp onset); the picture changes by periodic cuts at about 5.07 s (4.688, 9.755, 14.921, 19.988 s) with no clap or click aligned to them. The real A/V offset through MP4/FLV remains OPEN until a source with a sync reference (clapper, flash+beep, or a lip-sync test clip on the switcher) is available. The synthetic proof shows the FFmpeg/mux path preserves a known offset; it does not prove the card's audio/video offset.

## Audio qualification evidence (for #64)

Helper status: `audio_present` true (peak -31..-19.8 dBFS), 48 kHz. Decoded MP4 and the received FLV are identical per channel. A 16-channel source capture (5 s): channels 1 and 2 carry the program (peak -19.8 dBFS, RMS -38.7 dBFS each), channels 3-12 are digital silence, channels 13-16 only a noise floor (-84 dBFS peak). **Channels 1 and 2 are effectively the same signal**: correlation 0.99997, max |L-R| 0.0006 FS at the source (0.017 FS after AAC), side/mid -43.6 dB: dual mono, not distinct stereo and not swapped. Left/right independence, a swap or one-sided loss cannot be proven from this content; re-check with a stereo source.

## Open

True real-source A/V offset (needs a sync reference); 60-minute drift on the rig and the card's own audio/video clock drift; 60000/1001 and other rates on hardware; the qualified rig rate other than 1080p30; hosted/installed evidence; re-run on the pinned FFmpeg (#65); behaviour at publisher reconnect on the real rig (reconnect proven synthetic, local sink only).
