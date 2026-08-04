# Decision: How to drive the DJI RS gimbal — build vs. buy

**Date:** 2026-06-25
**Status:** Superseded 2026-08-04 by `2026-08-04-rs3-bluetooth-via-pi.md`
**Context:** App-side DJI support + mock bridge are complete (36/36 smoke). The
integration is blocked on the one real piece: making a physical gimbal actually
move. Triggered by research into how others remotely control a mounted RS
gimbal, which surfaced a commercial product (Middle Things APC-R) that overlaps
heavily with what this repo is building.

---

## The one unavoidable constraint

At the time of this decision, every known path went through **CAN bus over the
gimbal's 4-pin RSA expansion port at 1 Mbit**:

- USB-C cannot drive motion (charging / firmware / shutter only).
- Bluetooth / Ronin-app protocol was believed closed and unavailable.
- The DJI R Focus Wheel, the APC-R, and every working OSS controller are all
  just CAN clients on that same bus.

That Bluetooth assumption was disproved by the live RS3 spike recorded in the
superseding decision. The CAN analysis below remains useful as fallback history.

---

## Option A — Buy Middle Things APC-R, integrate as a VISCA-IP camera

The APC-R is a small module that mounts on the gimbal's accessory port, owns the
CAN side, and **accepts VISCA-over-IP as a control input.** Since this app
already speaks VISCA-IP and has 36/36 tests around it, the gimbal would join as
`protocol: visca` in `config/devices.yaml` and be driven by the existing
`viscaClient.ts` — essentially "another VISCA camera."

- **Availability:** In stock in the US via B&H
  (bhphotovideo.com/c/product/1644349-REG) — EU import not required.
- **Cost:** ~$390–520.
- **New code:** ≈ none. Possibly minor VISCA dialect tuning.
- **Pros:** fastest to a working gimbal; zero CAN-protocol risk; vendor maintains
  firmware/model compatibility; tiny module on the gimbal (no Pi cart box).
