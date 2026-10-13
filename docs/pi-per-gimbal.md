# One Raspberry Pi per gimbal

Each DJI gimbal has its own Pi next to it, running one bridge on port 7878. A short Bluetooth hop per gimbal
replaces three long hops from one Pi.

| Rig | Gimbal | Bluetooth address | Pi | Bridge |
|---|---|---|---|---|
| Center | DJI RS3 PRO-0613YW | 48:1C:B9:56:31:95 | `dji-bridge.local` (bridge 1, user `worship`) | `dji-bridge@rs3pro-b`, port **7880** (system unit) |
| Tripod | DJI RS3 PRO-0614BW | 48:1C:B9:54:C6:BC | `dji-bridge-2.local` (user `pi`) | `dji-bridge` user service, port 7878 |
| Far Right | DJI RS3-06UH13 | 34:D2:62:15:A5:47 | `dji-bridge-3.local` (user `pi`) | `dji-bridge` user service, port 7878 |

A DJI gimbal accepts **one** Bluetooth connection. Two bridges must never be set to the same gimbal: the second one
cannot connect and keeps retrying.

## Which gimbal a bridge drives

The choice is saved on the Pi in `gimbal.json` (`DJI_BRIDGE_STATE_DIR`: `~/.local/state/dji-bridge` for the user
service, `/var/lib/dji-bridge` for the system unit; `gimbal-<instance>.json` for a templated instance). It overrides
`DJI_RS3_BLE_ADDRESS`.

* Nothing saved and no `DJI_RS3_BLE_ADDRESS`: **AUTO**. The bridge scans (only while nothing is linked), takes the
  strongest advertising DJI gimbal (name starts with "DJI RS") and **saves** it, so it does not swap gimbals later
  when signal strengths change. The strongest is usually the one next to the Pi, but not always.
* The operator changes it in **Device Config → the rig → Choose gimbal…**: the list shows what the Pi hears, signal
  strength (RSSI, dBm), the strongest marked; choosing one asks first, because the camera stops and the current
  link is cut. "Use the strongest" does AUTO once and saves the result.
* A gimbal linked to any host stops advertising. The chosen gimbal is always listed; one marked "not advertising
  (linked to another Pi?)" is probably held by another bridge: stop that bridge first.
* Scans can briefly disturb a live link, so the list is not refreshed by itself while a gimbal is linked:
  press **Scan now** (avoid it while that camera is on air).

Bridge HTTP (plain HTTP on the bridge port, no control session, so it never triggers the stop-on-disconnect):

```
GET  /info                          who the bridge is, plus "bluetooth" (which gimbal, RSSI, how chosen) and "battery"
GET  /gimbals[?scan=1]              DJI gimbals in range; scans only with scan=1 or while unlinked
POST /gimbal?address=<addr|auto>    switch: stop, drop the link, save, connect the new one
```

The address is in the query string: the bridge's HTTP parser (websockets) refuses request bodies. `GET /gimbal`
never switches (405). The app proxies these as `GET /api/rigs/:key/bluetooth-gimbals` and
`POST /api/rigs/:key/bluetooth-gimbal {address, confirm: true}`; the browser never talks to a Pi.

## Gimbal battery

The gimbal pushes 0x0d/0x02 frames whose last payload byte is the battery percent (matched to an RS3's own screen,
23%). Assumed the same on the RS3 Pro until checked against its screen. Shown on the Status tile next to the BT
signal, in Device Config, and in rig health (below 15% "Gimbal battery low"; down only below 8%).

## Installing or updating a Pi (run from the Mac)

```bash
scripts/install-pi-bridge.sh dji-bridge-2.local --user-service --gimbal 48:1C:B9:54:C6:BC --dry-run   # look first
scripts/install-pi-bridge.sh dji-bridge-2.local --user-service --gimbal 48:1C:B9:54:C6:BC
```

Key-based SSH only (it never asks for a password). It checks Python >= 3.10, venv, bluez, rsync, pypi, sudo and
lingering; copies `pi-bridge/`, builds the venv, runs the bridge's tests **on the Pi** before touching any service,
saves the gimbal, installs the units and the power logger, starts the bridge and prints `GET /info`. Run again to
update; the env file and the saved gimbal are kept unless `--gimbal` is given.

* `--user-service` (no sudo): `~/.config/systemd/user/dji-bridge.service`, `~/.config/dji-bridge/env`,
  `pi-power-log` as a user service. Needs lingering (`loginctl enable-linger pi`) to start at boot.
  Logs: `journalctl --user -u dji-bridge -f` (or `journalctl _SYSTEMD_USER_UNIT=dji-bridge.service`).
