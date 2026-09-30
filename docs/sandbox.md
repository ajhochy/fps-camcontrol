# Sandbox

A second, isolated copy of CamControl wired to fakes, so the app can be run, clicked through, tested and
deliberately broken **without touching the live app, `config/`, the real ATEM, cameras, gimbals or controller**.

```bash
pnpm sandbox              # run it; open http://127.0.0.1:8090; Ctrl+C stops everything
pnpm sandbox:check        # start it, exercise Sony connect / pairing / power-off / reconnect, stop; exit 0 or 1
pnpm test:smoke:isolated  # the full smoke suite against sandbox config, while the live app keeps running
```

## What is isolated

| Thing | Live app | Sandbox |
| --- | --- | --- |
| Status UI | `:8080` | `:8090` (`SANDBOX_PORT`) |
| Config | `config/*` | throwaway copies in `sandbox/.run/` made from `sandbox/config/*` at each start |
| Sony service | `:8181` (real hardware) | fake on `:8191` |
| V-BOT / BirdDog | real IPs | fake VISCA cameras on UDP `52391–52393` |
| DJI gimbals | the Pi | virtual bridges on `17878–17880` |
| ATEM | real switcher | none (shows disconnected, as with the real one off) |
| Controller | real HID pad | never opened (`CAMCONTROL_NO_CONTROLLER=1`) |
| Sony approvals | `config/sony-cameras.json` | `sandbox/.run/sony-cameras.json` |

Edit the template in `sandbox/config/devices.yaml`, not the copy: it is recreated on every start.
The template has Sony devices, rigs with and without cameras, and two profiles, so the rig screens have
realistic data (including a rig with no camera assigned and a Sony device that is not bound yet).

## The fake Sony cameras

| Id | Model | Start | Behaviour |
| --- | --- | --- | --- |
| `AA:00:00:00:00:01` | ILCE-7SM3 | on | normal |
| `AA:00:00:00:00:02` | ILME-FX3A | on | refuses to connect (`0x0000820A`) until pairing is opened; aperture is read-only |
| `AA:00:00:00:00:03` | ILCE-7SM3 | off | bound to the "spare" device in the template |
| `AA:00:00:00:00:04` | ILCE-7M4 | off | no device entry: shows up as an unbound camera when powered on |

Control it while the sandbox runs (all JSON `POST`s to `http://127.0.0.1:8191/__sandbox`):

```bash
curl -X POST -H 'content-type: application/json' -d '{"on":true}'  http://127.0.0.1:8191/__sandbox/cameras/AA:00:00:00:00:03/power
curl -X POST -H 'content-type: application/json' -d '{"open":true}' http://127.0.0.1:8191/__sandbox/cameras/AA:00:00:00:00:02/pairing
curl -X POST -H 'content-type: application/json' -d '{"ms":10000}'  http://127.0.0.1:8191/__sandbox/scan-delay   # slow scans, like real Wi-Fi
curl http://127.0.0.1:8191/__sandbox/state
```

## Using the Sony connections screen against the fakes

In the Rigs tab choose **Sony connections**. **Connect** the a7S III; **Connect** the FX3A and watch it refuse (it needs
pairing), then open its pairing with the `pairing` curl above and choose **Retry connect**; rename a camera; power camera
`...04` on, choose **Refresh cameras**, then **Add as named camera** (or bind it to a camera you named before it was
connected); **Forget** and **Delete** (Delete is disabled while a rig uses the camera).

The fake copies behaviours of the real service that mattered in practice: only powered cameras are listed,
settings must be sent as strings (a hex value such as `"0x190"`, or the text `"F4"`; raw numbers are refused),
a camera that loses power stops being connected on its own, and a scan can be slow. It is not the real
Sony SDK: pairing, Wi-Fi discovery and the camera's own timing still need a hardware check.

## Looking at the rigs screen