- **Cons:** highest hardware cost; vendor dependency; closed box (can't extend);
  **must confirm its VISCA command set supports absolute-position recall** for
  the A/B/X/Y preset feature (`gotoAbsolutePosition`). Velocity pan/tilt is
  certain; preset positioning is the open question.
- **Risk:** Low. Main unknown = VISCA preset/absolute-position support.

## Option B — Finish the Pi 5 + PiCAN3 CAN bridge (current design)

The architecture already in the repo. Hardware kit (~$200) per
`docs/pi-implementation.md`, then write the real `dji_rs_driver.py`
(~200–300 lines) against the existing, tested `dji-bridge` WebSocket protocol.

- **Cost:** ~$200 (Pi 5, PiCAN3, PoE++ splitter, RSA pigtail).
- **New code:** the CAN driver only — everything upstream is built and tested.
- **Pros:** full ownership, no vendor; custom WS protocol is cleaner than VISCA
  for velocity streaming; already 90% done; extensible (roll axis, Sony PZ,
  presets); easy dev environment (Linux + SocketCAN + Python + `candump`).
- **Cons:** carry the DJI CAN implementation + hardware verification (the
  project's biggest remaining risk); one Pi box per gimbal to manage.
- **Risk:** Medium, but bounded — protocol is public (DJI RS SDK + Interface
  Diagram PDF downloadable; three OSS decodings exist). Unverified against RS4
  Pro hardware. Main unknown = whether DJI's SDK ships a Linux build (wrap via
  `ctypes`) or must be implemented as raw CAN frames from the PDF.

## Option C — Microcontroller bridge (the small/cheap "true clone")

Same job as Option B on a $15–20 board instead of a Pi. ESP32 (built-in TWAI CAN
controller + ~$2 transceiver) or Pi Pico W + MCP2515. Firmware speaks CAN to the
gimbal and WiFi/WebSocket — or even emulates a VISCA-IP camera — to the app.
Matchbox-sized, mountable on the gimbal like the APC-R.

- **Cost:** ~$15–40 + RSA pigtail.
- **New code:** reimplement the bridge in C/MicroPython **and** the CAN protocol
  from scratch (the MCU can't run DJI's x86 SDK `.so`).
- **Pros:** cheapest; smallest; no OS to manage; the most "made it myself"; if it
  emulates VISCA-IP it becomes a genuine open APC-R alternative.
- **Cons:** hardest to develop/debug (no Linux/Python/SDK); rebuilds the bridge
  logic already written in Python; slower iteration.
- **Risk:** Medium-high on effort. Best treated as a **v2 after Option B**, since
  the Pi proves the protocol on easy-to-debug hardware first.

---

## Comparison

| | A — Buy APC-R | B — Pi bridge (current) | C — MCU bridge |
|---|---|---|---|
| Cost | ~$390–520 | ~$200 | ~$15–40 |
| New code | ≈ none | CAN driver only | bridge + CAN from scratch |
| % already built | n/a (replaces bridge) | ~90% | ~0% (new firmware) |
| Protocol risk | none (vendor) | medium, bounded | medium, bounded |
| Dev difficulty | trivial | low (Python/SocketCAN) | high (embedded) |
| Extensible | no | yes | yes |
| Box on the gimbal | tiny module | Pi cart box | tiny module |
| Vendor dependency | yes | no | no |

---

## Recommendation

- **Want it working with least risk, cost no object:** Option A. Confirm VISCA
  absolute-position presets first (15-min spec check or email to Middle Things).
- **Want to own the stack and enjoy the build (the leaning):** Option B. It's the
  pragmatic DIY — 90% done, easy dev environment, the protocol trail is already
  mapped in the spec. This is the recommended path.
- **Option C** is the elegant endgame, but sequence it: **B first to decode and
  verify the CAN protocol on a Pi, then port the working frames to an ESP32.**
  Don't start on the microcontroller blind.

**Shared next action regardless of A vs. B/C:** the gimbal must reach CAN on the
RSA port. For B/C, the hard gate is step 4 of `current-plan.md` — `candump can0`
showing real DJI frames — before any driver code is worth writing.

## Open questions

1. **(Option A)** Does the APC-R's VISCA-IP implementation support
   absolute-position recall, or velocity only? Determines whether presets work.
   **Open.**
2. **(Option B) — RESOLVED 2026-06-25.** There is **no Linux SDK library** to
   wrap. DJI's "RS SDK" is a protocol-spec PDF + a Windows-only demo. The path is
   therefore **implement DJI's CAN protocol directly in `python-can` over
   SocketCAN** (no `ctypes`). The full frame format is published and now captured
   in `pi-bridge/drivers/dji_rs_driver.py` (grounded scaffold written). This also
   *lowers* Option B effort — no SDK build/linking, just a documented protocol.
3. **(All) — partially resolved.** RSA pinout (Pin1 VCC 8V / Pin2 CANL / Pin4
   CANH / Pin6 GND) and 1 Mbit bitrate confirmed from the External Interface
   Diagram. Still must `candump` the **actual RS4 Pro** before trusting byte
   layout — see new risk below.

## New risk surfaced 2026-06-25 (RS4 Pro protocol identity)

Every working OSS implementation targets **RS2 / RS3 Pro**. RS4 Pro is officially
listed by DJI, and one forum user drove an RS4 Pro over CAN from an ESP32
(encouraging), but **another reported total silence on an RS4 over CAN**, and no
byte-level RS4 Pro capture is public. **Hard gate before any live use:** bring up
`can0` at 1 Mbit and `candump` the gimbal to confirm it emits frames on `0x222`
and that CmdSet/CmdID/CRC seeds in `dji_rs_driver.py` match. Production control
also needs a 4-byte Device ID from DJI (Ronin.SDK@dji.com).

## Related artifacts

- Driver scaffold (protocol implemented, hardware-unverified):
  `pi-bridge/drivers/dji_rs_driver.py`
- Cheaper/smaller DIY route (ESP32/Pico): `docs/microcontroller-bridge-options.md`
