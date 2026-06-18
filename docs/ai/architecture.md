# Architecture — fps-camcontrol

## Overview
A macOS Node.js/TypeScript app that turns a game controller (Xbox / Wii U Pro) into a live-production camera control surface. One controller drives PTZ over VISCA-IP to BirdDog and V-BOT cameras, switches a Blackmagic ATEM, and — via a small Raspberry Pi bridge — controls a DJI RS-series gimbal as just another camera.

> **The app is the brain. ATEM just switches. VISCA just moves cameras. The Pi bridge just translates for the gimbal.**

## Stack
| Layer | Tech |
|---|---|
| Runtime | Node.js + TypeScript |
| Package mgr | pnpm |
| ATEM | `atem-connection` |
| VISCA-IP | Custom UDP client (Node.js `dgram`) on port 52381 |
| DJI gimbal | Custom WebSocket/JSON client → Python `websockets` bridge on a Pi |
| Gamepad | `node-hid` (Xbox + Wii U Pro profiles) |
| Config | YAML + Zod validation |
| Logging | Pino (stdout + daily `logs/service-YYYY-MM-DD.log`) |
| Status UI | Express + HTML on port 8080 (bound `0.0.0.0` for LAN) |
| Testing | Custom virtual hardware + smoke suite (36 assertions) |

## Components
| Component | Path | Responsibility |
|---|---|---|
| Controller loop | `src/app/controllerLoop.ts` | 60 Hz tick: read gamepad → drive state machine → emit device commands |
| State machine | `src/model/controlStateMachine.ts` | Camera selection, speed, presets, modes, cut/transition logic |
| MotionDevice | `src/devices/motionDevice.ts` | Common interface for all controllable cameras (VISCA + DJI); state machine is protocol-agnostic |
| VISCA device | `src/devices/viscaDevice.ts` + `src/visca/` | VISCA-IP wrapper over `viscaClient` (UDP socket, header, inquiry parsing) and `ptzActions` |
| DJI bridge device | `src/devices/djiBridgeDevice.ts` | WebSocket client to the Pi bridge: hello/capabilities, moveVelocity, stop, position, recenter, heartbeat |
| Device factory | `src/devices/deviceFactory.ts` | Protocol-dispatched construction (`visca` / `dji-bridge`), shared by startup + runtime reconcile |
| ATEM | `src/atem/atemClient.ts`, `switcherActions.ts` | atem-connection wrapper; cut / auto-transition / DSK·USK·graphics; forwards `stateChanged` |
| Safety | `src/safety/emergencyStop.ts`, `watchdog.ts` | Stop-all on disconnect; VISCA reconnect + 30s probe loop |
| Status / config UI | `src/ui/statusServer.ts` | Express status page + fully editable web config (ATEM, cameras, graphics) |
| Pi bridge | `pi-bridge/dji_bridge.py` + `drivers/` | Async websockets server translating app commands to DJI CAN; 250ms safety watchdog; pluggable driver |

## Key flow
```
Gamepad ──node-hid──▶ controllerLoop ──▶ controlStateMachine ──▶ Map<CameraId, MotionDevice>
                                              │                         ├─ ViscaDevice ──UDP/VISCA-IP──▶ BirdDog / V-BOT
                                              │                         └─ DjiBridgeDevice ──WS/JSON──▶ Pi bridge ──CAN──▶ DJI gimbal
                                              └─ ATEM cut / transition ──▶ atemClient ──▶ Blackmagic ATEM
```

## Control model (the "app is the brain")
- `controlledCamera` is the camera receiving PTZ right now. It changes only on left-stick flick or startup init.
- After an RT cut, control stays on the camera that just went live (post-take nudge).
- ATEM preview syncs to `controlledCamera` on selection change; program changes when RT (cut) or RB (auto) fires.
- All cameras implement the common `MotionDevice` interface — the state machine never branches on protocol.
- `recenter()` is optional on `MotionDevice`: ViscaDevice omits it, DjiBridgeDevice implements it. LB+RB recenters a gimbal, else falls through to ATEM auto-transition (preserves operator muscle memory).

## Real device IPs (production config)
- **cam1** = V-BOT @ `192.168.50.15`
- **cam2** = BirdDog 1 @ `192.168.50.16`
- **cam3** = BirdDog 2 @ `192.168.50.17`
- **cam4** = DJI RS4 Pro (planned) @ Pi bridge `192.168.50.40:7878`
- VISCA port `52381` (configurable per camera); ATEM IP set via web UI on first run.

## Cross-links
- Visual: [[FPS CamControl Architecture.canvas|canvas]] (Obsidian)
- DJI integration: `docs/dji-gimbal-spec.md`; Pi bring-up: `docs/pi-implementation.md`
- VISCA command reference: `docs/Visca_command_list_new.pdf`

## Appendix — VISCA-IP protocol notes
A 2026-05-14 code review of the VISCA-IP implementation (`src/visca/viscaClient.ts`, `ptzActions.ts`) found four compliance issues, all subsequently fixed (see runs Round 3). Captured here as the protocol contract; the full verbatim review is archived in the vault `_archive/VISCA Protocol Analysis (pre-consolidation 2026-06-18).md`.

- **VISCA-IP header (8 bytes):** `[0x01, 0x00, seqHi, seqLo, lenByte3, lenByte2, lenByte1, lenByte0]`. The sequence number must increment per command (was hardcoded `0x0000`); payload length is big-endian across the last 4 bytes (was wrongly packed into byte 3).
- **Stop command:** must send speed bytes `0x00`, not `0x01`. Original `toViscaSpeed` clamped min to 1, so "stop" became "creep at minimum speed" — dedicated `stopPanTilt()` / `stopZoom()` now send `0x00` directly.
- **Inquiry responses:** must be parsed, not just emitted as raw buffers. Position replies decode 4 nibble-encoded bytes each for pan / tilt / zoom (`parseNibbles4` + `toSigned16`).
- **Verified-correct format:** pan/tilt `0x81 0x01 0x06 0x01 [pan] [tilt] [dir] [dir] 0xFF`; zoom `0x81 0x01 0x04 0x07 [cmd] 0xFF`; speed range 1–24; exponential reconnect backoff.
