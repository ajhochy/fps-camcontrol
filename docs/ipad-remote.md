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
