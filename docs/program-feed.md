# Live program feed (iPad PGM pane)

The switcher's PROGRAM output is fed into a capture device on the Mac Studio in the broadcast rack that runs CamControl.
With the feed on, the iPad's **PGM pane only** shows that real program picture (lower thirds and all) instead of the
program camera's Sony live view; PVW and the small panes keep their Sony views. Off by default.

**Requirements (on the Mac Studio, not a laptop):** ffmpeg (`brew install ffmpeg`, used from `/opt/homebrew/bin/ffmpeg`
when `ffmpegPath` is plain `ffmpeg`) and a capture device. The first capture makes macOS ask for **camera permission
once**, for the process that runs CamControl: Terminal (run by hand), the launchd login service, or the Electron app.
Until it is granted, or when the device is missing, `GET /api/program/status` → `error` carries the ffmpeg stderr tail,
so the iPad's ☰ menu shows why.

**Enable:** iPad ☰ menu › Program feed › **Live**, then pick the capture device (needs remote control on); or in devices.yaml:

    program: { enabled: true, input: "UltraStudio Recorder 3G" }   # optional: kind, formatCode, fps (10), width (960), ffmpegPath

`input` is the device **name** (exact, then case-insensitive substring), re-resolved at every start because
AVFoundation indices shift when a camera is plugged in. `kind` is `avfoundation` (UVC cards: Elgato, Magewell) or
`decklink` (Blackmagic); left out, it follows the device found, or the name (DeckLink / UltraStudio / Intensity).
ffmpeg starts on the first frame request, stops after 15 s with no viewer, restarts with 1 s → 30 s back-off, and
never outlives the app.

**Routes:** `GET /api/program/status` `{enabled, device, kind, running, fps, lastFrameAgoMs, error}` ·
`GET /api/program/devices` `[{index, name, kind}]` · `GET /api/program/formats` (DeckLink modes) ·
`GET /api/program/frame` (latest JPEG; 409 off, 503 none within 4 s) · `PUT /api/program` `{enabled?, input?, kind?}`
(saved to devices.yaml; an iPad write is refused while remote control is off). No MJPEG stream route: the page polls frames.

## Blackmagic (DeckLink) capture

The rack's UltraStudio Recorder 3G is a DeckLink device, not AVFoundation. Blackmagic **Desktop Video** must be
installed. Homebrew's ffmpeg has **no** DeckLink support (the status error says so and the feed stays stopped). Build
ffmpeg with the Blackmagic DeckLink SDK (download it yourself from Blackmagic; it is not redistributed), e.g. the
`homebrew-ffmpeg/ffmpeg` tap with `--with-decklink`, set `program.ffmpegPath` to that binary, and check with
`ffmpeg -sources decklink`. `program.formatCode` (e.g. `Hp30`, see `/api/program/formats`) pins the video mode.

The Mac also has NDI Tools and Wirecast, so an NDI or virtual-camera route is a possible alternative — **not implemented**.

Sandbox: `CAMCONTROL_FAKE_PROGRAM=1` (set by `pnpm sandbox` and the self-test) serves an SVG test frame with a lower
third while the fake ATEM's key is up; no ffmpeg runs.