`pnpm sandbox`, open http://127.0.0.1:8090 and choose the **Rigs (beta)** tab. It is the three-column Device Config
(list | inspector | live status, see `docs/ai/plans/2026-09-30-device-config-rigs-ui.md`); its files are
`ui/rigs/rigsModel.js` (logic, tested in Node by `rigsUiModelTest.ts`), `ui/rigs/rigs.js` (drawing) and
`ui/rigs/rigs.css`. Check it at desktop width (three columns), about 1000 px (two), and phone width (one column
with a Back button), with the keyboard (arrows, Home/End, Enter to the inspector, Escape back), and with a rename
made behind its back (`curl -X PATCH ... /api/rigs/vbot`): the list updates, an inspector you are focused in does not.

The live status column shows a live preview for a rig whose Sony camera is connected (power the fake camera on,
Connect it, select the rig). It pauses while the browser tab is hidden, like the Status page, so a hidden or
headless browser pane shows no picture unless it reports itself visible. Power the camera off and the picture gets a
STALE badge, then disappears once the app marks the camera disconnected.

Adding and removing: the **+** button opens a menu (Rig…, Sony camera…, and disabled ATEM switcher / NDI stream).
**Rig…** opens a form that adapts to the controller type (or picks a controller that is already set up); the new rig
is added at the end. **Remove this rig…** (bottom of a rig's inspector) asks the server what would change and shows it
— the presets that are lost, the later rigs that move up with their new camera id and hotkey — before anything is
removed; **Keep it** cancels. The sandbox presets are seeded so you can watch them follow their cameras.

Profiles and unsaved changes: the **profile bar** at the top of the list has the profile dropdown (switching asks
first and lists what will change, with a warning if the ATEM program output is on a rig that changes), a **⋯** menu
(rename this profile, delete another), and, after you edit a rig's ATEM input, camera, or add/remove a rig, an
**Unsaved changes** badge with **Save**, **Save as…**, **Revert** and a "What changed" list. Those edits are applied
immediately and kept in `sandbox/.run/working-profile.json` (so they survive an app restart) while `devices.yaml`
keeps the saved profile; names and addresses you change are shared by every profile and save at once. Switching
profile with unsaved changes offers Save and switch / Save as… / Discard and switch. The sandbox recreates `.run/`
on every start, so restarting the whole sandbox starts clean; the self-test restarts only the app process to prove
the edits survive a restart.

## What the self-test covers (`pnpm sandbox:check`)

The app starts and adopts the fake Sony service; bound cameras show their names; `GET /api/rigs` shape;
VISCA and gimbal rigs connect; connect a7S III, read and change a setting with the dashboard's hex values,
a raw number is refused, a live-view frame arrives; the FX3A refuses until pairing opens and its aperture
is read-only; power-off shows disconnected and power-on reconnects by itself; a newly powered camera with no
device entry appears as unbound; rig edits (`PATCH /api/rigs/:key`: rename, speed, refused protocol change, duplicate ATEM
input, camera on a BirdDog rig, wiring outside the active profile, stale-version 409, comments kept on disk, applied to the
running app) and Sony device create / rename / bind / delete (including a 409 for a device still in use); adding a rig at the end, removing one only after confirmation (409 with the impact first), presets moving with their cameras when a middle rig is removed (the sandbox presets are seeded for this), adding a removed device back, and refusing to remove a profile's last rig.

## Running the tests without stopping the live app

`pnpm test:smoke` boots a second copy of the app that talks to whatever `config/devices.yaml` points at and
opens the controller, so it must not run while the live app is up. `pnpm test:smoke:isolated` runs the same
suite with the sandbox config and no controller, so it is safe to run next to the live app. The Sony manager,
rig and schema suites need no app at all:

```bash
npx ts-node src/testing/sonyManagerTest.ts
npx ts-node src/testing/sonyConfigStoreTest.ts
npx ts-node src/testing/rigsTest.ts
npx ts-node src/testing/rigSchemaTest.ts
npx ts-node src/testing/rigEditTest.ts
npx ts-node src/testing/rigsUiModelTest.ts
```
