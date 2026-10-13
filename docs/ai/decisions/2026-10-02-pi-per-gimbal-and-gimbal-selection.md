---
type: decision
---

# 2026-10-02 — One Pi per gimbal; the bridge saves which Bluetooth gimbal it drives

**Context.** One Pi drove three DJI gimbals over long Bluetooth hops. Each gimbal now gets its own Pi beside it.
Every Pi still hears every gimbal, a DJI gimbal accepts one connection, and the strongest signal is usually, but not
always, the right gimbal.

**Decision.**
- The bridge saves its gimbal in `gimbal.json` (state dir), overriding `DJI_RS3_BLE_ADDRESS`. With neither, it picks the
  strongest advertising "DJI RS" gimbal once and saves it: it never swaps gimbals silently when RSSI changes.
- Switching is explicit (`POST /gimbal?address=<addr|auto>`), operator-confirmed in Device Config through an app proxy.
  Address in the query string because websockets' HTTP parser refuses bodies; `GET /gimbal` never switches.
- Scans run only when asked (`?scan=1`, `auto`) or while unlinked, under the host-wide BLE lock, because a BlueZ scan
  can disturb a live link.
- New Pis run the bridge as a systemd **user service** (no sudo on them); bridge 1 keeps its system template.
- Battery: last payload byte of the passive 0x0d/0x02 frame (matched to an RS3 screen; RS3 Pro assumed).

**Consequences.** Moving a gimbal means stopping the old bridge instance first. RSSI for a linked gimbal is the value
from its last scan or connect (a linked gimbal does not advertise). On bridge 1 the units have no state directory, so
a choice made there lasts until restart (shown as "not saved on the Pi").
