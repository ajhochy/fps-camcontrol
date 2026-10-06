# Streaming core — atomic delivery backlog

Plan: [program streaming core](../../plans/2026-10-06-program-streaming-core.md). Existing [#63](https://github.com/ajhochy/fps-camcontrol/issues/63) owns the DeckLink SDK/driver prerequisite. These are implementation tasks, not work completed by PR #60.

Each issue has one deliverable, dependencies, likely files, concrete acceptance, required evaluation and safety boundaries. Execute the DAG in order; evidence-gated tasks must pass before their dependents. New file names are proposed locations, not pre-existing implementation.

## Milestones

- **M1: Streaming M1 — Rig and media proof** — Qualify the real UltraStudio input and runtime, then prove static outputs, recovery and sync before choosing the production architecture. Existing #63 is the capture prerequisite.
- **M2: Streaming M2 — Session and recording engine** — Implement one capture owner and coupled record-only or stream-plus-record sessions, with bounded publishing, durable MP4 and lifecycle cleanup.
- **M3: Streaming M3 — Audio monitoring and sync** — Deliver stereo monitoring on the OS-selected output, controlled playback clocks and measured persisted video delay.
- **M4: Streaming M4 — Scheduled YouTube events** — Secure Electron OAuth, existing-event selection and confirmed Go Live/End lifecycle, with no manual-key or separate Test Stream UI.
- **M5: Streaming M5 — Operator workflow** — Expose the protected Electron-only APIs and one complete streaming page while preserving existing camera and iPad controls.
- **M6: Streaming M6 — Packaging and qualification** — Package the pinned runtime for both variants and qualify camera safety, target-rig endurance and clean-Mac behavior. No release is implied.

## Steps

| Step | Deliverable | Depends on | Milestone |
| --- | --- | --- | --- |
| [S01](s01-qualify-the-actual-ultrastudio-program-video-and-stereo-audio.md) | qualify the actual UltraStudio program video and stereo audio | #63 | M1 |
| [S02](s02-pin-a-streaming-capable-ffmpeg-runtime-and-delivery-contract.md) | pin a streaming-capable FFmpeg runtime and delivery contract | #63 | M1 |
| [S03](s03-prove-static-ffmpeg-outputs-and-choose-the-minimal-session-architecture.md) | prove static FFmpeg outputs and choose the minimal session architecture | S01, S02 | M1 |
| [S04](s04-prove-hybrid-mp4-close-and-crash-recovery.md) | prove hybrid MP4 close and crash recovery | S03 | M1 |
| [S05](s05-prove-video-content-delay-through-mp4-and-streaming.md) | prove video content delay through MP4 and streaming | S03 | M1 |
| [S06](s06-add-the-qualified-streaming-profile-and-configuration-locks.md) | add the qualified streaming profile and configuration locks | S01, S03, S05 | M2 |
| [S07](s07-give-sessions-sole-capture-ownership-and-explicit-signal-health.md) | give sessions sole capture ownership and explicit signal health | S06 | M2 |
| [S08](s08-implement-mp4-writing-and-storage-safeguards.md) | implement MP4 writing and storage safeguards | S04, S07 | M2 |
| [S09](s09-recover-interrupted-mp4-recordings-without-overwriting-originals.md) | recover interrupted MP4 recordings without overwriting originals | S08 | M2 |
| [S10](s10-implement-bounded-publishing-and-fresh-reconnect.md) | implement bounded publishing and fresh reconnect | S03, S07 | M2 |
| [S11](s11-coordinate-coupled-record-only-and-broadcast-sessions.md) | coordinate coupled record-only and broadcast sessions | S08, S10 | M2 |
| [S12](s12-integrate-safe-media-shutdown-with-electron-supervision.md) | integrate safe media shutdown with Electron supervision | S11 | M2 |
| [S13](s13-provide-bounded-program-pcm-and-stereo-meters.md) | provide bounded program PCM and stereo meters | S07 | M3 |
| [S14](s14-implement-listen-playback-with-sample-rate-and-clock-correction.md) | implement Listen playback with sample-rate and clock correction | S13 | M3 |
| [S15](s15-apply-and-persist-the-proven-video-delay-recipe.md) | apply and persist the proven video-delay recipe | S05, S06, S07 | M3 |
| [S16](s16-store-youtube-credentials-securely-for-electron.md) | store YouTube credentials securely for Electron | None | M4 |
| [S17](s17-connect-youtube-using-desktop-oauth-and-refresh-tokens.md) | connect YouTube using desktop OAuth and refresh tokens | S16 | M4 |
| [S18](s18-list-scheduled-events-and-resolve-their-bound-ingest-stream.md) | list scheduled events and resolve their bound ingest stream | S17 | M4 |
| [S19](s19-drive-go-live-through-confirmed-youtube-transitions.md) | drive Go Live through confirmed YouTube transitions | S11, S18 | M4 |
| [S20](s20-report-youtube-health-and-end-sessions-reliably.md) | report YouTube health and end sessions reliably | S19 | M4 |
| [S21](s21-expose-electron-only-session-status-and-actions.md) | expose Electron-only session status and actions | S09, S12, S14, S15, S20 | M5 |
| [S22](s22-build-the-core-streaming-operator-page.md) | build the core Streaming operator page | S21 | M5 |
| [S23](s23-package-the-chosen-media-runtime-in-both-electron-variants.md) | package the chosen media runtime in both Electron variants | S02, S12, S16, S22 | M6 |
| [S24](s24-verify-camera-safety-and-preview-behavior-under-media-load.md) | verify camera safety and preview behavior under media load | S22 | M6 |
| [S25](s25-qualify-a-two-hour-target-rig-youtube-and-mp4-session.md) | qualify a two-hour target-rig YouTube and MP4 session | S23, S24 | M6 |
| [S26](s26-qualify-clean-mac-install-and-document-rollback.md) | qualify clean-Mac install and document rollback | S23, S24 | M6 |

## Execution notes

- Start with existing #63, then S01/S02. Credential work S16 can proceed separately; no dependent media architecture implementation before S03–S05 evidence.
- Keep real SDK/driver evidence current. If the rig is unavailable, continue independent work and leave the physical gate open.
- A failed static-output proof requires a recorded plan/ADR revision before introducing a more complex transport.
- GitHub issue and milestone links will be recorded here after creation.
- Before implementation, compact the planning conversation and execute one issue at a time from this saved plan/backlog.
