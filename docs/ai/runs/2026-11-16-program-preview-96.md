# 2026-11-16: PGM preview from the shared program capture (#96)

Branch `feat/streaming-s1-media-proof` (draft PR #90). Nothing deployed; the live app and its configuration were not touched.

## What changed

- `src/program/programMonitor.ts`: the always-on monitor encoder, an `auto` consumer of the capture service (#95). Pinned FFmpeg → MJPEG at `program.fps`/`program.width` (default 10 fps, 960 px); only the latest JPEG is kept. A frame is served only while the capture reports a locked signal and the JPEG is under 1.5 s old; otherwise `reason()` says why (no signal, restarting, card busy / missing / not responding, no FFmpeg runtime, waiting).
- `ProgramFeed` delegates to it while `programCapture.enabled` (`kind: 'capture'`); `/api/program/*` is unchanged in shape. The frame route answers 409 only when the effective feed is off.
- Legacy paths: on macOS 26 (Darwin 25) DeckLink devices and Blackmagic-named AVFoundation devices are refused with a reason (no FFmpeg path to the card exists there); other AVFoundation devices still work. `docs/program-feed.md` now leads with program capture and marks the rest legacy.
- UI: iPad and phone PGM fetches carry the server's reason and drop the picture at once on a server refusal (network blips keep the 4 s grace); the PGM pane says "Program feed offline: <reason>" (with or without a camera picture to fall back to); the This-iPad row shows "Live program from program capture" instead of the Camera/Live choice. Phone: All cameras leads with the Program pane while the feed is on. Desk: a program picture under the status cards (about 3 fps), hidden while the feed is off, reason in red when there is no picture.
- App: the monitor starts with the capture (and again after a capture settings restart); `CAMCONTROL_CAPTURE_SYNTHETIC=1` (+ `_LOSS`) lets the sandbox use the synthetic helper (ignored when `CAMCONTROL_RESOURCES` is set).

## Evidence

Synthetic:
- `tests/contract/issue-96.spec.ts` 6/6 (three consecutive runs): JPEG frames and `kind: capture` with one monitor consumer; no signal and capture restart answered 503 with the reason and no earlier frame; re-attach after restart; no runtime → reason; capture off → unchanged (409); legacy refusal on macOS 26 while a USB stick still works; **real synthetic helper + pinned FFmpeg**: about 10 fps of 960x540 MJPEG, the picture dropped during a synthetic signal loss and back after.
- Sandbox self-test: 7 new checks (capture switched on through `PUT /api/streaming/capture`, JPEG PGM frames, "No signal on the capture card" as 503 + status, frames return, desk page has the picture, switched off → legacy 409).
- Browser (interactive sandbox, synthetic capture with a 15 s signal loss): desk shows the program picture, then "Program: No signal on the capture card"; iPad PGM pane "Program · BirdDog 1" with the picture, then "Program feed offline: No signal on the capture card" (this exposed a gap: with no camera picture to fall back to, the pane showed the rig text; fixed); phone All cameras leads with the Program pane, picture then reason.

Physical ([report](2026-11-16-realcard-program-preview.json)): Wirecast closed, `busy_flags: 0` before and after. Shared capture on the UltraStudio with the monitor attached for 15 s: **9.98 fps** of 960x540 JPEGs, newest frame never older than 37 ms, monitor consumer 479 frames out with 0 drops, signal locked 1080p30, filler 0; sampled JPEG brightness 146 / 207 / 218 (a changing program picture, not black or bars). JPEGs measured and deleted.

## Open

- The phone/iPad Camera/Live choice still writes `program.enabled` while capture is on (no effect, but the buttons remain tappable).
- A visual check that the picture matches the switcher's program was by brightness only (no footage kept); an operator glance at the desk picture during a service is the remaining confirmation.
- #97 (HLS for TVs) builds on the same capture.
