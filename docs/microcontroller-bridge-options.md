# Microcontroller Bridge Options (DIY APC-R alternative)

Notes on building the gimbal bridge on a **microcontroller** instead of a
Raspberry Pi 5. This is the cheapest, smallest, most "made it myself" path — a
matchbox-sized board that mounts on the gimbal like a Middle Things APC-R.

> **Sequence it correctly:** build the **Pi 5 + python-can bridge first**
> (`pi-bridge/drivers/dji_rs_driver.py`). The Pi is where you *decode and verify*
> DJI's CAN protocol with `candump` in an easy Linux/Python environment. Once you
> have confirmed, working CAN frames, port them to a microcontroller as a v2.
> Starting on an MCU against an unverified protocol is a debugging nightmare.

---

## Why a microcontroller works here

The bridge does very little: read normalized velocity from the network, emit DJI
CAN frames, enforce a safety stop. No OS, no SDK, no heavy compute needed. The
RS gimbal protocol is plain CAN at 1 Mbit (see `docs/dji-gimbal-spec.md` §12 and
`pi-bridge/drivers/dji_rs_driver.py` for the frame format) — well within an MCU.

There is no DJI Linux/x86 SDK to lose by leaving the Pi (verified 2026-06-25 —
the "SDK" is a protocol doc + Windows demo), so an MCU gives up **nothing** on
the DJI side. You only give up Python ergonomics and easy debugging.

---

## Hardware options

| Board | CAN how | Network | Approx cost | Notes |
|---|---|---|---|---|
| **ESP32** (classic / S3) | **Built-in TWAI** controller + external transceiver (SN65HVD230 / TJA1050 / MCP2551) | Wi-Fi (built-in) | ~$8 board + ~$2 transceiver | Best fit. CAN + Wi-Fi on one chip. A DJI dev-forum user has driven an **RS4 Pro over CAN from an ESP32**. |
| **Raspberry Pi Pico W** | MCP2515 SPI CAN module + transceiver | Wi-Fi (built-in) | ~$6 + ~$5 module | MicroPython-friendly; MCP2515 adds an SPI hop. |
| **Teensy 4.x** | Built-in FlexCAN (FlexCAN_T4 lib) + transceiver | Needs add-on Ethernet/Wi-Fi | ~$25 + network | Strongest CAN support, but networking isn't onboard. |
| Arduino + MCP2515 | MCP2515 shield | Add-on (ESP-01 / W5500) | varies | Works electrically; least convenient networking. |

**Transceiver matters:** the MCU's CAN *controller* still needs a *transceiver*
to reach the bus's differential CANH/CANL. The SN65HVD230 (3.3 V) is the common
choice for ESP32/Pico.

**Recommended:** **ESP32-S3 + SN65HVD230.** One chip does CAN (TWAI) + Wi-Fi,
it's the platform with an existing RS4-Pro-over-CAN datapoint, and the ecosystem
(ESP-IDF / Arduino-ESP32) is mature.

---

## Wiring (ESP32 example)

```
ESP32 TWAI_TX ─▶ SN65HVD230 TXD        SN65HVD230 CANH ─▶ Gimbal RSA Pin4 (CANH)
ESP32 TWAI_RX ◀─ SN65HVD230 RXD        SN65HVD230 CANL ─▶ Gimbal RSA Pin2 (CANL)
ESP32 3V3 ───── SN65HVD230 VCC         Gimbal RSA Pin6 ── GND (common)
ESP32 GND ───── SN65HVD230 GND
```
- RSA pinout: Pin1 VCC(8V), Pin2 CANL, Pin4 CANH, Pin6 GND (External Interface
  Diagram PDF). **Do not** feed the 8 V pin into a 3.3 V MCU; only tap CANH/CANL/GND.
- Bus bitrate **1 Mbit/s**. 120 Ω termination per CAN norms (the gimbal end is
  already terminated; check before adding a second resistor).
- Some RSA cables need a 10–100 kΩ pull-down on the AD_COM accessory-detect line
  for the gimbal to recognize an accessory is attached.

---

## Firmware shape

Mirror the contract in `pi-bridge/drivers/base.py` (`move_velocity`, `stop`,
`get_position`, `move_to`, `recenter`) and the protocol in `dji_rs_driver.py`.
Two ways to talk to the Node app:

1. **Keep the existing WebSocket/JSON protocol** (`docs/dji-gimbal-spec.md` §4–5).
   Most code reuse — the app's `DjiBridgeDevice` is unchanged; the MCU just
   becomes another bridge endpoint. ESP32 WebSocket-server libraries exist.
2. **Emulate a VISCA-IP camera.** The MCU answers VISCA-over-IP (UDP 52381) and
   translates to DJI CAN. Then it works with the app's *existing, tested* VISCA
   path **and** any third-party VISCA controller — i.e. a true open APC-R clone.
   More protocol surface to implement (two protocols), but maximum compatibility.

Either way, keep the **0.5 s DJI speed watchdog** in mind: resend speed frames
or rely on the app's ~33 Hz stream; emit a zero-speed stop on disconnect.

---

## Trade-offs vs. the Pi 5 bridge

**Pros:** ~$15–20 vs ~$200; tiny and gimbal-mountable; no OS to manage/patch; no
SD-card corruption; instant boot.

**Cons:** harder to develop and debug (no shell, no `candump` on-device, no
Python REPL); you reimplement the bridge logic already written in Python; CAN
protocol must be implemented in C/MicroPython from scratch; OTA/update story is
more work than `git pull` on a Pi.

**Verdict:** excellent **v2** once the protocol is proven on the Pi. For first
hardware bring-up, the Pi's debuggability is worth the size/cost.

---

## References

- ESP32 TWAI → DJI CAN proof of stack: `CQUPTHXC/DJIMotorCtrlESP` (DJI motors).
- DJI forum, ESP32 + RS4 Pro over CAN: forum.dji.com/thread-316774-1-1.html
- Frame format + CRC + pinout: `pi-bridge/drivers/dji_rs_driver.py`,
  `docs/dji-gimbal-spec.md` §12, and the decision record
  `docs/ai/decisions/2026-06-25-gimbal-control-build-vs-buy.md`.
