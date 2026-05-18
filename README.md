# FPS CamControl

A macOS Node.js/TypeScript application that turns a game controller into a live production camera control surface.

Supports VISCA-IP cameras (BirdDog, V-BOT, generic), a Blackmagic ATEM switcher, and — via a small Raspberry Pi bridge — DJI RS-series gimbals. See [docs/dji-gimbal-spec.md](docs/dji-gimbal-spec.md) for the gimbal architecture and [docs/pi-implementation.md](docs/pi-implementation.md) for the Pi bring-up guide.

## Hardware Requirements
- ATEM switcher (tested with Mini/Mini Pro)
- BirdDog PTZ cameras (or any VISCA-IP camera on port 52381)
- Xbox controller (USB or Bluetooth) or Wii U Pro Controller
- *Optional:* Raspberry Pi 5 + PiCAN3 + DJI RS-series gimbal for gimbal control

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
| LB + RB | Recenter gimbal *(DJI bridge devices only)* |
| Back | Emergency stop |

## Smoke Tests

```bash
pnpm test:smoke
```

## DJI Gimbal Support

A DJI RS-series gimbal (RS4 Pro target) can be added as another controllable
camera via a small Raspberry Pi bridge that translates the app's WebSocket
commands into DJI's CAN protocol. The bridge runs in pure mock mode against a
dev box today, no hardware required — full architecture and protocol contract
in [docs/dji-gimbal-spec.md](docs/dji-gimbal-spec.md), and the Pi build
checklist in [docs/pi-implementation.md](docs/pi-implementation.md).

Quick start (mock bridge on the dev box):

```bash
cd pi-bridge
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python3 dji_bridge.py --driver mock --port 7878
```

Then uncomment the `cam4` block in [config/devices.yaml](config/devices.yaml).
The gimbal joins camera selection on the controller exactly like a VISCA
camera. The LB+RB chord recenters gimbal devices (falls through to ATEM
auto-transition on VISCA cameras).
