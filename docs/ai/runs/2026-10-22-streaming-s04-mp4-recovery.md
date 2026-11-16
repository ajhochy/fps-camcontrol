# Streaming S04 (#67): hybrid MP4 close and crash recovery - 2026-10-22

Evidence digest: [results JSON](2026-10-22-streaming-s04-mp4-recovery-results.json). Harness `src/testing/mp4FaultProof.ts`, recovery `src/broadcast/mp4Recovery.ts`, developer write-fault interposer `scripts/mp4-fault/interpose-write.c`, AVFoundation probe `scripts/mp4-fault/avcheck.swift`. Branch `feat/streaming-s1-media-proof` (draft PR #90).

**Scope and honesty.** Runtime: Homebrew FFmpeg 8.1.2 (developer; GPL, shared; the pinned runtime is #65, still open). Capture path: `native/decklink-capture` -> Matroska on the stdin of ONE FFmpeg -> `tee` (MP4 slave 0, fifo/FLV slave 1 to a local 127.0.0.1 sink), exactly `captureTeeArgs`. Real-hardware runs: UltraStudio Recorder 3G, program picture + embedded audio, 1080p30, 6000 kbps VideoToolbox, each <= 20 s, serial, nice, media deleted. Synthetic runs: the helper's `--synthetic --synthetic-impulse` (flash frames + burnt-in 24-bit frame counter) through the same pipe. Not done: manual QuickTime/editor check (AVFoundation, the QuickTime engine, is used as the playability proxy: `isPlayable` true and duration reported), slow-storage runs, OS crash/power loss, real 2-hour recordings, pinned binary, hosted/installed evidence. #67 stays open.

## File layout facts (measured from the byte-level write trace)

- While recording, the file is `ftyp, free, free(44 B placeholder)` (88 B written at open), then at the FIRST fragment boundary `moov (initial, indexes the first fragment) + mdat`, then `moof+mdat` per fragment. FFmpeg issues one burst of writes per fragment, when the NEXT key frame/duration boundary arrives; `flush_packets=1` matters: with it each burst ends with the short remainder write (for example 145,276 B after three 262,144 B chunks), so the complete fragment is on disk when the burst ends; without it every burst is only whole 256 KiB chunks and the fragment's tail stays in the muxer buffer until the next burst (comparison write traces of two otherwise identical 10 s runs).
- Graceful close appends the final regular `moov` and then writes ONE 8-byte header (`write` at offset 44) that turns the placeholder into an `mdat` covering all fragments. A closed file is `ftyp, free, mdat, moov`: a regular MP4 (moov last, no moof, no faststart), verified identical in structure for 2 s, 1 s and 0.5 s fragment modes.
- Writes of the final burst on a real 20 s 1080p run: last fragment + final moov, then the 8-byte patch (`seq 90, offset 44, len 8`).

## Results

### Graceful stop (helper SIGTERM -> FFmpeg EOF -> finalize)
| Run | helper exit | FFmpeg exit | result |
| --- | --- | --- | --- |
| real 1080p30, 20 s | 42 ms after SIGTERM | 63 ms after SIGTERM (21 ms after the helper) | closed regular MP4, 571 video frames / 894 AAC packets, 19.055 s (the first ~0.95 s of wall is helper start/format detection), decode clean, AVFoundation playable, FLV received 571/571 |
| synthetic, 12 s | 23-25 ms | 33-40 ms | closed, 361 frames, 12.055 s, frame counter sequential 0..N with one repeat of frame 0 (see below), playable |

The "repeat of frame 0" is the container common-origin shift, not a dropped/duplicated capture frame: FFmpeg's MP4/FLV muxers start every stream at the most negative timestamp (AAC priming, -1024 samples = -21.333 ms), so video starts 21.3 ms late and the first picture is held 54.7 ms. It keeps A/V content aligned (see S05).

### Finalization cost vs recording length (sample-table equivalent, SIGINT -> exit, local SSD)
6.5 min (11.7k video + 18.3k audio samples): 5 ms; 33 min: 8 ms; 62 min: 13 ms; **122 min (220k video + 344k audio samples, final moov 2.32 MB): 23 ms**; 1280x720 6 Mbps VideoToolbox, 3 min, 123 MB file: 33 ms. All closed, decode clean, AVFoundation playable (7332.12 s for the 2 h file), seek-near-end decode OK. Close cost grows with the sample table (about 19 KB of moov per minute), not with media bytes: no remux, no mdat rewrite. Real 6 Mbps 2-hour recordings (about 5.4 GB) were NOT run (60 s synthetic cap and no production disk filling); the sample-equivalent runs plus the 123 MB run bound the mechanism.

### SIGKILL of FFmpeg mid-recording (real capture and synthetic)
Recovery = remux of the exact complete-fragment prefix (read-only `subfile` input) into a NEW file; original SHA-256 unchanged in every case; incomplete trailing fragment reported (bytes, declared size), never counted.

| Kill at (s of wall) | 2 s fragments (`frag_keyframe` only): recovered | 0.5 s fragments (`+frag_duration=500000`): recovered |
| --- | --- | --- |
| 1.5 (synthetic) | nothing persisted (88 B): NO_RECOVERABLE_MEDIA | 1.024 s (lost 0.48 s) |
| 3.0 | 2.027 s (lost 0.98 s) | 2.539 s (lost 0.46 s) |
| 5.9 | 4.032 s (lost 1.87 s) | 5.525 s (lost 0.38 s) |
| 6.1 (just after a boundary: worst case) | 4.032 s (lost **2.07 s**) | 5.525 s (lost **0.58 s**) |
| 9.0 | 8.021 s (lost 0.98 s) | 8.533 s (lost 0.47 s) |
| real 12.1 s | 10.027 s, 300/470 frames/packets, 4 fragments (lost 2.08 s) | 11.541 s, 345/541, 22 fragments (lost 0.56 s) |

Recovered files: decode clean (`-xerror`), AVFoundation playable, burnt-in frame counter sequential (synthetic), A/V origin identical to the original (0 -> 0, both streams), recovery time 34-45 ms for the 6-9 MB real files. "% of media recovered" relative to what the recorder had encoded: the loss is bounded by the fragment length plus encoder latency (about 0.3 s): 2.07 s worst case at 2 s fragments, 0.58 s at 0.5 s. Fragment overhead is negligible (about 0.6 KB per fragment; 1.2 KB/s at 0.5 s).

### SIGKILL of the helper mid-recording
FFmpeg sees EOF on the pipe and finalizes by itself: real (kill at 12.1 s wall) closed regular MP4, 11.121 s, exit 0; synthetic (6.5 s) closed, 6.521 s vs 6.503 s wall (nothing lost). The helper's own death is therefore the benign case; the FLV continues until EOF as well.

### Torn writes and kills during finalization (byte-level, write interposer)
Kill before/mid-write (half the buffer)/after each of the last writes of a synthetic run, plus the final 8-byte header patch on two real 20 s runs. Outcomes (all originals byte-identical after recovery, all recovered files decode clean and counter-sequential):
- torn write inside a fragment (`wf-6-partial`, 4181 of 9174 bytes persisted): the 8.021 s of complete fragments recovered, torn tail reported;
- torn final `moov` (`wf-7-partial`, 2451 of 5649 bytes): every fragment complete, so the FULL 10.055 s (301/472) recovered; the file is not closed;
- final `moov` complete, header NOT patched (`wf-8-before`, real `patch-before`): scanned as `closed-header-unpatched`; both the original and the recovery play, full 10.055 s / real 20.021 s (600 frames) recovered;
- torn 4-byte header patch (`wf-8-partial`, real `patch-partial`): the placeholder becomes `[new size]free`, the file stays a valid regular MP4 (moov last), decodes fully, plays;
- kill before the first fragment (`wf-2-partial`, init + torn first mdat): NO_RECOVERABLE_MEDIA, original preserved, no empty output is created.
Write counts differ run to run; each row's phase is classified from the resulting bytes, and `--on-patch` targets the final patch exactly.

### Mid-session write failure tail (#66 follow-up)
`ulimit -f` makes the recording hit EFBIG: FFmpeg logs `[tee] Slave muxer #0 failed: File too large, continuing with 1/2 slaves.` and exits 0; the stream is unaffected (real: FLV 600/600 video frames after the MP4 stopped at 6,144,000 B; synthetic 421/421). The truncated MP4 recovers all complete fragments (real 10.027 s of 20 s, 300/470), the torn tail reported. The supervisor must therefore NOT rely on the exit code: detect the slave failure line and/or recording-file growth stall, mark the recording failed, keep streaming, and recover at stop.

## Chosen MP4 mode

`f=mp4:movflags=+frag_keyframe+hybrid_fragmented:flush_packets=1:frag_duration=500000:onfail=ignore` (never faststart; `MP4_MOVFLAGS` and `MP4_FRAG_DURATION_US` in `teeArgs.ts`, now the `captureTeeArgs`/`teeMuxSpec` default; 2 s `+frag_keyframe` alone is `--extra none`; 1 s fragments lost up to 1.08 s). Rationale: same closed-file layout, near-zero overhead, SIGKILL loss cut from about 2.1 s to about 0.6 s and recoverability starts at 0.5 s instead of 2 s. Fragments start on non-key frames; recovered/closed files decode clean and counter-sequential, so no extra decoder risk was observed (editor import not tested).

## Teardown policy (derived from the measurements; slow storage unmeasured)

1. Stop = SIGTERM the helper (it stops capture and drains <= 1.5 s); FFmpeg then sees EOF and finalizes. Measured worst: helper exit 42 ms, FFmpeg exit 63 ms after the signal on real hardware, finalization 23-33 ms even for a 2 h-equivalent file.
2. Graceful deadline **10 s** from SIGTERM (about 150x the worst measured close, and 4x the time to write a 2 h moov of 2.32 MB at a pessimistic 1 MB/s), extended in 5 s steps while the recording file is still changing, hard cap 30 s. A helper still alive after 3 s is SIGKILLed (FFmpeg still closes on EOF). At the deadline SIGKILL FFmpeg, then run `recoverMp4` to a separate file and show the recovered duration/loss. These are tunables to be refined with a logged close time on the rig; they are NOT an unmeasured five-second kill rule.
3. App crash/SIGKILL: the orphaned recorder file is preserved; recovery runs on next start into a new `*.recovered.mp4`, original untouched.

## Open

Manual QuickTime Player / intended editor check with receipt hashes; slow-storage and nearly-full-disk finalization (needs throttled/real small volume; no privileged tooling used); OS crash / power loss (no fsync is issued by FFmpeg, so unflushed page cache is lost in that case); real multi-GB two-hour recording and a long soak on the pinned runtime; recovery on the pinned FFmpeg (#65); hosted/installed evidence; verifying frag_duration fragments in the intended editor.
