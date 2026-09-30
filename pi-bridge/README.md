# DJI RS Gimbal Bridge

Network-to-gimbal bridge for fps-camcontrol. Runs on a Raspberry Pi (or any
Linux/macOS box for development) and exposes the WebSocket/JSON protocol
documented in [docs/dji-gimbal-spec.md](../docs/dji-gimbal-spec.md).

## Quick start (mock driver, any machine)

```bash
cd pi-bridge
python3 --version  # Python >=3.10 required by bleak>=3.0.2
python3 -m venv .venv
.venv/bin/python3 -m pip install -r requirements.txt
.venv/bin/python3 dji_bridge.py --host 0.0.0.0 --port 7878 --driver mock
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

## Production deploy (target Pi: `worship`)

The active RS3 path is Bluetooth LE. CAN/PiCAN3 is fallback/history only.
This unit intentionally targets the deployed `worship` account and stable
`/home/worship/dji-bridge` symlink; change both only for a deliberate new
deployment convention.

Setup:

```bash
# On the Pi: Python >=3.10 is required by bleak>=3.0.2.
python3 --version
sudo apt install python3-pip python3-venv bluez
git clone <this repo> /home/worship/fps-camcontrol
cd /home/worship/fps-camcontrol/pi-bridge
python3 -m venv .venv
.venv/bin/python3 -m pip install -r requirements.txt

# Create the stable path only after the repository venv exists:
ln -sfn /home/worship/fps-camcontrol/pi-bridge /home/worship/dji-bridge
sudo install -m 600 /dev/null /etc/default/dji-bridge
sudo tee /etc/default/dji-bridge <<'EOF'
DJI_RS3_BLE_ADDRESS=34:D2:62:15:A5:47
DJI_RS3_MAX_JOYSTICK=200
EOF

# Install the systemd unit:
sudo cp systemd/dji-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dji-bridge

# Watch it:
journalctl -u dji-bridge -f
```

The service uses the stable symlink's `.venv/bin/python3`. Mock mode does not
import `bleak`. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the
adapted RS3 protocol attribution and license.

`DJI_RS3_MAX_JOYSTICK` scales normalized joystick input; it defaults to `80`
(the deployed env files set `200`) and is clamped to the RS3 safe protocol range `1..1000`. Tune it only while
viewing actual camera video.

## Architecture

```
fps-camcontrol (Node)  ──ws://pi:7878──▶  dji_bridge.py  ──BLE──▶  RS3
                        JSON frames per      Driver dispatch       (Bluetooth LE)
                        spec §5              & safety watchdog
```

- `dji_bridge.py` is the WebSocket server. It handles the protocol envelope,
  capability negotiation, heartbeat, and the safety watchdog. It is driver-
  agnostic.
- `drivers/mock_driver.py` integrates velocity into yaw/pitch over real time.
  Use for dev and CI.
- `drivers/dji_rs_driver.py` is the RS3 BLE driver. It defers importing `bleak`
  so mock mode remains usable without it.

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
