# iPad remote control

Drive the cameras from an iPad with an Xbox controller, over the network. The iPad's Safari reads the controller
(browser Gamepad API) and streams it to CamControl, which feeds it to the same control state machine as the desk
controller: same sticks, triggers, camera select, presets, speed, auto transition and Back = emergency stop.

Page: `http://<mac-address>:8080/remote` (or the https address below).

## One-time setup

1. The app has to be reachable from the iPad. In `config/devices.yaml`:
   ```yaml
   server:
     host: 0.0.0.0        # open the status UI to the network (default is this Mac only)
   remoteControl:
     enabled: false       # starts off; the desk page can switch it on for a service
     pin: "4821"          # optional, 4-8 digits, quote it. Without one anyone who can reach the page can ask for control
   ```
   Restart the app after editing. (Opening the UI to the network exposes all of it, not just `/remote`: use the
   Tailscale tunnel or a trusted network.)
2. Pair the Xbox controller with the iPad (hold the pair button, then Settings > Bluetooth).
3. Open the page on the iPad. Safari does not need HTTPS to read a controller, but see the next section.

## HTTPS and keeping the screen awake (recommended for service use)

Reading the controller works on plain `http://`. **Keeping the iPad awake does not**: the Screen Wake Lock API
only exists on HTTPS pages, and without it the iPad locks mid-service (then control drops, by design). Either set
Settings > Display & Brightness > Auto-Lock to Never, or serve the app over HTTPS with Tailscale Serve.

Run these on the Mac yourself (the app never does):

1. Tailscale admin console > DNS: turn MagicDNS on; HTTPS Certificates > Enable. (The machine name is published in
   public certificate-transparency logs.)
2. `tailscale serve --bg --https=443 http://127.0.0.1:8080`
3. `tailscale serve status` shows the address, `https://<mac>.<tailnet>.ts.net/`.
4. On the iPad (Tailscale app connected) open `https://<mac>.<tailnet>.ts.net/remote`, then Share > Add to Home Screen.
5. To undo: `tailscale serve --https=443 off` (or `tailscale serve reset`).

Tailscale Serve renews the certificate by itself. The page picks `wss://` from the page address, so nothing else
changes. Through Serve the desk page shows the Tailscale login next to the iPad's name (a label, not a login: the
PIN is what protects control).

## Using it

- The desk page, Status tab, has the **iPad remote control** card: **Allow iPad control** switches the feature on
  or off, **Take back** returns control, **STOP all** stops every camera.
- On the iPad, press any button on the controller (Safari only sees it after a press), then **Take control** or
  hold **Menu** for a second.
- **The desk always wins.** The moment the desk controller is used, control returns to the desk and the iPad is
  told. The iPad can take control again only after the desk controller has been still for 1.5 s.
- One iPad drives at a time; a second page can watch. The Xbox Guide/Home button belongs to iPadOS and is not used.
- The preview shows the controlled camera's Sony camera when the rig has one; it runs only while the page is open.

## Reading the multiview

The border says what a pane is (red = program, green = preview; preview is always the camera the joystick drives).
The rig name sits centred on the bottom line. Top left of each pane: the head (gimbal / PTZ) with signal bars,
coloured as on the desk (green linked, amber weak / gimbal off / not moving, red poor signal / bridge offline); the
gimbal battery when it reports one; the Sony camera's battery — under 20 % amber, under 10 % red — or a red camera
with crossed bars when the camera is not connected; a camera glyph alone means connected but no battery level
reported (dummy battery / mains). The ⋯ button opens that camera's menu.

## Touch control (no controller needed)

Tap **Take control**, then:

- **Camera row (bottom):** tap a camera to set the ATEM **preview** to it. It also becomes the controlled camera, like
  X/A/B/Y at the desk. Refused (with a message) if the ATEM is offline or the rig has no ATEM input.
- **TRANSITION:** takes what is in **preview** to program (the same auto transition as RB). There is no confirmation;
  a second tap within 1.5 s is ignored, and it refuses when preview is already on program.
- **Joystick (bottom right):** drag to pan and tilt the **preview** camera; the move is proportional to how far
  the knob is from the centre, Slow / Normal / Fast sets the speed at full throw. Letting go recentres it and stops
  the camera at once. It follows the same rules as the PVW arrows (seat, remote control on).
- **Zoom + / − (far left):** hold to zoom the preview camera; works together with the joystick.
- **Speed:** Slow / Normal / Fast (touch only; the desk speed preset is separate).
- **Track speed (camera menu ⋯):** a slider, 5–100 %, for how fast person tracking may move that rig. Applied at
  once and saved to `devices.yaml` (`tracking.speeds.<device>`); it overrides `maxSpeed` / `viscaMaxSpeed` for that rig.
- **The program camera cannot be moved by touch.** Only the preview camera is driven from the page; a controller
  can still move whatever it controls.
- **Bluetooth button (top right):** its light is grey with no controller, green when one is connected, red when the
  page does not recognise it. Tap it for the pairing steps and what the page currently sees.
- **☰ menu (top right):** this iPad's name (what the desk shows as the owner of the seat).
- Messages (refusals, STOP, lost control) appear in the top bar's free space and never move the layout.
- A controller on the same page wins while its sticks or buttons are being touched. The seat is kept alive by neutral
  frames, and every safety stop below applies unchanged.

## Safety stops

The camera stops and control returns to the desk when: the page is hidden, the iPad locks or the app is switched
away; the controller disconnects; the Wi-Fi drops or the socket closes; no input arrives for 250 ms (camera stops)
or 1 s (seat released); the desk controller is touched; **STOP** is pressed; Take back; or remote control is
switched off. After any of these the iPad has to take control again.

## Limits

- Controllers must report the standard mapping (Xbox, PlayStation and Switch Pro do on Safari). PlayStation and
  Switch Pro are positional, so the face buttons do not match their labels.
- iPadOS can use a controller to navigate the system. Check on your iPad that A, B and the D-pad reach the page
  (Settings > General > Game Controller).
