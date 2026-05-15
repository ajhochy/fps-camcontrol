# FPS CamControl

A macOS Node.js/TypeScript application that turns a game controller into a live production camera control surface.

## Hardware Requirements
- ATEM switcher (tested with Mini/Mini Pro)
- BirdDog PTZ cameras (or any VISCA-IP camera on port 52381)
- Xbox controller (USB or Bluetooth) or Wii U Pro Controller

## Quick Start

```bash
pnpm install
pnpm build
pnpm start
```

Open http://localhost:8080 for the status panel.

## Configuration

Edit `config/devices.yaml` with your actual network IPs and ATEM input IDs before first use.

## Controls

| Input | Action |
|---|---|
| Right stick | Pan/Tilt controlled camera |
| Left stick Y | Zoom |
| Left stick X flick | Switch controlled camera |
| RT | Cut to air |
| RB | Auto transition |
| LT hold | Precision mode (25% speed) |
| LS click hold | Sprint mode (175% speed) |
| A/B/X/Y | Recall preset |
| LB + A/B/X/Y | Save preset |
| D-pad Up/Down | Speed preset cycle |
| D-pad Left/Right | Lower thirds toggle |
| Back | Emergency stop |

## Smoke Tests

```bash
pnpm test:smoke
```
