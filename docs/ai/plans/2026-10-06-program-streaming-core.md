---
date: 2026-10-06
repo: fps-camcontrol
status: planned
tags: [plan, fps-camcontrol]
index: "[[fps-camcontrol]]"
---

# FPS Cam Control — program capture, YouTube streaming, recording and audio monitoring

## Summary and agreed scope

Replace Wirecast's current role: receive the switcher's finished PROGRAM audio/video feed, stream it to an existing scheduled YouTube event, and save it locally. Keep camera control and ATEM switching in Cam Control. The first release adds program audio monitoring, stereo meters and a small video sync delay. The user selected **core first** on 2026-10-06; effects, scene composition, software switching, multistreaming and creating/scheduling YouTube events are later work.

Audience: the operator on the capture Mac, using the Electron app or its local CLI-served dashboard. The existing iPad remote keeps its program picture; local headphone monitoring and broadcast administration belong on the capture Mac in v1.

Hard constraints: one owner of the capture device, bounded media queues, no coupling of network failure to recording, preserved camera safety/remote arbitration, graceful recording finalization, protected credentials, and distribution of only qualified runtime binaries. Plan generation does not authorize a production install, driver change, live broadcast, merge or release.

The cheapest proof is a synthetic clocked video/impulse-audio source feeding one encoder, independent local recording and a local streaming receiver, plus the audio monitor. Demonstrate measured A/V offsets and failure isolation before adding OAuth or the operator page.

### Clarification interview and defaults

- Confirmed: core first; Wirecast currently supplies only stream/record; monitor program audio; delay video by a frame or several frames; select an existing scheduled YouTube event.
- Chosen defaults: independent stream/record controls; record-with-stream on; zero delay until calibrated; stereo program audio; Mac-local operation; effects and event creation deferred.
- Recording uses the same full-resolution H.264/AAC encode as the stream in v1. A separate higher-quality or isolated-camera recording encoder is deferred.
- User follow-up: **MP4 is the default recording format**. Use FFmpeg hybrid fragmented MP4 so completed fragments remain recoverable after an interruption and a normal stop produces a regular MP4.
- Sync delay is configurable before streaming/recording; changing it during either output is refused with an explanation. Live delay adjustment is deferred because it requires a separate continuity design.
- No unresolved product choice blocks this plan. Encoding quality, delay range, file formats and failure policies below are implementation defaults and can be revised before implementation.

## Environment findings and prior art

Inspected local checkout: `feat/ipad-remote-touch-redesign`, HEAD `84efc9a`. Existing untracked local files are outside this task. Live GitHub inspection for the documentation push confirmed PR #62 is merged and the open integration PR #60 currently has head `72a67c7`. The plan is being committed to PR #60; verify its latest reviewed head again before implementation.

- `src/program/programFeed.ts` owns a lazy FFmpeg process for a reduced-size MJPEG preview (defaults: 960 px wide, 10 fps). AVFoundation explicitly requests video without audio. Its preview timeout stops capture after 15 seconds without viewers. This output cannot be used as the production stream source.
- Existing capture supports AVFoundation and optional DeckLink; the documented rack input is UltraStudio Recorder 3G. DeckLink requires Desktop Video and a compatible SDK-enabled FFmpeg. These are documented facts, not a live inspection of the production machine.
- Preview endpoints and saved `program:` settings already exist. The capture owner currently lives inside HTTP server construction; move ownership into the app lifecycle and inject a preview adapter.
- Packaged Electron has an authenticated loopback backend. CLI remote access is used by the iPad; new broadcast controls and audio-monitor sockets need their own Mac-local authorization rather than relying on `X-Remote` headers.
- Current packaging uses explicit backend-directory allowlists. New program/broadcast services and binaries must be added to both app variants intentionally.

Borrow FFmpeg's encode-once/multiple-output principle. Its static tee/fifo configuration is a useful baseline but cannot add/remove a recording output dynamically without rebuilding the command. Use independent remux workers after a shared encode for operator-controlled output lifecycles. [FFmpeg muxers](https://ffmpeg.org/ffmpeg-formats.html#tee)

