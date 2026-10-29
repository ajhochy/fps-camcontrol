# Program feed on the network: app preview from the capture card + in-building TV feed (HLS)

Requested by AJ on 2026-10-29. Planning only; nothing here is implemented or deployed.

## Goal
1. The app's PGM views (desk page, iPad, phone) show the real ATEM program as it arrives on the UltraStudio capture card, not the program camera's Sony live view.
2. In-building TVs (Fire TV and Roku smart TVs, mostly on Wi-Fi) can watch the program feed over the local network.

## Decisions (AJ, 2026-10-28/29)
- **HLS, not NDI**, for the TVs: Wi-Fi TVs and Fire TV/Roku players cannot reasonably take full NDI (~100+ Mbps per viewer); HLS is ~5-8 Mbps and plays natively. A few seconds of delay is acceptable for these rooms.
- Capture stays on the accepted architecture: the DeckLink SDK 14.2 helper (`native/decklink-capture`) feeding FFmpeg; the shipped FFmpeg is the pinned LGPL 8.1.3 build (#65).

## Key constraint: one owner for the capture card
The card can be opened by one process. The app preview, the TV feed and recording/YouTube sessions all need the program, and the preview/TV feed must run even when nothing is being recorded or streamed. So the card is read by **one always-on capture service** (the helper) that **fans out** the same frames to independent consumers:
- an always-on **monitor encoder** (FFmpeg): low-rate JPEG frames for the app preview + the HLS TV stream;
- the per-session **broadcast encoder** (FFmpeg, accepted ADR 2026-10-13: tee -> MP4 + YouTube), started and stopped with sessions without touching the monitor outputs.
Fan-out lives in the helper (each consumer gets its own bounded queue; a slow or dead consumer is dropped/restarted without affecting the others). This revises how S07 (#70, sole capture ownership) is realised: the helper process is the sole owner; sessions attach to it instead of starting capture. Record this as an ADR addendum in T1.

## Out of scope
NDI; public internet viewing; DRM/authentication beyond the trusted staff LAN (note: the stream is visible to anyone on that network); per-TV control; changing how YouTube sessions work beyond attaching to the shared capture.

## Issues (milestone #17 "Streaming M7 — Program feed on the network", filed 2026-10-29)
| # | Issue | Depends on |
|---|---|---|
| T1 / #95 | Always-on capture service with consumer fan-out (sole card owner) | #64 (format facts), #65 |
| T2 / #96 | App PGM preview from the capture card (desk, iPad, phone) | T1 |
| T3 / #97 | Always-on HLS program stream for in-building TVs | T1 |
| T4 / #98 | Fire TV playback: setup guide and validation | T3 |
| T5 / #99 | Private Roku channel "FPS Live" | T3 |
| T6 / #100 | "TV feed" page in CamControl: address, QR, status, on/off | T3 |

## Validation
Synthetic helper path in CI; real-card runs only when Wirecast is closed (short, serial); HLS validated in a browser/VLC on this Mac, then on one Fire TV and one Roku on the staff Wi-Fi before any rollout. Live deployment only on AJ's explicit go.
