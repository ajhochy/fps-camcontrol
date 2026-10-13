# Live program feed (iPad PGM pane)

> **DECKLINK DRAFT — BLOCKED / NOT READY. DO NOT RUN `scripts/setup-ffmpeg-decklink.sh`
> before driver/SDK compatibility and script safety review.** The instructions below
> are historical preserved material, not current qualification. SDK 16 versus historical
> Studio Desktop Video 14.2 is unresolved; the actual current driver was not checked.
> Prerequisites for later authorized qualification: actual macOS Apple Silicon host,
> Xcode Command Line Tools, and Desktop Video verified compatible with the chosen SDK.
> Major-version matching alone is not a compatibility guarantee. The script has unchecked
> downloads, unsafe version/path handling and fixed scratch-directory cleanup risks.
> Its preview-only build disables network and lacks H.264/AAC encoding: unsuitable for
> streaming. Preserved license/bundling statements below are not independent EULA or
> release qualification. See [receipt](ai/runs/2026-10-13-decklink-preservation.md).

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

The rack's UltraStudio Recorder 3G is a DeckLink device, not AVFoundation, so the stock Homebrew ffmpeg cannot read
it (the status error says so and the feed stays stopped). First-time setup on the machine that runs CamControl:

1. Install Blackmagic **Desktop Video** (driver + `DeckLinkAPI.framework`) from Blackmagic and plug in the device.
2. Build the small LGPL ffmpeg that CamControl uses for the feed:
   ```bash
   scripts/setup-ffmpeg-decklink.sh            # -> ~/Developer/ffmpeg-decklink/bin/ffmpeg
   ```
   It compiles ffmpeg 8.x from ffmpeg.org (about 12 MB download, a few minutes on Apple silicon) with the DeckLink
   and AVFoundation inputs and the MJPEG encoder only, against the SDK headers vendored in
   `third_party/decklink-sdk/include` (Blackmagic's own licence header permits that; see the NOTICE there). Nothing
   GPL is built and Homebrew's ffmpeg is left alone.
3. Point the app at it: `program.ffmpegPath: ~/Developer/ffmpeg-decklink/bin/ffmpeg` (devices.yaml, or
   `PUT /api/program`), then check `~/Developer/ffmpeg-decklink/bin/ffmpeg -sources decklink` lists the device.
4. `program.formatCode` (e.g. `Hp30`, see `/api/program/formats`) pins the video mode when autodetect does not.

The vendored SDK headers must match the installed Desktop Video **major version** (the rack runs Desktop Video 14.2;
an ffmpeg built against SDK 16 says "Installed DeckLink drivers are too old" and cannot list the device). To change
SDK version: download that SDK from Blackmagic, replace `third_party/decklink-sdk/include` with its `Mac/include`,
update the NOTICE, re-run the script. The script also works around two macOS build quirks (ffmpeg's `VERSION` file
shadowing libc++'s `<version>` on a case-insensitive disk; SDK 16 dropping the `IID_IUnknown` define).

The built binary could be bundled with a packaged release later (LGPL notice + source offer); Desktop Video itself
always stays an operator install.
