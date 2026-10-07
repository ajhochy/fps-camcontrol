# Current plan — program streaming core

The user selected core first on 2026-10-06. The complete implementation plan and ordered issue table are in
[2026-10-06 — program streaming core](plans/2026-10-06-program-streaming-core.md).

## Intent and constraints

Replace Wirecast's program-feed streaming/recording role with Cam Control's managed FFmpeg pipeline,
YouTube scheduled-event selection, local audio monitoring and adjustable video sync delay. Preserve
camera/ATEM control, capture ownership and output continuity. Core first; effects and new event creation deferred.
MP4 is the default recording format per the user follow-up: hybrid fragmented MP4 during capture,
regular MP4 after a successful normal stop, with recovery of completed fragments after interruption.

## Ordered issues

| Order | Goal | Likely areas | Required evidence | Dependencies |
| --- | --- | --- | --- | --- |
| 1 | Prove shared encode, independent output joins and frame sync | Program/media service and synthetic fixtures | Measured steady-state offsets and decodable output joins; bounded queues | None |
| 2 | Own capture, stream and recorder lifecycles | Backend lifecycle and existing program adapter | Independent outputs, fault isolation and complete teardown | 1 |
| 3 | Add local monitor, meters and calibration | Streaming page, audio socket/worklet and config | Audible stereo monitor; independent monitor mute/gain; saved frame delay | 2 |
| 4 | Connect scheduled events securely | YouTube API/OAuth service and Keychain helper | Event list/bound stream; correct broadcast lifecycle; protected credentials | 2 |
| 5 | Finish the operator workflow | Streaming page and status/action adapters | Existing event to confirmed YouTube Live plus concurrent recording | 3, 4 |
| 6 | Package and qualify the target rig | Both Electron variants and operator docs | Clean installed-app proof, physical capture and two-hour YouTube/record soak | 5 |

## Planning status

- [x] Read project context and inspect the current capture/packaging path.
- [x] Confirm core-first scope with the user and state implementation defaults.
- [x] Research primary FFmpeg, Web Audio and YouTube API references.
- [x] Write the detailed plan, output interfaces, ordered issues and acceptance gates.
- [ ] Implement the synthetic end-to-end media proof before committing to the integrated pipeline.
- [ ] Implement and independently qualify the full core workflow.

No implementation or runtime tests were performed for this plan. Current local checkout is
`feat/ipad-remote-touch-redesign` at `84efc9a`; confirm the latest reviewed integration base before implementation.
The previous Electron release/packaging plan is preserved in
[2026-10-01 — Electron release and packaging](plans/2026-10-01-electron-release-and-packaging.md).
Existing PR/hardware gates in that archived plan remain separately relevant.
