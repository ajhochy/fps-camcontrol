# Raspberry Pi Implementation — DJI RS Gimbal Bridge

End-to-end build guide for the Pi side of the DJI RS gimbal integration. All
software referenced here is already in the repo at [pi-bridge/](../pi-bridge/);
the only code work still outstanding is the real DJI driver (step 11 below).
For protocol-level detail and architectural rationale see
[dji-gimbal-spec.md](./dji-gimbal-spec.md).

> **Hardware-side, this is plug-it-together work.** Steps 1–10 are pure assembly
> and config. Step 11 is bounded software work against the DJI SDK PDF. Step 12
> is soak testing.

---

## 1. Buy the parts

| Component | Purpose | Approx. cost |
|---|---|---|
| Raspberry Pi 5 (4 GB or 8 GB) | Runs the bridge daemon | $60–80 |
| **PiCAN3 HAT (SK Pang)** | SocketCAN CAN controller; 6–20 V regulated input powers the Pi via the GPIO 5V rail | $70 |
| **PoE++ splitter** (PoE Texas GAF-1230Bt or equivalent 802.3bt with 12 V output ≥30 W) | PoE++ → 12 V tap for the PiCAN3 + Ethernet passthrough | $25 |
| **RSA pigtail cable** | 4-pin GH1.25 breakout to the gimbal's expansion port (ConstantRobotics, Middle Things APC-R, Inkwa) | $15–25 |
| Small enclosure + tall standoffs | Mechanical mount on the camera cart | $15 |
| MicroSD card (32 GB+) | OS | $10 |

**Total ≈ $200.**

**Spare to keep in the gig bag:** one CANable Pro 2.0 (~$40). If the HAT ever
flakes mid-show, swap the SD card into a spare Pi with the CANable plugged in —
same `can0`, same software.

**Avoid:** GCAN USBCAN-II C (Windows-only driver — what ConstantRobotics/DJIR_SDK
hard-codes against; not worth porting).

---

## 2. Assemble

1. Seat the PiCAN3 HAT on the Pi's GPIO header. Don't power up yet.
2. Ethernet from the PoE++ switch → splitter input.
3. Splitter's Ethernet output → Pi's Ethernet port.
4. Splitter's 12 V output → PiCAN3 barrel jack. **This is what powers the Pi**
   (the PiCAN3 regulates 12 V down to 5 V and feeds the GPIO rail). Do not also
   connect a USB-C power supply — pick one.
5. RSA pigtail: PiCAN3 CAN screw terminals → gimbal's expansion port. **Do not
   power on the gimbal yet** — verify CAN bus comes up before connecting the
   load.

---

## 3. Flash the OS

1. Flash **Raspberry Pi OS Lite (64-bit)** to the SD card using Raspberry Pi
   Imager. In the imager's Advanced menu:
   - Enable SSH (use key auth if you have a key on this box; otherwise password).
   - Set hostname (e.g. `dji-bridge`).
   - Set Wi-Fi only as a fallback — primary network is the PoE Ethernet.
2. Boot the Pi. Find its IP from the router or the imager-set hostname:
   ```bash
   ssh pi@dji-bridge.local
   ```

---

## 4. Baseline system setup

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y git python3-pip python3-venv can-utils
```

`can-utils` gives you `candump`, `cansend`, `cansniffer` — essential for the
bring-up verification in step 6.

---

## 5. Enable the PiCAN3

Edit `/boot/firmware/config.txt` (or `/boot/config.txt` on older OS images) and
add at the end:

```
dtparam=spi=on
dtoverlay=mcp2515-can0,oscillator=16000000,interrupt=25
dtoverlay=spi-bcm2835
```

> SK Pang documents the exact overlay parameters per board revision — check the
> PiCAN3 product page if `oscillator` or `interrupt` differs on your unit.

Reboot:

```bash
sudo reboot
```

---

## 6. Bring the CAN bus up and verify wiring

```bash
# Bring up can0 at 1 Mbit (DJI RS SDK protocol v2.2 standard).
sudo ip link set can0 up type can bitrate 1000000

# Confirm the interface is alive:
ip -details link show can0      # state should be ERROR-ACTIVE