Borrow YouTube's broadcast/stream separation: select a broadcast, resolve its bound stream, obtain ingest credentials, send media and manage the broadcast lifecycle through the API. [YouTube lifecycle](https://developers.google.com/youtube/v3/live/life-of-a-broadcast)

## Implementation changes

### 1. Shared capture and media lifecycle

- Add a backend-owned `BroadcastManager`, created at app startup and injected into HTTP/WS adapters. It supervises one capture/encode FFmpeg process plus optional stream and recording remux workers. Preview, audio monitoring and outputs acquire independent demand; the 15-second preview idle timer cannot stop a recording or stream.
- Read the real program capture at its selected native progressive resolution and rational frame rate. Support 720p and 1080p at 25, 29.97, 30, 50, 59.94 and 60 fps when the device offers them. Reject unsupported/interlaced modes explicitly in v1. Never inherit preview fps/width as production encoding settings.
- DeckLink uses embedded program audio, channels 1/2 by default. AVFoundation discovers a separate named audio device and captures it with video. Provide a stereo channel-pair selector for multichannel program input; refuse output start when the configured audio source/channels are unavailable. Preserve input timing on a common A/V origin and compensate separate-device clock drift without resetting stream origins independently.
- Use H.264 VideoToolbox with AAC stereo, 48 kHz/128 kbps, Rec.709 SDR, no B frames and a two-second keyframe interval. Default video bitrates: 8 Mbps for 720p, 14 Mbps for 1080p up to 30 fps, 17 Mbps above 30 fps; expose a bitrate setting. Capability-check hardware encoding and supported rate control on the pinned runtime; do not silently switch codec or frame rate. [YouTube encoder settings](https://support.google.com/youtube/answer/2853702)
- Send the shared encoded A/V as MPEG-TS over private child-process pipes. Use a bounded Node relay with independent queues for each remux worker. Repeat transport and codec headers; start/restart a worker at PAT/PMT plus codec-configuration/IDR boundaries. Preserve relative A/V timestamps and apply one common origin shift for each output. Do not replay older content on a reconnect or start a file midway through an undecodable GOP.
- Limit each output relay to 16 MiB; an overflow or stalled writer fails that output visibly instead of blocking capture or accumulating memory. Preview keeps only its latest frame. Audio monitoring keeps only a short playback queue. Account for FFmpeg input queues too; bounded Node queues alone are insufficient.
- Keep the existing program-picture routes through a shared capture adapter. Scale only the preview branch; discard preview/monitor data when unused, without backpressure. Stream and recording always receive the corrected production A/V path.
- Integrate graceful media teardown with app shutdown after motion stops. Allow up to five seconds for recording drain/finalization, then terminate remaining children. Update Electron's shutdown deadline accordingly. Use parent-heartbeat supervision for media children; app/utility-process death, sleep and explicit shutdown must leave no capture/encoder/worker orphans. Cold startup never starts recording or streaming automatically.

### 2. Streaming and local recording

- RTMPS publishing remuxes H.264/AAC into FLV; recording remuxes the same encode into MP4. Each output can start or stop while the other continues and while preview/monitor remain active. Record startup waits for a clean keyframe; show `starting` until the writer actually receives media.
- Choose a recording folder on first use, remember it and generate unique timestamped names without overwriting files. Check writability and at least 1 GiB free space before starting. Monitor free space and writer errors; below 256 MiB, finalize the recording and alert the operator while streaming continues.
- Record directly to a uniquely named `.mp4` using `movflags=+frag_keyframe+hybrid_fragmented` on a pinned FFmpeg build supporting that flag. During recording, completed fragments carry their own metadata; normal writer close converts the file to regular non-fragmented MP4 without re-encoding. Show `finalizing` until close succeeds, and do not combine this with the incompatible fragmented `faststart` pass. On an interrupted close/crash, preserve the original fragmented MP4 and offer a recovery remux to a separate regular MP4; never overwrite the source before validating the recovered copy. Verify completed files in QuickTime and the target editing workflow. Browser/program recordings are never used as camera-tracking input. [FFmpeg MP4 fragmentation and hybrid mode](https://ffmpeg.org/ffmpeg-formats.html#Fragmentation)
- `Record with stream` defaults on. Go Live starts the recorder first and stops before sending to YouTube if it cannot start. An existing recording is reused rather than duplicated. Ending a broadcast leaves recording running until the operator stops it.
- A stream outage enters `reconnecting`; retry the publisher at 1, 2, 4, 8, 16, then 30-second intervals while the operator's current stream intent remains active and the event remains usable. Recording never restarts for a network failure. No buffered show content is uploaded late after recovery.
- Capture loss finalizes the current file and shows the gap. Retry capture with the same backoff; on recovery, create a new numbered recording part if recording intent remains active. Explain discontinuities instead of presenting multiple parts as uninterrupted footage. Sleep/app restart clears output intents; recovery requires operator action.

### 3. Audio monitoring and video sync

- Tap selected program audio as stereo PCM from the shared capture, compute peak/RMS meters and deliver a bounded stream to a Web Audio `AudioWorklet` on the Mac-local operator page. Monitoring works before any stream or recording starts. [Web Audio](https://www.w3.org/TR/webaudio/)
- Provide Listen on/off, output-device selection, monitor volume and monitor mute. Default to OS output, muted until the operator enables Listen. If browser output-device selection is unsupported, label OS-default routing and keep it usable. Monitor gain/mute/device changes affect only playback; prove stream and recording audio remain identical.
- Use approximately 100 ms of playback buffering, cap queued audio at 250 ms, drop old monitor samples when needed and flag underruns. Target measured capture-to-headphone latency below 250 ms on the supported rig; do not infer latency from the queue configuration alone.
- Add `videoDelayFrames`, integer 0–15, default 0. Convert frames to time with the actual capture frame rate (including 30000/1001 and 60000/1001); show both frames and milliseconds. Apply the corresponding positive video timestamp offset before shared production encoding, preserving audio timing and bounding mux buffering. Preserve that relative offset through all remuxes.
- A positive setting must delay video content relative to audio throughout the recording/stream, not merely insert leading black/frozen frames. Verify repeated flashes/audio impulses at the beginning, middle and end. FFmpeg timestamp/filter support is a starting mechanism, not proof of live sync. [FFmpeg timestamp filters](https://ffmpeg.org/ffmpeg-filters.html#setpts_002c-asetpts)
- Freeze capture/encode/delay settings while either output is active. The low-fps iPad/MJPEG preview is for framing; it is not a frame-accurate lipsync instrument. Calibrate with short local recordings played as synchronized A/V before going live.
- Enforce this lock through legacy program-source/config/profile write paths too: changing the capture device while an output runs returns a conflict. The iPad's preview on/off changes preview demand only and cannot stop production capture.

### 4. YouTube account and scheduled events

- Register a Google Desktop OAuth client and enable YouTube Data API v3. Use system-browser authorization, PKCE, a one-use state value and a temporary loopback callback. Request the scope needed for broadcast transitions (`youtube.force-ssl`), explain it in consent and store refresh tokens securely. Never embed an assumed secret in the renderer or pass OAuth tokens to FFmpeg. Public login rollout includes Google's applicable consent verification. [Desktop OAuth](https://developers.google.com/youtube/v3/guides/auth/installed-apps)
- One connected account/selected channel at a time in v1. Show channel identity and paginate `liveBroadcasts.list(part=snippet,status,contentDetails,mine=true,broadcastType=event,maxResults=50)`, then filter upcoming/active events locally and sort by scheduled time. Do not combine the mutually exclusive `mine` and `broadcastStatus` filters. [List reference](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/list)
- Pin the selected event/channel for the lifetime of a publishing intent. Refuse switching them while sending/reconnecting; changing selection must never redirect an existing stream to another event.
- Select an existing event and fetch its current `boundStreamId`. Fetch that stream by ID, including non-reusable streams, and read `rtmpsIngestionAddress` plus `streamName` server-side. Resolve again immediately before starting. For an unbound/missing stream, explain how to finish configuring it in YouTube Studio; do not create/rebind event resources in v1. [Stream resource](https://developers.google.com/youtube/v3/live/docs/liveStreams)
- Show selected title, channel, scheduled time, privacy, watch link and auto-start/auto-stop behavior. Preserve metadata/settings. `Go Live` starts ingest, waits for stream `active` and advances through required testing/live transitions, polling asynchronous lifecycle states. If auto-start is enabled, sending itself may go live; show that clearly before the operator's Go Live action. No preparation/preview action may accidentally send to an auto-start event. [Transition reference](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/transition)
- `Test stream` is offered only when auto-start is false and YouTube's monitor stream is enabled. Local preview/listening are always independent of uploading to YouTube. Do not retrofit event settings silently to enable testing.
- `End broadcast` is a distinct, confirmed terminal action: request `complete`, then stop ingest; on API failure/timeout, still stop local sending when requested, retain recording and show that YouTube completion is unconfirmed. Provide `Stop sending` for interruption without a completion request; display the consequences when the event has auto-stop enabled. Never label a stopped FFmpeg process as a confirmed completed broadcast.
- Poll selected stream/broadcast health every 15 seconds while sending, faster only during transitions; refresh the event list on demand and bound retries. API/OAuth errors after streaming starts do not stop existing publishing/recording. Report stale YouTube status explicitly; `LIVE` requires confirmation from YouTube. An externally completed event cancels publishing retries.
- Provide a manual YouTube RTMPS URL/key mode if OAuth is unavailable. It retains capture/record/monitor/delay features and clearly identifies that event selection/lifecycle confirmation is unavailable. It does not count as acceptance of scheduled-event integration.
- Store refresh tokens/manual keys in the macOS login Keychain via a narrowly scoped native helper shared by CLI and Electron. Use stdin/private pipes for helper requests and fixed application-owned key identifiers. Persist only nonsecret channel/event IDs and settings in config; secrets never appear in GET responses, logs, URLs used by the renderer or exported rig configs. Disconnect clears stored OAuth material; do not tear down an active stream accidentally.

### 5. Operator page, interfaces and packaging

- Add a Streaming page to the existing plain HTML/JS/CSS dashboard. Arrange program picture and stereo meters beside event/output controls, with capture/sync/encoder settings in a setup drawer. Show capture condition, Sending/YouTube Live confirmation, reconnect status, recording time/path/free space and actionable errors. Camera controls remain available during output operation.
- Add `BroadcastConfig` for capture audio/channel selection, encoder preset/bitrate, delay, recording folder and record-with-stream; keep legacy `program.fps/width` as preview settings. Add independently reported capture/stream/recording states plus sanitized YouTube status, meters and resource counters. Device discovery adds audio-device and capability information without changing existing preview response fields.
- Introduce `/api/broadcast/status`, `/api/broadcast/config` and a validated action endpoint for monitor/stream/record operations; `/api/youtube` adapters cover connect, disconnect, events and selection. Add a protected program-audio WebSocket. All output actions are serialized/idempotent against current state; settings writes while outputs run return a visible conflict rather than restarting them.
- Electron reuses its protected loopback session. CLI creates a local operator session with strict origin/cookie checks for new privileged routes. LAN/iPad clients cannot invoke broadcast/OAuth/credential operations or subscribe to monitor audio; browser Origin and request headers alone are not authentication.
- Bundle pinned FFmpeg/ffprobe with VideoToolbox, native AAC, required filters/muxers and working TLS. Resolve runtime from an explicit override or packaged resources, never depend on Homebrew/PATH in the installer. Audit exact build flags/licenses; ship no `--enable-nonfree` binary. Support the rig's separately supplied DeckLink-enabled binary via the existing path setting if its SDK/runtime licensing has not qualified for bundling. Include a validated capability/setup check, not a hidden installation or driver change. [FFmpeg licensing](https://ffmpeg.org/legal.html)
- Add new runtime modules and the Keychain helper to both manual/tracking package allowlists; sign nested executables and retain source/binary hashes and notices. Both variants share the streaming implementation and maintain their existing identities.

## Ordered implementation issues

| Order | Title / goal | Likely areas | Acceptance / evaluation | Depends on |
| --- | --- | --- | --- | --- |
| 1 | Prove the shared full-quality media pipeline and sync | `src/program/`, synthetic media fixtures | One capture/encode; independent remux output attachment; repeated measured offsets at 0/1/3/15 frames; decodable join/reconnect; no drift in 60-minute synthetic soak | None |
| 2 | Own capture and independent outputs in app lifecycle | Broadcast service, startup/shutdown wiring, existing program adapter | Stream-only/record-only/both; changing outputs preserves capture/other output; network/disk/capture failure isolation; no process orphans | 1 |
| 3 | Add local audio monitoring and calibration settings | Streaming UI, audio-worklet/socket adapter, config | Selected stereo source audibly monitored before output; volume/mute isolated; rational-fps delay persists; active-output setting edits refused | 2 |
| 4 | Connect scheduled YouTube events and protect credentials | YouTube service/adapters, macOS secret helper | OAuth refresh/revoke; paginated channel events; correct non-reusable bound stream; auto-start/testing/live/end semantics; no credential leakage | 2 |
| 5 | Finish the operator workflow and output reporting | Streaming UI, dashboard navigation, status/actions | Select existing event, monitor, record+Go Live, independently stop either output; genuine sending vs live status; usable error/empty/recovery states | 3, 4 |
| 6 | Package and qualify on the actual capture rig | Manual/tracking runtime packaging, operator guide | Minimal-PATH signed app; nested binaries/capabilities; real UltraStudio audio/video, YouTube event and two-hour stream+record soak; restore/rollback instructions | 5 |

Before implementation, archive prior plan context, freeze acceptance contracts per issue and implement against the latest reviewed base containing the program-feed/iPad/Electron work. Use the repository's isolation/worktree rules; after a branch is committed, pushed and attached to a PR, remove its worktree as required. Do not auto-merge/deploy.

## Test and acceptance plan

- Unit/contract: capture discovery and audio pairing; rational frame conversions; config defaults/migration; clean keyframe joins; bounded queues; output-state transitions and concurrent duplicate actions; API guards/redaction; OAuth state/PKCE/refresh; pagination and event ownership; deadline handling and asynchronous YouTube transitions.
- Actual FFmpeg integration with synthetic video clock/flashes and stereo tones/impulses: verify codecs/resolution/fps and measured A/V content offset in default MP4, recovered MP4 and local RTMP receive. At 25/29.97/30/59.94/60 fps, requested video delay must remain within one output frame, and a 60-minute run must drift by less than one frame. Validate steady state, output join and reconnect, not just initial timestamps.
- Fault injection: block/kill publisher, fill/fail a temporary recording volume, slow an audio client, detach preview, lose capture, expire OAuth and make YouTube unavailable. Healthy outputs continue without corruption or unbounded queues. Kill the writer during capture and during finalization: already completed MP4 fragments must remain recoverable, recovery must preserve the original file, and normal stops must produce a regular playable MP4. Test seek/playback in QuickTime and the intended editing software.
- Isolated app regression: camera-control/ATEM/remote arbitration and existing program frame routes; input dead-man remains effective during media load; server and guardian teardown; CLI LAN restrictions; normal and tracking Electron packaging checks. Run repository issue/PR gates serially with fake hardware, preserving actual operator config.
- Manual acceptance: same Mac Studio/UltraStudio capture route, confirmed stereo audio, headphone routing/latency, real sync stimulus, independent output controls, and an intentionally disposable unlisted scheduled YouTube event created in Studio. Watch remote playback and match the local recording, including chosen sync offset. Prove reconnect leaves recording continuous; respect/verify the event's auto-stop setting. Require a two-hour concurrent capture/stream/record run with measured RAM, output continuity and control responsiveness.
- Installed acceptance: signed/notarized candidate on a clean supported Mac without Homebrew, camera/microphone permission behavior, valid external DeckLink prerequisites if used, sleep/wake, close/crash cleanup and preserved files. Do not count synthetic/local checks as physical capture, hosted streaming or installed-app proof.

Delivery succeeds when an operator can run a scheduled YouTube broadcast and save its program feed, hear/meter its audio and apply a measured sync delay entirely from Cam Control, with Wirecast closed. Back up rig/device/config and record runtime/driver versions before an authorized production install; retain the previous app and Wirecast for rollback until this acceptance passes.

## Planning checkpoint

Research and static source inspection completed. No implementation, builds, media capture, YouTube login, account mutation, streaming, runtime testing, driver changes or production deployment were performed. Feasibility of the complete proposed pipeline remains to be proved by issue 1; Google client setup/consent verification and exact DeckLink binary redistribution are external release prerequisites with explicit paths above.
