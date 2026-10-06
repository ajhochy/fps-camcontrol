---
date: 2026-10-06
repo: fps-camcontrol
status: planned
tags: [plan, fps-camcontrol]
index: "[[fps-camcontrol]]"
---

# Program streaming core — revised after architecture and complexity reviews

## Goal and accepted scope

Replace Wirecast's program-feed role: receive the switcher's finished PROGRAM picture and stereo audio, stream to an existing scheduled YouTube event, save MP4 locally, monitor audio and apply a small video sync delay. Camera control and ATEM switching stay available. The user selected core first and MP4 default, then authorized both review passes' fixes on 2026-10-06.

Ship the new streaming workflow in Electron first, shared by the existing manual/tracking variants. Keep existing CLI and iPad camera controls/preview working; new broadcast controls are Electron-local only. Effects, composition, event creation/rebinding, multistreaming, a separate recording-quality encode, general multichannel routing and new CLI streaming/authentication are deferred.

### Session contract

- Select `Record only` or `Stream + record` before starting. A broadcast always records locally in v1. Start opens one session; normal Stop ends that session's outputs together. Changing mode requires stopping. Arbitrary output attachment, stream-only mode, and keeping a recording running after an intentional broadcast stop are deferred.
- Local preview and Listen work while idle. A short preview/monitor interruption when changing into or out of an output session is acceptable; there is never a second capture owner. Closing a preview page cannot stop an active output session.
- A network outage must not interrupt recording. Recording failure must not interrupt an already-running stream: show recording failure, continue publishing and require an explicit session restart to record again. Initial recording failure prevents sending anything to YouTube.
- Listen and monitor volume affect headphone playback only. Select the playback device in macOS; no app device picker or separate mute control. Default Listen off.
- Sync is set before a session: `videoDelayFrames` integer 0–15, default 0, displayed in frames and milliseconds using the qualified rational input rate. Lock capture, encoding, delay and output folder during a session, including legacy config/profile routes.

### Clarification interview

Prior user answers established core-first, program-only stream/record, audio monitoring, a few frames of video delay, existing scheduled events and MP4 default. The latest instruction explicitly accepts the reviews' simplifications above; no repeated interview is needed. The unresolved questions below require hardware/prototype evidence, not another preference question.

## Intent, constraints and design tensions

One device owner; camera motion safety stays responsive; bounded buffers; network failure cannot corrupt recording; secrets stay out of logs/config/renderer; unfinished hardware work cannot silently change the production rig. The simplest output session is preferred over independently switchable outputs. Hardware evidence comes before committing to a media architecture; synthetic proofs still isolate timing and fault behavior cheaply. Planning and issue creation do not authorize a production install, driver change, merge, release or live broadcast.

## Existing evidence and prior art