* `--system` (passwordless sudo): `/etc/systemd/system/dji-bridge.service`, `/etc/default/dji-bridge`,
  `/var/lib/dji-bridge`, plus the persistent journal and `pi-power-log` exactly as on bridge 1.
* `--wifi-off` turns Wi-Fi off only when the Pi has Ethernet and the SSH session is not on Wi-Fi.

Bridge 1 is a templated multi-instance install; update its code by hand (the installer would replace its units):
back up `dji_bridge.py` and `drivers/*.py` as `*.bak-<date>`, rsync the files without `--delete`, run the tests
with its venv, then `sudo systemctl restart dji-bridge@rs3pro-b`.

### Passwordless sudo (optional; only for `--system`, the persistent journal or Wi-Fi off)

The user types the password on the Pi. A narrow rule is enough for what the installer runs:

```bash
sudo tee /etc/sudoers.d/010-fps-bridge >/dev/null <<'EOF'
pi ALL=(root) NOPASSWD: /usr/bin/systemctl daemon-reload, /usr/bin/systemctl enable dji-bridge, /usr/bin/systemctl restart dji-bridge, /usr/bin/systemctl enable --now pi-power-log, /usr/bin/systemctl restart systemd-journald, /usr/bin/nmcli radio wifi off, /usr/bin/install -m 644 /tmp/dji-bridge.service.new /etc/systemd/system/dji-bridge.service, /usr/bin/install -m 644 /tmp/dji-bridge.env.new /etc/default/dji-bridge, /usr/bin/install -m 755 /tmp/pi-power-log.new /usr/local/bin/pi-power-log, /usr/bin/install -m 644 /tmp/pi-power-log.service.new /etc/systemd/system/pi-power-log.service, /usr/bin/install -D -m 644 /tmp/10-persistent.conf.new /etc/systemd/journald.conf.d/10-persistent.conf, /usr/bin/install -d -o pi -g pi -m 755 /var/lib/dji-bridge
EOF
sudo chmod 440 /etc/sudoers.d/010-fps-bridge && sudo visudo -c
```

(`install` writing to /tmp-sourced files is only as safe as /tmp; the broad alternative is
`pi ALL=(ALL) NOPASSWD: ALL`.)

## Moving a gimbal to another Pi (cut-over)

One gimbal at a time, and only after the new Pi's bridge is installed and its tests passed:

1. On bridge 1: `sudo systemctl disable --now dji-bridge@<instance>` (releases the gimbal's single connection).
2. Within ~30 s, `GET http://<new-pi>:7878/info` shows `"gimbalConnected": true` and the right `gimbalAddress`.
3. Point the rig at the new Pi in Device Config (host `<new-pi>.local`, port 7878).

Rollback: on the new Pi `systemctl --user disable --now dji-bridge`, then on bridge 1
`sudo systemctl enable --now dji-bridge@<instance>` and point the rig back at `dji-bridge.local:<port>`.

## Sleep and Wake (bridge 0.7.0)

Each DJI tile on the Status page has a **Wake gimbal** button (only while the gimbal reports it is asleep; bridge
0.5.0+) and a **Sleep gimbal** button (while it is awake; bridge 0.7.0+). Above the tiles, **Sleep all gimbals** and
**Wake all gimbals** do the same for every DJI rig. Sleep takes two taps (the first turns the button into "Tap again to
sleep" for 3 seconds); Wake asks with a confirm dialog. Both are logged in the activity log.

The bridge methods are `sleep` (capability `sleep`, DJI command `0x04/0x0f`, payload `23 01 01`) and `wake` (payload
`23 01 00`). Neither marks the gimbal asleep or awake by itself: the tile follows the gimbal's own sleep report
(`0x04/0x27`).

Sleep is refused (HTTP 409, with the reason) when the rig is on PROGRAM, has an active tracking session, or is being
driven (the shared motion ledger says it is moving, or a stick/preset move was commanded in the last 2 seconds). Sleep
all skips those rigs, and any already asleep or unreachable, and lists each skipped rig with its reason. A bridge older
than 0.7.0 answers "Update the Pi bridge to 0.7.0 to use Sleep".

Caveats:

* Sleep (`23 01 01`) comes from the upstream protocol notes and has **not been tested on hardware** here. Try it on a
  gimbal that is not on air first.
* A gimbal left asleep long enough may power off fully and drop its Bluetooth link. Wake cannot reach a gimbal that is
  off: press its power button, and the bridge reconnects on its own.
