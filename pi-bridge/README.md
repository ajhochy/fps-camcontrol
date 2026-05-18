# DJI RS Gimbal Bridge

Network-to-gimbal bridge for fps-camcontrol. Runs on a Raspberry Pi (or any
Linux/macOS box for development) and exposes the WebSocket/JSON protocol
documented in [docs/dji-gimbal-spec.md](../docs/dji-gimbal-spec.md).

## Quick start (mock driver, any machine)

```bash
cd pi-bridge
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python3 dji_bridge.py --host 0.0.0.0 --port 7878 --driver mock
```

Point the main app at it by adding a camera entry to `config/devices.yaml`:

```yaml
- id: cam4
  label: "DJI RS4 Pro (mock)"
  protocol: "dji-bridge"
  inputId: 4
  bridge:
    host: "127.0.0.1"    # or the Pi's IP
    port: 7878
    gimbalModel: "RS4Pro"
    safetyTimeoutMs: 250
    rollEnabled: false
```

Restart the main app. The DJI device joins camera selection on the controller
exactly like a VISCA camera.

## Production deploy (Raspberry Pi 5 + PiCAN3)

Hardware (per [docs/dji-gimbal-spec.md §12.8](../docs/dji-gimbal-spec.md)):

- Pi 5 + PiCAN3 HAT (or any SocketCAN-native interface)
- PoE++ splitter → 12V into PiCAN3 barrel-in (powers the Pi via GPIO)
- 4-pin GH1.25 pigtail to the gimbal's RSA expansion port

Setup:

```bash
# On the Pi
sudo apt install python3-pip python3-venv
git clone <this repo> /home/pi/fps-camcontrol
cd /home/pi/fps-camcontrol/pi-bridge
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Bring up CAN once, manually, before deploying the service:
sudo ip link set can0 up type can bitrate 1000000
candump can0    # confirm gimbal frames are visible before continuing

# Symlink into a stable working directory the unit file expects:
sudo ln -s /home/pi/fps-camcontrol/pi-bridge /home/pi/dji-bridge

# Install the systemd unit:
sudo cp systemd/dji-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dji-bridge

# Watch it:
journalctl -u dji-bridge -f
```

Once the real DJI driver lands, edit the unit's `ExecStart` to use
`--driver dji-rs-sdk --can-iface can0` instead of `--driver mock`.

## Architecture

```
fps-camcontrol (Node)  ──ws://pi:7878──▶  dji_bridge.py  ──CAN──▶  Gimbal
                       JSON frames per      Driver dispatch       (PiCAN3,
                       spec §5              & safety watchdog      1 Mbit CAN)
```

- `dji_bridge.py` is the WebSocket server. It handles the protocol envelope,
  capability negotiation, heartbeat, and the safety watchdog. It is driver-
  agnostic.
- `drivers/mock_driver.py` integrates velocity into yaw/pitch over real time.
  Use for dev and CI.
- `drivers/dji_rs_driver.py` is the stub for the real DJI RS SDK. Currently
  raises on `connect()`; implement against the DJI SDK or a SocketCAN-ported
  fork of [ConstantRobotics/DJIR_SDK](https://github.com/ConstantRobotics/DJIR_SDK).

## Protocol summary

See [docs/dji-gimbal-spec.md §5](../docs/dji-gimbal-spec.md) for the full
contract. Cheat sheet:

| Client → Bridge      | Bridge → Client (ack/evt)              |
|----------------------|-----------------------------------------|
| `hello`              | ack: `{bridgeVersion, gimbalModel, capabilities[]}` |
| `ping`               | ack + evt `pong`                        |
| `moveVelocity`       | ack `{}` — bridge arms safety timer     |
| `stop`               | ack `{}` — cancels safety timer         |
| `getPosition`        | ack `{yaw, pitch, roll, ts}`            |
| `moveToPosition`     | ack `{ok}`                              |
| `recenter`           | ack `{}`                                |
| `setMode`            | ack `{}`                                |
| —                    | evt `status` every 500ms                |
| —                    | evt `safetyStop {reason}` on timeout    |

Errors return `{type:"ack", id, error:{code, message}}` with codes
`not_supported`, `sdk_error`, `not_connected`, `timeout`, `safety_stop`.

## Safety

- The bridge arms a watchdog timer (default 250 ms) on every `moveVelocity`.
  If no velocity frame arrives before it expires, the bridge issues a stop
  and emits `safetyStop`. The Node app already streams velocity at ~33 Hz,
  well under this budget.
- Loss of the WebSocket triggers driver stop on session teardown.
- Real driver implementations should additionally enforce motor-temperature
  limits if the SDK exposes them; emit `safetyStop {reason:"motor_overheat"}`.