- PR #60 (`integration/combine-open-prs`) carries the previous plan at `dd224d0`; PR #62 is merged. Existing `src/program/programFeed.ts` provides reduced-resolution MJPEG, omits AVFoundation audio and stops after preview inactivity. It is not a production output pipeline.
- Existing [issue #63](https://github.com/ajhochy/fps-camcontrol/issues/63) owns the UltraStudio Recorder 3G DeckLink build prerequisite. Its recorded evidence reports SDK 16 versus Desktop Video 14.2 mismatch and a preview-only FFmpeg build; refresh that evidence before acting. Reuse #63 rather than opening another SDK repair issue. A working MJPEG build is not proof of H.264/AAC/RTMPS/MP4 capabilities.
- Use [FFmpeg tee/fifo](https://ffmpeg.org/ffmpeg-formats.html#tee) as the first static-output prototype. It is a candidate, not proof of every failure/recovery requirement. No custom Node MPEG-TS parser, timestamp rewriter or media router is pre-approved.
- [DeckLink capture](https://ffmpeg.org/ffmpeg-devices.html#decklink) can emit bars/repeated frames on signal loss. Process liveness and frame progress do not prove signal presence. The existing error-only log level also suppresses signal warnings.
- [Hybrid fragmented MP4](https://ffmpeg.org/ffmpeg-formats.html#Fragmentation) is supported by the inspected FFmpeg 8.1.2. Its final metadata/header ordering is intended to preserve recovery; interruption and editor compatibility still need proof for the pinned binary.
- [YouTube broadcast lifecycle](https://developers.google.com/youtube/v3/live/life-of-a-broadcast) separates event management from media ingest. Cam Control owns OAuth/event APIs; FFmpeg receives only the resolved RTMPS destination.

## Architecture decision gates — first milestone

1. Resolve #63, then qualify the actual rig's program format and embedded stereo pair. Record device, driver, SDK and binary versions, input resolution/rational frame rate, interlacing, audio mapping and a short A/V sample receipt. Do not assume progressive input or add a broad format matrix. If the rig is interlaced, record the required conversion and revise the profile before proceeding.
2. Select and pin an FFmpeg/ffprobe runtime with DeckLink for this rig, VideoToolbox H.264, AAC, TLS/RTMPS, FLV, tee/fifo and hybrid MP4. Resolve build reproducibility, licenses and delivery now. An explicit user-supplied DeckLink binary remains an acceptable documented prerequisite if redistribution is not qualified; no hidden installation or driver upgrade. Reuse existing licensing/packaging work where applicable.
3. Prove one capture/encode, simultaneous local MP4 and publishing, and isolated publisher failure using static tee/fifo first. Include recording-write failure, a stalled publisher and reconnection at a decodable keyframe. Produce an executable reproduction and a short architecture decision. If static FFmpeg cannot satisfy the contract, record the failing case and propose the smallest alternative in the plan before implementing it; do not quietly build the old custom relay.
4. Prove normal MP4 finalization and interrupted-file recovery; measure finalization duration on long files and slow storage. The previous fixed five-second kill rule is removed. Agree a bounded teardown policy from measured evidence, with an explicit recovery path for forced termination.
5. Prove repeated flash/impulse content offsets at 0/1/3/15 frames at the actual rig rate, through MP4 and local RTMP receive, including reconnect. Synthetic non-integer-rate coverage can validate arithmetic without promising every hardware mode. One common A/V origin must survive encoding/remuxing. A positive PTS offset is a candidate mechanism, not the acceptance result.

## Media implementation contract

- One backend-owned session service manages capture and output intent. Reuse existing lifecycle/preview routes. Model idle, starting, recording, broadcasting, reconnecting, stopping and failure with separately reported signal/record/publisher condition; serialize actions and make duplicate Start/Stop idempotent. Starting/stopping does not replay camera motion.
- Use the qualified rig profile. Starting point: H.264 VideoToolbox, AAC stereo 48 kHz/128 kbps, Rec.709 SDR, no B frames, two-second GOP; 8 Mbps for 720p, 14 Mbps for 1080p up to 30 fps, 17 Mbps above 30 fps. Qualify actual rate-control support and expose bitrate; do not silently change codec/rate. Preview scaling never changes production output. [YouTube encoding recommendations](https://support.google.com/youtube/answer/2853702)
- Bound all relevant queues, including FFmpeg/device pipes. Publishing has a maximum **one second of queued media age inside the application**, plus a byte cap; an output that cannot maintain that bound must discard/restart at a fresh decodable boundary. The bound excludes latency introduced downstream by the network/YouTube. Never drain stale show content after reconnect. Recording preserves frames while writable and fails visibly when its bounded writer cannot keep up. Do not share publishing's frame-drop policy with recording.
- Network retry uses the selected runtime's proven mechanism with capped backoff and current session intent; record the actual schedule in the architecture decision. No retries after Stop, sleep, app restart or confirmed external event completion. Stale API status alone cannot terminate healthy publishing. Recovery must not restart capture/recording for a publisher-only failure.
- Distinguish valid signal, input-signal absent, device disconnected and capture-process failed. Derive signal health from explicit device information or supported warning events, not content analysis or fresh bars. On signal absence with a healthy capture process, show `No input signal` and continue its documented filler output without restart churn. On device/process failure, finalize the current file, stop publishing and terminate the session; restored hardware requires explicit Start and a new filename. Automatic capture retries and multipart recording are deferred.
- Choose a folder and unique `.mp4` name, no overwrite. Require writable storage and at least 1 GiB free at Start; below 256 MiB, finalize recording and alert while existing publishing continues. Use `+frag_keyframe+hybrid_fragmented`, never combine `faststart`. Successful close produces regular MP4; show finalizing until completion. Preserve interrupted originals and recover to a separate file, validating it before declaring success. No recording is tracking input.
- Shutdown stops motion immediately, then drains/finalizes media within the measured policy. Reuse/extend existing Electron parent supervision; no second generic process framework. Child exit, app crash, sleep and restart leave no media orphans and never auto-start a broadcast. File preservation is evaluated separately from graceful-close success.

## Monitoring and sync

- Tap the selected program stereo PCM from the sole capture owner, compute peak/RMS and send it over an authenticated local bounded transport. Idle monitoring must work before any session. Unused/slow clients cannot backpressure production.
- The AudioWorklet path has an explicit PCM format and sample-rate conversion to the AudioContext rate, plus gradual capture/playback clock correction. Target ~100 ms buffering, maximum 250 ms; drop/rebuffer is exceptional recovery, not normal drift control. Define underrun silence, resume and OS output-device-change recovery. Measure actual capture-to-headphone latency below 250 ms on the rig; configuration values alone are not proof. [Web Audio](https://www.w3.org/TR/webaudio/)
- One Listen toggle and volume; OS-selected output. Default Listen off; monitor gain does not touch production samples. Label the low-fps picture as framing preview; use short record-only sessions and synchronized playback for lipsync calibration.
- Preserve the measured video delay on every output. Save it with the qualified profile and reject live changes visibly. Arithmetic tests cover rational rates; media evidence covers the actual supported rig rate and sustained content offset rather than only initial timestamps.

## YouTube integration

- Register Desktop OAuth client, enable Data API, system-browser PKCE plus one-use state/loopback callback; `youtube.force-ssl` scope for lifecycle actions. Store refresh tokens using Electron-owned secure macOS credential storage, with a narrow helper only if required. No CLI-sharing requirement. Public distribution requires applicable Google consent verification. Logout clears credentials; active media is not accidentally stopped. [OAuth](https://developers.google.com/youtube/v3/guides/auth/installed-apps)
- One account/channel. Paginate `liveBroadcasts.list(part=snippet,status,contentDetails,mine=true,broadcastType=event,maxResults=50)`, locally filter upcoming/active and sort. Do not combine `mine` with `broadcastStatus`. Display channel/title/time/privacy/watch link and auto-start/auto-stop. Pin event/account throughout the session.
- Resolve selected event's current `boundStreamId`, including non-reusable streams, and fetch `rtmpsIngestionAddress` plus `streamName` immediately before Go Live. Missing/unbound events get a Studio setup explanation; no create/rebind. No permanent manual-key UI; synthetic proofs may use a developer-only local ingest destination.
- Go Live starts recording first, then ingest, waits for stream active and follows required testing/live transitions with asynchronous-state polling. An auto-start event may go live when media begins; disclose this before Go Live. Local preview/Listen never sends. There is no separate Test Stream button. [Transition API](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/transition)
- End session confirms the terminal YouTube action, requests complete and then stops local outputs/finalizes the file. On API timeout/failure, still stop local outputs, preserve the file and show completion unconfirmed. No independent Stop Sending button in v1. Record-only Stop requires no YouTube call.
- Poll selected health every 15 seconds, faster only during transitions. Show Sending versus YouTube-confirmed Live versus status unavailable. OAuth/API failure after start does not stop media; confirmed external completion ends publishing retries and gracefully finishes the session. Handle auto-stop semantics without recreating an event or redirecting ingest.

## Integration and delivery

- Add a Streaming page with framing preview, meters, Listen/volume, Record only versus Stream + record, folder/bitrate/sync setup, event selection, Start/Go Live and Stop/End session. Show signal, sending/live, recording/finalizing/failure, duration/path/free space and specific corrective errors. Keep camera controls accessible.
- Reuse Electron's authenticated loopback session for status/config/actions, YouTube adapters and audio transport. New privileged routes are unavailable in CLI/LAN/iPad contexts. Enforce configuration locks in existing write paths too. Responses/logs/exports never contain tokens/keys. Maintain existing preview response compatibility.
- Extend manual/tracking packaging allowlists for the chosen runtime/modules, secure credential integration, signatures and notices; retain binary/source hashes and existing variant identities. Resolve packaged runtime without Homebrew/PATH. Follow #63 for any separately supplied DeckLink prerequisite, rechecking capabilities at setup.
- Qualify camera responsiveness and dead-man safety during combined media load. Final release evidence includes both app variants, a clean Mac, real permissions/sleep/crash behavior and a two-hour target-rig stream+record with a disposable unlisted scheduled event. Preserve rig configuration and previous app/Wirecast for rollback. No merge/install/release is authorized by this plan.

## Known evidence gates

Existing integration limitation: Electron binds authenticated loopback only; iPad remote/preview currently work in the CLI app. Preserve both existing paths, but this plan does not add simultaneous iPad access to Electron. Do not run competing CLI/Electron capture owners as a workaround. If the operator requires simultaneous iPad use for adoption, resolve that separate prerequisite before deployment.

Rig mode/stereo mapping, supported binary delivery, tee/fifo failure isolation and freshness, exact timestamp options, monitor drift implementation and shutdown deadline are deliberately evidence-gated in the backlog. A failed gate updates the plan/decision before dependent implementation; a missing physical rig is not a synthetic pass. Google project/consent and actual rig access require the operator at execution time.

## Atomic delivery backlog

Published: 26 new issues #64–#89 under six milestones #11–#16. See [streaming issue index](../generated-issues/streaming-core/README.md) for the ordered single-deliverable tasks, dependencies, likely files, evaluation and GitHub links. Existing #63 is the capture prerequisite. No implementation issue is closed by this documentation PR.

## Planning checkpoint

Both reviews applied; hardware qualification moved first, custom relay made conditional, media-age/signal/audio-clock requirements added, and CLI streaming/device-picker/manual-key/test-stream/independent-output scope removed. Runtime, hardware, crash, hosted YouTube and installed-app tests have not been run for this revision. Prior research remains linked above; this revision reuses it rather than repeating the research swarm. Only documentation and GitHub planning metadata are changed.
