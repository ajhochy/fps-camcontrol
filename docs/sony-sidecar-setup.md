# Sony CameraWebApp sidecar setup

## Developer setup only

This optional helper builds a **local** `CameraWebApp` binary. It never downloads, clones, commits, or redistributes Sony SDK files or ZIPs, and it never stores credentials, fingerprints, or pairing secrets.

Download the Sony Camera Remote SDK yourself after reviewing and accepting the [Sony SDK EULA](https://support.d-imaging.sony.co.jp/app/sdk/licenseagreement_d/en.html) and [official download terms](https://support.d-imaging.sony.co.jp/app/sdk/en/index.html). Obtain an `alpha-sdk-api` checkout yourself from [crsdk/alpha-sdk-api](https://github.com/crsdk/alpha-sdk-api) (see its [SDK setup](https://github.com/crsdk/alpha-sdk-api/blob/main/docs/SDK_SETUP.md) and [build documentation](https://github.com/crsdk/alpha-sdk-api/blob/main/docs/BUILDING_BINARIES.md)). Do not commit the downloaded ZIP or installed SDK contents.

```bash
scripts/setup-sony-sidecar.sh \
  --checkout /absolute/path/to/alpha-sdk-api \
  --zip /absolute/path/to/sony-camera-remote-sdk.zip
```

The script asks you to confirm prior Sony license acceptance. For a noninteractive, operator-approved run only, use one of:

```bash
SONY_LICENSE_ACCEPTED=1 scripts/setup-sony-sidecar.sh --checkout /path/to/alpha-sdk-api --zip /path/to/sdk.zip
scripts/setup-sony-sidecar.sh --accept-sony-license --checkout /path/to/alpha-sdk-api --zip /path/to/sdk.zip
```

Those opt-ins assert that **you** accepted Sony's terms; the script never accepts them silently. Before building, the script applies [`sony-sidecar-status-fix.patch`](../scripts/sony-sidecar-status-fix.patch) to the checkout (skipped if already applied; it stops with a message if the upstream code has changed and the patch no longer applies). The patch makes `GET /api/server/status` answer from the last camera scan instead of starting a new one. Unpatched, that health check blocks behind Sony's SDK scan and races with connect requests, so CamControl reports the service as Absent or the sidecar crashes. The patch and script were tested against `crsdk/alpha-sdk-api` revision `225ab52` with Sony SDK `v2.02.00` on macOS (arm64).

The script then invokes the checkout's `./crsdk install --zip <zip>` (which asks you to accept Sony's license itself) and `./crsdk build`, writes only to that checkout's normal SDK/build outputs, then prints the verified executable path. It does not install a service or leave one running.

## Direct sidecar operation

Launch the built executable only when you need it:

```bash
/absolute/path/to/CameraWebApp --port 8181
curl --fail http://127.0.0.1:8181/api/server/status
curl -X POST http://127.0.0.1:8181/api/server/shutdown
```

`GET /api/server/status` is the health endpoint. `POST /api/server/shutdown` requests graceful shutdown. Bind the sidecar to loopback (`127.0.0.1`) only: it has no HTTP authentication and must not be exposed to a LAN or the public internet.

## CamControl runtime configuration

CamControl can adopt a sidecar you start externally at `SONY_API_URL`. To let CamControl launch and supervise the already-built binary instead, also set `SONY_SERVER_EXECUTABLE`:

```bash
SONY_SERVER_EXECUTABLE=/absolute/path/to/CameraWebApp \
SONY_API_URL=http://127.0.0.1:8181 \
pnpm start
```

The executable is optional; without it, CamControl keeps probing the external loopback service without blocking non-Sony operation. With it, CamControl manages launch and recovery. Use **Retry Sony service** in Device Config after fixing a missing or crashed service.

## Camera approval and reconnect

**Device Config → Sony connections** lists the cameras CamControl knows about (the ones you have named and any newly found on the network). A new camera is not trusted or connected automatically: select **Connect** explicitly. After a successful connection, CamControl records the camera ID in the configured approved-camera state file (`SONY_STATE_FILE`, or the default `sony-cameras.json` beside the device config). The file stores approval metadata only—never Sony usernames, passwords, fingerprints, tokens, or pairing secrets.

While a camera shows as connected, CamControl re-checks its link every 5 seconds. A camera that loses power is marked **Disconnected** ("Camera stopped responding") and then follows the normal reconnect behavior below. On real cameras this took about 35 seconds; the 5-second check is CamControl's part of that, and why the rest takes as long has not been investigated.

