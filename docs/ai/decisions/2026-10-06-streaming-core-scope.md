---
date: 2026-10-06
repo: fps-camcontrol
tags: [decision, fps-camcontrol]
index: "[[fps-camcontrol]]"
---

# Streaming core: prove the rig, then ship one output session

## Context

Wirecast is used only to stream/record the finished program. The initial plan committed to independently attachable remux workers and a custom Node MPEG-TS relay, a broad capture-mode matrix and two app entrypoints. Architecture and ponytail reviews identified unproven complexity. The user authorized applying both reviews on 2026-10-06.

## Decision

Qualify actual UltraStudio input and the pinned runtime first, reusing #63. Prototype static FFmpeg tee/fifo and select the smallest architecture that passes measured isolation, freshness, recovery and sync. Do not pre-approve a custom relay. Use Record only or Stream + record with coupled normal start/stop, MP4 default, Electron-local administration, OS-selected audio output and one Listen toggle/volume. Defer arbitrary output attachment, CLI streaming, multichannel routing, manual-key UI and separate Test Stream.

Network failure leaves recording running; recording failure leaves an existing publisher running but prevents new starts. Signal absence and process/device failure are separate states. Explicit media-age bounds and playback clock correction are required. Shutdown timing comes from MP4 measurements, not a fixed guessed timeout.

## Alternatives considered

- Prior shared-encode/custom relay plus dynamic remux workers: more transport parsing/timing/lifecycle obligations than current needs justify.
- Unconditional static tee/fifo selection: insufficient evidence of freshness and independent failure behavior; require proof first.
- Parallel CLI/Electron feature delivery: additional authentication/credential surface without a current streaming requirement.

## Consequences

Normal Stop ends stream and recording together; a new recording cannot attach mid-session. The initial release supports the proven rig profile. Existing iPad remote stays CLI-only; this decision does not add Electron LAN access, and simultaneous iPad operation is a separate rollout prerequisite if required. Preview/Listen may briefly interrupt at session transitions. A failed gate requires updating the plan before implementation grows. Existing camera safety/authentication and required test evidence remain mandatory. See the detailed plan and atomic backlog for execution boundaries.
