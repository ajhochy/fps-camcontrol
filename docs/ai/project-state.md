# Project State — fps-camcontrol

## Current focus
Active development paused on hardware. App-side and Pi-bridge software for DJI RS-series gimbal support is complete (mock bridge); the integration is now blocked on purchasing the Raspberry Pi hardware kit. Core VISCA-IP + ATEM camera control surface is feature-complete and field-ready pending first-service config.

## Active branch / PR
`main`. No open PR. Untracked working-tree additions: `AGENTS.md`, `docs/ai/` (this consolidation).

## In progress
- DJI gimbal: only the real DJI driver (`pi-bridge/drivers/dji_rs_driver.py`, step 11 of the Pi doc) remains — hardware-blocked until the Pi kit arrives.

## Risks / known issues
- DJI driver is a stub; real CAN/SDK path unverified against hardware. USB-C control is impossible on RS-series — CAN bus is required.
- First-service config not yet confirmed on real gear: V-BOT tilt direction, ATEM input IDs, ATEM DSK index.
- Post-hardware polish gaps: no web-UI editor for DJI devices (YAML-only today), DJI-BRIDGE activity-log rendering is default-styled, no Sony PZ stub, roll axis has no controller mapping yet.

## Test status
- Custom virtual-hardware smoke suite: `pnpm test:smoke` → 36/36 assertions passing (covers VISCA + ATEM + DJI handshake/velocity/safety/preset round-trip). No external hardware needed.

## Next step
Order the Pi 5 + PiCAN3 + PoE++ + RSA pigtail kit (~$200), then work `docs/pi-implementation.md` steps 1–5 (assemble, enable CAN, verify wiring) before writing the real DJI driver.

---
**Run history:** one file per run under `docs/ai/runs/` (surfaced as `ai-runs/`). This snapshot is overwritten in place.