Approved cameras use automatic reconnect after an app or camera restart. If an approved camera is powered on later, bounded retries plus low-rate discovery can take up to about 75 seconds to reconnect it. Use **Retry connect** for an immediate operator retry after restoring power or completing camera-side pairing/setup, and **Retry Sony service** if the service itself is not running. Use **Forget** to remove approval and stop future automatic reconnect attempts.

Keep the sidecar on loopback. It has no HTTP authentication and must not be exposed to a LAN or the public internet. Local use still requires each developer/operator to accept Sony's license and obtain the SDK directly from Sony; neither CamControl nor the setup helper supplies Sony SDK assets.

## Troubleshooting

- **Camera scans take about 10 seconds** over Wi-Fi/LAN. CamControl allows 30 seconds and only declares the service lost when `/api/server/status` is also unreachable. While a scan runs, the sidecar is slow to answer other requests.
- **The sidecar labels cameras `"connectionType": "USB"`** unless the ID contains `TCP:` or `192.`; a camera found over the network by MAC address is mislabeled. The label is cosmetic.
- **Camera settings must be sent as the camera's hex value string** (for example `"0xfa"`). The sidecar rejects raw JSON numbers. The dashboard does this; use the `hex_value` field from `available_values` when scripting.
- **A camera that is not in PC Remote mode** (or whose PC Remote connection method does not match how it is connected) is discovered but the connect times out after about 15 seconds.

## Naming Sony cameras and putting them on rigs

A Sony camera is described once in the `devices:` inventory of `config/devices.yaml`, like a gimbal or a V-BOT, and a rig names the camera that sits on it. (A *rig* is one camera position: an entry under a profile's `slots:`.)

```yaml
devices:
  fx3:
    label: "FX3A — stage right"      # the name you see everywhere a camera is shown
    protocol: sony
    sonyCameraId: "78:F5:05:43:AD:50" # the id the Sony service reports; omit until the camera has been seen
profiles:
  production:
    slots:
      - { device: rs3, inputId: 2, camera: fx3 }   # the gimbal, its ATEM input, and the camera on it
```

- `label` is the camera's name. The Status page, Device Config and `GET /api/rigs` show it instead of the model and MAC address.
- `sonyCameraId` ties the entry to one physical camera. Two entries cannot claim the same id. An entry without an id is valid (a camera you have not connected yet); `GET /api/rigs` lists discovered cameras that no entry is bound to under `unboundCameras`.
- `camera:` on a rig must name a `protocol: sony` device. V-BOT and gimbal rigs take one; **BirdDog rigs have a built-in camera and are refused one**. A Sony camera can be on only one rig per profile, but the same camera can appear in different profiles.
- A Sony device can never be a rig's `device:` (controller). Every rule is checked when the config loads and when profiles are saved, and is enforced for profiles that are not active too.
- **Approval is separate and stays on this machine.** Adding a Sony device does not approve the camera: connecting is still an explicit click, and the approved list is in `sony-cameras.json` (not committed). Saved cameras are listed after an app restart even while they are powered off, and reconnect on their own when they come back.

These entries can be edited in the YAML file or through the API (the rigs screen in `docs/ai/plans/2026-09-30-device-config-rigs-ui.md` will use the same calls): `POST /api/sony-devices` (create: `{label, sonyCameraId?}`), `PATCH /api/sony-devices/:key` (`{label?, sonyCameraId?}`; `null` unbinds), `DELETE /api/sony-devices/:key` (refused with 409 while a rig in any profile uses it), and `PATCH /api/rigs/:key` with `{camera: "<sony device key>" | null}` to put a camera on a rig. Every edit is validated against the rules above before anything is written, keeps the file's comments, and is applied to the running app immediately.

## Camera-specific notes

- **a7S III (ILCE-7SM3):** reconnects on its own after a power cycle once it has been approved.
- **FX3A (ILME-FX3A):** over Wi-Fi it needed **Remote Shoot Function → Pairing** on the camera (MENU → Network → Cnct./Remote Sht.), completed with Sony's Imaging Edge Desktop (Remote), before the first connect. After a power cycle it had to be put into pairing mode again. A refused connection (`0x0000820A`, "Camera refused the connection") means the camera rejected the connection; close Imaging Edge Desktop, since the camera accepts one remote session at a time.
- **Aperture on the FX3A** can show **(read-only)**: the camera reports no options when the lens's own aperture ring or electronics control it.