# NOW power on the gimbal with the RSA cable connected, then:
candump can0
```

You should see DJI frames streaming continuously. If you see nothing, or only
error frames:

- **Most common: pinout flipped.** Try rotating the RSA connector 180° (per
  ArduPilot's docs the right-side port has rotated pinout).
- **Termination missing.** PiCAN3 has a 120 Ω terminator jumper — make sure
  it's enabled (DJI's expansion bus is terminated on the gimbal side; your end
  of the bus must also be terminated).
- **Wrong bitrate.** Re-confirm 1 Mbit against the DJI RS SDK External Interface
  Diagram PDF.

**Do not proceed past step 6 until `candump can0` is healthy.** Every step after
this assumes a working bus.

---

## 7. Persist the CAN bring-up across reboots

Add to `/etc/systemd/network/80-can0.network` (or use a `pre-up` rule, or rely
on the systemd unit's `ExecStartPre` which already does this — pick one
approach, not all three):

```ini
# /etc/systemd/network/80-can0.network
[Match]
Name=can0

[CAN]
BitRate=1000000
```

The bundled [dji-bridge.service](../pi-bridge/systemd/dji-bridge.service) also
runs `ip link set can0 up type can bitrate 1000000` in `ExecStartPre`, so this
network-unit approach is optional belt-and-suspenders.

---

## 8. Deploy the bridge code

```bash
git clone https://github.com/ajhochy/fps-camcontrol /home/pi/fps-camcontrol
cd /home/pi/fps-camcontrol/pi-bridge
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# Stable symlink the systemd unit expects:
sudo ln -s /home/pi/fps-camcontrol/pi-bridge /home/pi/dji-bridge
```

---

## 9. Smoke test in mock mode

Validates the network path end-to-end before involving the real gimbal:

```bash
.venv/bin/python3 dji_bridge.py --host 0.0.0.0 --port 7878 --driver mock
```

On the **app machine** (your control laptop), uncomment the DJI block in
[config/devices.yaml](../config/devices.yaml) and set `bridge.host` to the Pi's
IP:

```yaml
- id: cam4
  label: "DJI RS4 Pro"
  protocol: "dji-bridge"
  inputId: 4
  bridge:
    host: "192.168.50.40"      # ← Pi IP
    port: 7878
    gimbalModel: "RS4Pro"
    safetyTimeoutMs: 250
    rollEnabled: false
```

Restart the app. The Pi's `journalctl -f` (or the foreground process) should
log a client connection and `hello` ack. Move the sticks while controlling
cam4 — the mock driver integrates pan/tilt into yaw/pitch position. Verify in
the status UI that the connection state shows green.

If this step works, **the entire app-to-Pi protocol path is proven**. Anything
that goes wrong later is hardware/SDK, not the bridge plumbing.

---

## 10. Install systemd unit

```bash
sudo cp /home/pi/dji-bridge/systemd/dji-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dji-bridge

# Watch it:
journalctl -u dji-bridge -f
```

The unit currently runs `--driver mock`. Edit `ExecStart` in the unit file
once the real driver lands (step 11).

If `systemctl status dji-bridge` shows `permission denied` running
`ip link set can0`, give the unit's user passwordless sudo for that command:

```bash
echo 'pi ALL=(ALL) NOPASSWD: /sbin/ip link set can0 *' | sudo tee /etc/sudoers.d/dji-bridge-can
```

---

## 11. Write the real DJI driver (the one remaining code task)

The bridge's mock driver and protocol skeleton are done. The only thing left
is to translate the bridge's six methods into real CAN frames to the gimbal.
Stub lives at [pi-bridge/drivers/dji_rs_driver.py](../pi-bridge/drivers/dji_rs_driver.py).

### Decide the path

1. **Download the DJI RS SDK** from <https://www.dji.com/rs-sdk>. Grab:
   - SDK Documentation
   - **RS Stabilizer External Interface Diagram PDF** ← this is the actual
     CAN protocol spec
   - Demo Software

2. Check whether the SDK ships a **Linux shared library**.
   - **If yes**: wrap it via `ctypes` or `cffi`. Fastest path.
   - **If no (Windows-only binaries)**: implement the documented CAN frames
     directly using `python-can` against SocketCAN. The Interface Diagram PDF
     is the spec; for our four verbs (`move_velocity`, `stop`, `get_position`,
     `move_to`) it's a few dozen frame definitions. Roughly 200–300 lines of
     Python.

### Implement against the stub

[pi-bridge/drivers/dji_rs_driver.py](../pi-bridge/drivers/dji_rs_driver.py) is
already wired into the dispatcher. Fill in the six methods to match the
contract in [pi-bridge/drivers/base.py](../pi-bridge/drivers/base.py):

- `connect()` — open the CAN bus, perform any SDK handshake
- `close()` — clean shutdown
- `move_velocity(pan, tilt, roll)` — pan/tilt/roll in `[-1.0, 1.0]`, map to SDK units
- `stop()` — hard stop the gimbal
- `get_position()` → `Attitude(yaw, pitch, roll)` in degrees
- `move_to(yaw, pitch, roll, speed)` — absolute position move
- `recenter()` — gimbal "recenter" / follow-center
- `set_mode(mode)` — `"follow" | "pan" | "fpv" | "lock"`

The mock driver in the same directory is a working reference for the lifecycle.

### Reference projects (do not vendor — license/transport issues)

| Project | Use for |
|---|---|
| [ConstantRobotics/DJIR_SDK](https://github.com/ConstantRobotics/DJIR_SDK) | C++ reference for the v2.2 protocol. License is undeclared — must verify before vendoring. Hard-codes the GCAN USBCAN-II C adapter; you would port to SocketCAN. |
| [Hibiki1020/dji_rs3pro_ros_controller](https://github.com/Hibiki1020/dji_rs3pro_ros_controller) | CAN-ID layout reference. ROS-coupled, no license — read, don't copy. |
| [ArduPilot DJI-RS2 driver docs](https://ardupilot.org/rover/docs/common-djirs2-gimbal.html) | Canonical wiring pinout reference. |

### Switch the unit to real driver

```bash
sudo systemctl edit dji-bridge   # or edit /etc/systemd/system/dji-bridge.service
```

Change `ExecStart` to:

```
ExecStart=/home/pi/dji-bridge/.venv/bin/python3 /home/pi/dji-bridge/dji_bridge.py \
    --host 0.0.0.0 --port 7878 --driver dji-rs-sdk --can-iface can0
