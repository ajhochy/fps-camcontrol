# Streaming core — atomic delivery backlog

Plan: [program streaming core](../../plans/2026-10-06-program-streaming-core.md). Published to PR #60: **26 new issues (#64–#89), six milestones (#11–#16)**. Existing [#63](https://github.com/ajhochy/fps-camcontrol/issues/63) is assigned to M1 and owns the SDK/driver prerequisite. These are implementation tasks, not work completed by this documentation PR.

Each issue has one deliverable, dependencies, likely files, concrete acceptance, required evaluation and safety boundaries. Execute the DAG in order; evidence gates must pass before their dependents. New file names are proposed locations, not pre-existing implementation.

## Milestones

| Milestone | Issues | Exit scope |
| --- | --- | --- |
| [Streaming M1 — Rig and media proof](https://github.com/ajhochy/fps-camcontrol/milestone/11) | #63, #64, #65, #66, #67, #68 | Qualify the real UltraStudio input and runtime, then prove static outputs, recovery and sync before choosing the production architecture. Existing #63 is the capture prerequisite. |
| [Streaming M2 — Session and recording engine](https://github.com/ajhochy/fps-camcontrol/milestone/12) | #69, #70, #71, #72, #73, #74, #75 | Implement one capture owner and coupled record-only or stream-plus-record sessions, with bounded publishing, durable MP4 and lifecycle cleanup. |
| [Streaming M3 — Audio monitoring and sync](https://github.com/ajhochy/fps-camcontrol/milestone/13) | #76, #77, #78 | Deliver stereo monitoring on the OS-selected output, controlled playback clocks and measured persisted video delay. |
| [Streaming M4 — Scheduled YouTube events](https://github.com/ajhochy/fps-camcontrol/milestone/14) | #79, #80, #81, #82, #83 | Secure Electron OAuth, existing-event selection and confirmed Go Live/End lifecycle, with no manual-key or separate Test Stream UI. |
| [Streaming M5 — Operator workflow](https://github.com/ajhochy/fps-camcontrol/milestone/15) | #84, #85 | Expose the protected Electron-only APIs and one complete streaming page while preserving existing camera and iPad controls. |
| [Streaming M6 — Packaging and qualification](https://github.com/ajhochy/fps-camcontrol/milestone/16) | #86, #87, #88, #89 | Package the pinned runtime for both variants and qualify camera safety, target-rig endurance and clean-Mac behavior. No release is implied. |

## Steps

| Step / draft | GitHub issue | Depends on | Milestone |
| --- | --- | --- | --- |
| [S01](s01-qualify-the-actual-ultrastudio-program-video-and-stereo-audio.md) | [#64 — qualify the actual UltraStudio program video and stereo audio](https://github.com/ajhochy/fps-camcontrol/issues/64) | [#63](https://github.com/ajhochy/fps-camcontrol/issues/63) | M1 |
| [S02](s02-pin-a-streaming-capable-ffmpeg-runtime-and-delivery-contract.md) | [#65 — pin a streaming-capable FFmpeg runtime and delivery contract](https://github.com/ajhochy/fps-camcontrol/issues/65) | [#63](https://github.com/ajhochy/fps-camcontrol/issues/63) | M1 |
| [S03](s03-prove-static-ffmpeg-outputs-and-choose-the-minimal-session-architecture.md) | [#66 — prove static FFmpeg outputs and choose the minimal session architecture](https://github.com/ajhochy/fps-camcontrol/issues/66) | [#64](https://github.com/ajhochy/fps-camcontrol/issues/64), [#65](https://github.com/ajhochy/fps-camcontrol/issues/65) | M1 |
| [S04](s04-prove-hybrid-mp4-close-and-crash-recovery.md) | [#67 — prove hybrid MP4 close and crash recovery](https://github.com/ajhochy/fps-camcontrol/issues/67) | [#66](https://github.com/ajhochy/fps-camcontrol/issues/66) | M1 |
| [S05](s05-prove-video-content-delay-through-mp4-and-streaming.md) | [#68 — prove video content delay through MP4 and streaming](https://github.com/ajhochy/fps-camcontrol/issues/68) | [#66](https://github.com/ajhochy/fps-camcontrol/issues/66) | M1 |
| [S06](s06-add-the-qualified-streaming-profile-and-configuration-locks.md) | [#69 — add the qualified streaming profile and configuration locks](https://github.com/ajhochy/fps-camcontrol/issues/69) | [#64](https://github.com/ajhochy/fps-camcontrol/issues/64), [#66](https://github.com/ajhochy/fps-camcontrol/issues/66), [#68](https://github.com/ajhochy/fps-camcontrol/issues/68) | M2 |
| [S07](s07-give-sessions-sole-capture-ownership-and-explicit-signal-health.md) | [#70 — give sessions sole capture ownership and explicit signal health](https://github.com/ajhochy/fps-camcontrol/issues/70) | [#69](https://github.com/ajhochy/fps-camcontrol/issues/69) | M2 |
| [S08](s08-implement-mp4-writing-and-storage-safeguards.md) | [#71 — implement MP4 writing and storage safeguards](https://github.com/ajhochy/fps-camcontrol/issues/71) | [#67](https://github.com/ajhochy/fps-camcontrol/issues/67), [#70](https://github.com/ajhochy/fps-camcontrol/issues/70) | M2 |
| [S09](s09-recover-interrupted-mp4-recordings-without-overwriting-originals.md) | [#72 — recover interrupted MP4 recordings without overwriting originals](https://github.com/ajhochy/fps-camcontrol/issues/72) | [#71](https://github.com/ajhochy/fps-camcontrol/issues/71) | M2 |
| [S10](s10-implement-bounded-publishing-and-fresh-reconnect.md) | [#73 — implement bounded publishing and fresh reconnect](https://github.com/ajhochy/fps-camcontrol/issues/73) | [#66](https://github.com/ajhochy/fps-camcontrol/issues/66), [#70](https://github.com/ajhochy/fps-camcontrol/issues/70) | M2 |
| [S11](s11-coordinate-coupled-record-only-and-broadcast-sessions.md) | [#74 — coordinate coupled record-only and broadcast sessions](https://github.com/ajhochy/fps-camcontrol/issues/74) | [#71](https://github.com/ajhochy/fps-camcontrol/issues/71), [#73](https://github.com/ajhochy/fps-camcontrol/issues/73) | M2 |
| [S12](s12-integrate-safe-media-shutdown-with-electron-supervision.md) | [#75 — integrate safe media shutdown with Electron supervision](https://github.com/ajhochy/fps-camcontrol/issues/75) | [#74](https://github.com/ajhochy/fps-camcontrol/issues/74) | M2 |
| [S13](s13-provide-bounded-program-pcm-and-stereo-meters.md) | [#76 — provide bounded program PCM and stereo meters](https://github.com/ajhochy/fps-camcontrol/issues/76) | [#70](https://github.com/ajhochy/fps-camcontrol/issues/70) | M3 |
| [S14](s14-implement-listen-playback-with-sample-rate-and-clock-correction.md) | [#77 — implement Listen playback with sample-rate and clock correction](https://github.com/ajhochy/fps-camcontrol/issues/77) | [#76](https://github.com/ajhochy/fps-camcontrol/issues/76) | M3 |
| [S15](s15-apply-and-persist-the-proven-video-delay-recipe.md) | [#78 — apply and persist the proven video-delay recipe](https://github.com/ajhochy/fps-camcontrol/issues/78) | [#68](https://github.com/ajhochy/fps-camcontrol/issues/68), [#69](https://github.com/ajhochy/fps-camcontrol/issues/69), [#70](https://github.com/ajhochy/fps-camcontrol/issues/70) | M3 |
| [S16](s16-store-youtube-credentials-securely-for-electron.md) | [#79 — store YouTube credentials securely for Electron](https://github.com/ajhochy/fps-camcontrol/issues/79) | None | M4 |
| [S17](s17-connect-youtube-using-desktop-oauth-and-refresh-tokens.md) | [#80 — connect YouTube using desktop OAuth and refresh tokens](https://github.com/ajhochy/fps-camcontrol/issues/80) | [#79](https://github.com/ajhochy/fps-camcontrol/issues/79) | M4 |
| [S18](s18-list-scheduled-events-and-resolve-their-bound-ingest-stream.md) | [#81 — list scheduled events and resolve their bound ingest stream](https://github.com/ajhochy/fps-camcontrol/issues/81) | [#80](https://github.com/ajhochy/fps-camcontrol/issues/80) | M4 |
| [S19](s19-drive-go-live-through-confirmed-youtube-transitions.md) | [#82 — drive Go Live through confirmed YouTube transitions](https://github.com/ajhochy/fps-camcontrol/issues/82) | [#74](https://github.com/ajhochy/fps-camcontrol/issues/74), [#81](https://github.com/ajhochy/fps-camcontrol/issues/81) | M4 |
| [S20](s20-report-youtube-health-and-end-sessions-reliably.md) | [#83 — report YouTube health and end sessions reliably](https://github.com/ajhochy/fps-camcontrol/issues/83) | [#82](https://github.com/ajhochy/fps-camcontrol/issues/82) | M4 |
| [S21](s21-expose-electron-only-session-status-and-actions.md) | [#84 — expose Electron-only session status and actions](https://github.com/ajhochy/fps-camcontrol/issues/84) | [#72](https://github.com/ajhochy/fps-camcontrol/issues/72), [#75](https://github.com/ajhochy/fps-camcontrol/issues/75), [#77](https://github.com/ajhochy/fps-camcontrol/issues/77), [#78](https://github.com/ajhochy/fps-camcontrol/issues/78), [#83](https://github.com/ajhochy/fps-camcontrol/issues/83) | M5 |
| [S22](s22-build-the-core-streaming-operator-page.md) | [#85 — build the core Streaming operator page](https://github.com/ajhochy/fps-camcontrol/issues/85) | [#84](https://github.com/ajhochy/fps-camcontrol/issues/84) | M5 |
| [S23](s23-package-the-chosen-media-runtime-in-both-electron-variants.md) | [#86 — package the chosen media runtime in both Electron variants](https://github.com/ajhochy/fps-camcontrol/issues/86) | [#65](https://github.com/ajhochy/fps-camcontrol/issues/65), [#75](https://github.com/ajhochy/fps-camcontrol/issues/75), [#79](https://github.com/ajhochy/fps-camcontrol/issues/79), [#85](https://github.com/ajhochy/fps-camcontrol/issues/85) | M6 |
| [S24](s24-verify-camera-safety-and-preview-behavior-under-media-load.md) | [#87 — verify camera safety and preview behavior under media load](https://github.com/ajhochy/fps-camcontrol/issues/87) | [#85](https://github.com/ajhochy/fps-camcontrol/issues/85) | M6 |
| [S25](s25-qualify-a-two-hour-target-rig-youtube-and-mp4-session.md) | [#88 — qualify a two-hour target-rig YouTube and MP4 session](https://github.com/ajhochy/fps-camcontrol/issues/88) | [#86](https://github.com/ajhochy/fps-camcontrol/issues/86), [#87](https://github.com/ajhochy/fps-camcontrol/issues/87) | M6 |
| [S26](s26-qualify-clean-mac-install-and-document-rollback.md) | [#89 — qualify clean-Mac install and document rollback](https://github.com/ajhochy/fps-camcontrol/issues/89) | [#86](https://github.com/ajhochy/fps-camcontrol/issues/86), [#87](https://github.com/ajhochy/fps-camcontrol/issues/87) | M6 |

## Execution notes

- Start with #63, then #64/#65. Credential storage #79 can proceed independently; media architecture is gated by #66–#68.
- Preserve the existing boundary: iPad remote/preview currently run through CLI; Electron is loopback-only. This scope adds no Electron-to-LAN remote feature. Do not open competing CLI/Electron capture owners as a workaround. If simultaneous iPad operation is required for rollout, resolve that separate prerequisite before live adoption.
- Refresh SDK/driver evidence. If the rig is unavailable, continue independent work and leave the physical gate open.
- A failed static-output proof requires a recorded plan/ADR revision before introducing a more complex transport.
- All issues remain open; no closing keywords are added to PR #60 for this backlog.
- Before implementation, compact the planning conversation and execute one issue at a time from this saved plan/backlog.