```

Then `sudo systemctl daemon-reload && sudo systemctl restart dji-bridge`.

---

## 12. Soak test before going live

Before trusting this in a live show:

1. **30-minute idle** with the gimbal powered, app connected, no commands sent.
   Confirm:
   - No drift in yaw/pitch (`getPosition` reads stable).
   - No zombie SDK sessions (`ps -ef | grep dji_bridge`).
   - `journalctl -u dji-bridge` is quiet.

2. **Safety timeout verification.**
   - Start moving the gimbal via the controller.
   - **Yank the Pi's Ethernet cable.**
   - Gimbal must stop within 250 ms (the bridge's safety watchdog).
   - Reconnect Ethernet — the app should reconnect via the configured backoff.

3. **Heartbeat verification.**
   - Kill the bridge daemon (`sudo systemctl stop dji-bridge`) while sticks are
     centered. App should show cam4 disconnected.
   - `sudo systemctl start dji-bridge` — app should reconnect.

4. **30-minute mock show.** Run through your typical service flow: cuts,
   transitions, preset save/recall on the gimbal, emergency stop. Verify
   nothing wedges and no commands get dropped.

5. **Firmware lock.** Note the gimbal's firmware version after step 4 passes.
   **Pin that firmware** before live use — DJI firmware changes can alter the
   CAN protocol. Re-soak before adopting any future firmware update.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `candump can0` shows nothing | Pinout flipped | Rotate RSA connector 180° |
| `candump can0` shows error frames only | Bus terminator missing or wrong bitrate | Enable PiCAN3 120 Ω jumper; re-verify 1 Mbit |
| App shows cam4 red, bridge log shows hello timeout | Firewall blocking 7878 | `sudo ufw allow 7878/tcp` (or disable ufw entirely on the bridge) |
| Bridge log: `ImportError: drivers.dji_rs_driver` | Trying `--driver dji-rs-sdk` before step 11 | Use `--driver mock` until the real driver is written |
| Gimbal moves erratically | SDK speed unit mapping wrong | Check the Interface Diagram PDF's speed-byte range; the bridge sends `[-1.0, 1.0]` and your driver maps it |
| Safety stops firing during normal use | App not streaming velocity at expected rate | Check controller tick rate is ~33 Hz; check Pi's network jitter |
| Bridge reconnects in a loop | Network/auth issue or mismatched protocol version | Check `journalctl`; bump `bridge.reconnectBackoffMs` in app config |

---

## What's deployed where

| Component | Location | Source |
|---|---|---|
| Bridge daemon | `/home/pi/fps-camcontrol/pi-bridge/dji_bridge.py` | this repo |
| Drivers | `/home/pi/fps-camcontrol/pi-bridge/drivers/` | this repo |
| Python venv | `/home/pi/fps-camcontrol/pi-bridge/.venv/` | `requirements.txt` |
| Systemd unit | `/etc/systemd/system/dji-bridge.service` | copied from `pi-bridge/systemd/` |
| CAN bring-up | systemd unit's `ExecStartPre` | bundled |
| Logs | `journalctl -u dji-bridge` | systemd |

Pull updates with:

```bash
cd /home/pi/fps-camcontrol && git pull
sudo systemctl restart dji-bridge
```
