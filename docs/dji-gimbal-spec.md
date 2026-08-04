# DJI RS Gimbal Integration — Technical Spec

Adds support for a DJI RS-series gimbal (target: RS4 Pro) as another controllable
motion device alongside the existing VISCA/IP cameras and ATEM switcher. The
gimbal is reached over the network through a small bridge service running on a
Raspberry Pi co-located with the gimbal.

This spec keeps the existing VISCA and ATEM code paths untouched and introduces
a thin device-protocol abstraction so future protocols (Sony PZ servo, NDI PTZ,
etc.) can drop in cleanly.

---

## 1. Current State (verified from repo)

- Entry point: [src/index.ts](src/index.ts) — wires ATEM, VISCA clients, controller, state machine, watchdog, status UI.
- Devices declared in [config/devices.yaml](config/devices.yaml) under `cameras[]` with `cameraType: vbot | birddog | generic`.
- Config schema lives in [src/config/configLoader.ts](src/config/configLoader.ts) (`CameraSchema`, `DevicesSchema`).
- Controller input → semantic actions in [src/model/controlStateMachine.ts](src/model/controlStateMachine.ts). It pulls a concrete `ViscaClient` from a `Map<CameraId, ViscaClient>` and calls `panTilt`, `zoom`, `stopPTZ` on it directly.
- VISCA wire protocol in [src/visca/viscaClient.ts](src/visca/viscaClient.ts) + [src/visca/ptzActions.ts](src/visca/ptzActions.ts). UDP, sequence numbers, IF_CLEAR for V-BOT, async reconnect with backoff.
- Presets persisted in [config/presets.json](config/presets.json) as `{cameraId: {slot: {pan, tilt, zoom} | null}}`. Save reads VISCA pan/tilt/zoom inquiry, recall sends `gotoAbsolutePosition`. See [src/model/presetManager.ts](src/model/presetManager.ts).
- Watchdog probes each VISCA client every 30 s (`client.probe()`); status reflected in `state.cameraConnected[id]`.
- Emergency stop iterates the VISCA map and calls `stopPTZ`.
- ATEM lives entirely behind [src/atem/atemClient.ts](src/atem/atemClient.ts) — unaffected by this change.

The right seam is the `Map<CameraId, ViscaClient>`: it is consumed in 5 places (state machine, preset manager, camera selector, watchdog, emergency stop). Replacing it with a `Map<CameraId, MotionDevice>` interface map is the smallest change that admits a second protocol.

---

## 2. Goals and Non-Goals

**Goals**
- Treat the DJI gimbal as another motion device selectable on the controller.
- Reuse the existing controller mapping, speed presets, precision/sprint modifiers, preset slots A/B/X/Y, and emergency-stop semantics.
- Keep all VISCA/IP and ATEM behavior bit-for-bit identical.
- Allow the system to run usefully against a **mock bridge** before the real Pi/gimbal arrives.
- Be extensible to additional protocols (Sony lens, NDI PTZ) without further refactors.

**Non-goals (for this iteration)**
- No rewrite of the app.
- No Sony PZ lens support yet — only design the abstraction so it slots in later.
- No roll control on first pass (interface allows it, state machine ignores it).
- No multi-gimbal-per-Pi yet (one Pi : one gimbal). One app can talk to N Pis.
- No video routing changes — the gimbal's camera feed is handled outside this app.

---

## 3. Recommended Architecture

```
                 ┌──────────────────────────┐
 Xbox controller │  fps-camcontrol (Node)    │
   (HID/BT) ───▶ │  ┌───────────────────┐    │
                 │  │ ControlStateMach. │    │
                 │  └─────────┬─────────┘    │       VISCA/IP UDP
                 │            │              │  ┌──────────────────▶ BirdDog 1
                 │            ▼              │  │  (unchanged)
                 │     MotionDevice (iface)  │──┼──────────────────▶ BirdDog 2
                 │     ┌────────────────┐    │  └──────────────────▶ V-BOT
                 │     │ ViscaDevice    │────┘
                 │     │ DjiBridgeDevice│──── WebSocket JSON ────┐
                 │     │ NullDevice…    │                        │
                 │     └────────────────┘                        ▼
                 │                                       ┌───────────────┐
                 │     AtemClient (unchanged) ──TCP────▶ │  ATEM         │
                 └──────────────────────────────┘        └───────────────┘
                                                                │
                                                                ▼ network
                                                       ┌──────────────────────┐
                                                       │ Raspberry Pi bridge  │
                                                       │  ┌────────────────┐  │
                                                       │  │ WS/JSON server │  │
                                                       │  │ Heartbeat      │  │
                                                       │  │ Safety timeout │  │
                                                       │  │ Preset cache   │  │
                                                       │  └───────┬────────┘  │
                                                       │          │           │
                                                       │  ┌───────▼────────┐  │
                                                       │  │ DJI RS SDK     │  │
                                                       │  │ adapter (CAN/  │  │
                                                       │  │ USB) — Python  │  │
                                                       │  └───────┬────────┘  │
                                                       └──────────┼───────────┘
                                                                  │ CAN/USB
                                                                  ▼
                                                              DJI RS4 Pro
```

Key points:
- The app sends **generic motion commands** (option 1 from the brief). The Pi owns SDK session, retries, heartbeat, and safety. This keeps DJI-specific quirks confined to the Pi and lets a future Sony or NDI device implement the same interface.
- The motion-device interface is **the only point of contact** between the state machine and any wire protocol. ViscaClient gets wrapped to satisfy it; nothing existing changes inside ViscaClient itself.
- Presets remain **app-side**, stored alongside VISCA presets, so the operator UX (save with LB+A, recall with A) works identically across device types.

---

## 4. Protocol Between App and Pi Bridge

**Transport:** WebSocket (`ws://`), JSON frames. Reasoning:
- Already a dependency (`ws` in package.json).
- Bi-directional, low-latency, single long-lived connection — fits stick streaming well.
- Trivially mockable for tests.
- Falls back gracefully (we can wrap in TLS or basic auth later).

**Why not raw UDP like VISCA?** Velocity streaming benefits from in-order delivery and an obvious connect/disconnect signal. Latency on LAN is fine. We do not need 100 Hz; 30–50 Hz of velocity frames is plenty.

**Message envelope:**
```jsonc
{ "v": 1, "id": 42, "type": "cmd" | "ack" | "evt", "method": "...", "params": {...} }
```
- `id` correlates `cmd` → `ack` (omitted on `evt`).
- `v` is protocol version, breaking changes bump it.

**Frame rate:**
- Velocity: client may send up to 50 Hz; bridge applies regardless. Bridge stops the gimbal if no velocity frame arrives for `safetyTimeoutMs` (default 250 ms).
- Heartbeat: `ping` from app every 1 s, `pong` from bridge with status payload.

---

## 5. Pi Bridge API Contract

All methods are JSON; field names are camelCase.

### 5.1 Commands (app → bridge)

| `method`         | `params`                                          | Ack payload                                    | Notes |
|------------------|---------------------------------------------------|------------------------------------------------|-------|
| `hello`          | `{clientId, protocolVersion}`                     | `{bridgeVersion, gimbalModel, capabilities[]}` | First frame after connect. Bridge replies with what the connected hardware supports (`pan`, `tilt`, `roll`, `position`, `presets`). |
| `moveVelocity`   | `{pan, tilt, roll?}` each in `[-1.0, 1.0]`        | `{ok}`                                         | Hot path. Bridge maps to SDK units. |
| `stop`           | `{}`                                              | `{ok}`                                         | Hard stop; bridge also auto-stops on timeout. |
| `getPosition`    | `{}`                                              | `{yaw, pitch, roll, ts}` in degrees            | Polled by app for preset save and status. |
| `moveToPosition` | `{yaw, pitch, roll?, speed?}`                     | `{ok, etaMs?}`                                 | Bridge handles the trajectory. |
| `savePreset`     | `{slot}` slot ∈ `"A"|"B"|"X"|"Y"`                 | `{ok, position}`                               | **Optional**; only used if `capabilities` lists `presets`. Default: app stores presets, this method is unused. |
| `recallPreset`   | `{slot, speed?}`                                  | `{ok}`                                         | Optional, same caveat. |
| `setSpeedScale`  | `{scale}` in `[0,1]`                              | `{ok}`                                         | Optional global cap; app already does scaling, so default no-op. |
| `recenter`       | `{}`                                              | `{ok}`                                         | DJI "recenter" / "follow center". |
| `setMode`        | `{mode}` `"follow"|"pan"|"fpv"|"lock"`            | `{ok}`                                         | DJI follow modes; optional. |

Errors return `{type:"ack", id, error:{code, message}}`. Codes: `not_supported`, `sdk_error`, `not_connected`, `timeout`, `safety_stop`.

### 5.2 Events (bridge → app, unsolicited)

| `method`        | `params`                                                        |
|-----------------|-----------------------------------------------------------------|
| `status`        | `{gimbalConnected, sdkConnected, mode, position:{yaw,pitch,roll}, motorTempC?, battery?}` (every 500 ms while gimbal connected, or on change) |
| `pong`          | `{rttFromAppMs, ts}` |
| `safetyStop`    | `{reason:"app_timeout"|"sdk_lost"|"motor_overheat"}` |
| `disconnected`  | `{reason}` immediately before bridge tears down SDK |

### 5.3 Capability negotiation

`capabilities` returned in `hello` ack is the contract for that session. The app **MUST NOT** send methods outside the advertised set; bridge returns `not_supported` if it does. This is how we keep RS4 Pro / RS3 / older-model differences out of the app.

Suggested capability strings:
- `velocity` — required, always supported.
- `position` — bridge can read yaw/pitch/roll. RS SDK supports this.
- `moveTo` — bridge can absolute-position-move.
- `presets` — bridge stores presets locally. Off by default.
- `roll` — third-axis control exposed.
- `mode` — follow-mode switching.

---

## 6. Device Config Schema Changes

Add a discriminator on each device entry, defaulting to `visca` so existing
configs stay valid. The simplest, fully-backward-compatible change:

```yaml
# config/devices.yaml
cameras:
  - id: cam1
    label: "V-BOT"
    protocol: visca           # NEW, default: visca
    cameraType: vbot          # unchanged
    inputId: 1
    viscaIp: "192.168.50.15"
    viscaPort: 52381

  - id: cam2
    label: "BirdDog 1"
    protocol: visca
    cameraType: birddog
    inputId: 2
    viscaIp: "192.168.50.16"
    viscaPort: 52381

  - id: cam4
    label: "DJI RS4 Pro"
    protocol: dji-bridge      # NEW
    inputId: 4                # ATEM input for the gimbal's camera (if routed)
    bridge:
      host: "192.168.50.40"
      port: 7878
      gimbalModel: "RS4Pro"   # informational
      safetyTimeoutMs: 250
      reconnectBackoffMs: [1000, 2000, 5000, 15000]
```

Schema edits in [src/config/configLoader.ts](src/config/configLoader.ts):

```ts
const ProtocolEnum = z.enum(['visca', 'dji-bridge']).default('visca');

const BridgeSchema = z.object({
  host: z.string(),
  port: z.number().default(7878),
  gimbalModel: z.string().optional(),
  safetyTimeoutMs: z.number().default(250),
  reconnectBackoffMs: z.array(z.number()).default([1000, 2000, 5000, 15000]),
});

const CameraSchema = z.object({
  id: z.string(),
  label: z.string(),
  protocol: ProtocolEnum,
  cameraType: z.enum(['vbot','birddog','generic']).default('generic'),
  inputId: z.number(),
  // VISCA fields — required only when protocol === 'visca'
  viscaIp: z.string().optional(),
  viscaPort: z.number().default(52381),
  // DJI fields — required only when protocol === 'dji-bridge'
  bridge: BridgeSchema.optional(),
}).superRefine((c, ctx) => {
  if (c.protocol === 'visca' && !c.viscaIp) ctx.addIssue({code:'custom', message:'viscaIp required for visca'});
  if (c.protocol === 'dji-bridge' && !c.bridge) ctx.addIssue({code:'custom', message:'bridge required for dji-bridge'});
});
```

Preset file shape (`config/presets.json`) **stays the same**, but each slot may
now hold either a VISCA-style `{pan,tilt,zoom}` integer triple or a gimbal-style
`{yaw,pitch,roll,zoom?}` float triple. Discriminate by a `kind` field:

```jsonc
{
  "cam2": { "A": { "kind": "visca", "pan": 1234, "tilt": -200, "zoom": 0 }, "B": null, "X": null, "Y": null },
  "cam4": { "A": { "kind": "gimbal", "yaw": 12.4, "pitch": -3.1, "roll": 0 }, "B": null, "X": null, "Y": null }
}
```
The preset manager dispatches to the device based on `kind`; the device is responsible for recall semantics.

---

## 7. Command Model — TypeScript Interfaces

A single `MotionDevice` interface in `src/devices/motionDevice.ts` becomes the
abstraction the state machine talks to. Both VISCA and DJI bridge implement it.

```ts
// src/devices/motionDevice.ts
export type PresetSlot = 'A' | 'B' | 'X' | 'Y';

export type DevicePosition =
  | { kind: 'visca'; pan: number; tilt: number; zoom: number }
  | { kind: 'gimbal'; yaw: number; pitch: number; roll: number; zoom?: number };

export interface DeviceCapabilities {
  pan: boolean;
  tilt: boolean;
  roll: boolean;
  zoom: boolean;
  position: boolean;   // can read current position
  moveTo: boolean;     // can absolute-position-move
}

export interface MotionDevice {
  readonly id: string;
  readonly label: string;
  readonly protocol: 'visca' | 'dji-bridge';
  readonly capabilities: DeviceCapabilities;
  readonly connected: boolean;

  connect(): void;
  close(): void;

  /** pan, tilt, zoom in [-1, 1]. Implementations must accept a steady stream. */
  setVelocity(v: { pan: number; tilt: number; zoom: number; roll?: number }): void;
  stop(): void;

  /** Read current position; reject if !capabilities.position. */
  getPosition(): Promise<DevicePosition>;

  /** Move to an absolute position; reject if !capabilities.moveTo. */
  moveTo(pos: DevicePosition): Promise<void>;

  /** Lightweight reachability check (used by the watchdog). */
  probe(timeoutMs?: number): Promise<boolean>;

  on(event: 'connected' | 'disconnected' | 'status', listener: (...args: any[]) => void): this;
}
```

### 7.1 VISCA implementation
Wrap the existing `ViscaClient` rather than modifying it:

```ts
// src/devices/viscaDevice.ts
export class ViscaDevice implements MotionDevice {
  readonly protocol = 'visca';
  readonly capabilities = { pan:true, tilt:true, roll:false, zoom:true, position:true, moveTo:true };
  constructor(private client: ViscaClient, public readonly id: string, public readonly label: string) {}
  setVelocity({pan,tilt,zoom: z}) {
    panTilt(this.client, pan, tilt);
    zoom(this.client, z);
  }
  stop() { stopPTZ(this.client); }
  async getPosition() {
    const p = await queryPosition(this.client);
    return { kind:'visca', ...p } as DevicePosition;
  }
  async moveTo(pos) {
    if (pos.kind !== 'visca') throw new Error('VISCA device requires visca position');
    gotoAbsolutePosition(this.client, pos);
  }
  probe(t?) { return this.client.probe(t); }
  // event forwarding…
}
```
The existing `Map<CameraId, ViscaClient>` becomes `Map<CameraId, MotionDevice>`. All five call sites change to interface methods. **No bytes change on the wire for any existing camera.**

### 7.2 DJI bridge implementation

```ts
// src/devices/djiBridgeDevice.ts
export class DjiBridgeDevice implements MotionDevice {
  readonly protocol = 'dji-bridge';
  capabilities: DeviceCapabilities = { pan:true, tilt:true, roll:false, zoom:false, position:false, moveTo:false };
  // After hello-ack, capabilities is overwritten from bridge's advertised set.
  // Owns: ws client, reconnect, heartbeat, last-status cache, in-flight request map.
}
```

---

## 8. Safety Behavior and Timeouts

**App-side**
- Velocity stream: while sticks are non-zero, the state machine sends a velocity frame each controller tick (≈ 33 Hz). When sticks return to zero it sends exactly one `stop`. This is what the VISCA path already does; the DJI path follows the same rhythm so the safety timeout never fires under normal use.
- If the WS to the Pi disconnects, the device's `connected` flag flips false and the state machine skips it — the user sees the gimbal go red in the UI just like a missing VISCA camera.
- Emergency stop (Back button) calls `device.stop()` on every motion device, including DJI.

**Bridge-side**
- Velocity command starts a 250 ms (configurable) watchdog. Any new velocity frame resets it; an explicit `stop` clears it. If it expires the bridge issues an SDK stop and emits `safetyStop {reason:"app_timeout"}`.
- SDK link loss: bridge issues SDK stop, emits `disconnected`, then attempts reconnect with backoff. While SDK is down the bridge keeps the WS open and answers `getPosition` / `moveVelocity` with `not_connected`.
- Motor temperature (if SDK exposes it): if exceeds threshold, refuse motion, emit `safetyStop {reason:"motor_overheat"}`.

**Hard rule:** the bridge is the last line of defense. Even if the app crashes mid-pan, the gimbal stops within `safetyTimeoutMs`.

---

## 9. Preset Storage — Recommendation

**Recommendation: app-side, unified file (with `kind` discriminator).**

Trade-off summary:
| | App-side | Pi-side |
|---|---|---|
| Operator UX | Identical save/recall across VISCA and DJI from one file | Behaves differently per device |
| Survives Pi reflash | Yes | No |
| Survives gimbal swap | Yes | Yes |
| Requires bridge to implement preset commands | No | Yes |
| Risk if app and Pi disagree | None | Possible drift |

App-side wins for this app's "one operator, many devices" usage pattern. Preset
manager calls `device.getPosition()` to save and `device.moveTo()` to recall; the
position payload is just a typed JSON blob the app doesn't interpret beyond its
discriminator. The Pi bridge's optional `savePreset`/`recallPreset` methods exist
for future use but stay unused by default.

---

## 10. Implementation Phases — GitHub Issues

Each phase is independently shippable and leaves the app working.

**Phase 0 — Abstraction seam (no behavior change)**
1. **Introduce `MotionDevice` interface and `ViscaDevice` wrapper.** Convert the five `Map<CameraId, ViscaClient>` consumers to use the interface. No DJI code, no config change. Smoke test must pass byte-for-byte against `VirtualVisca`.
2. **Preset format: add `kind:'visca'` discriminator** on read and write; migrate `config/presets.json` on load if legacy. Recall still calls `gotoAbsolutePosition`.

**Phase 1 — DJI device, simulator-only**
3. **Add `protocol` field to device config** with Zod refinement; default `visca`. Update [src/ui/statusServer.ts](src/ui/statusServer.ts) device editor.
4. **Implement `DjiBridgeDevice`** (WS client, hello, capability negotiation, velocity, stop, getPosition, moveTo, reconnect backoff, heartbeat). No real gimbal yet.
5. **Build mock Pi bridge** as `src/testing/virtualDjiBridge.ts`: in-process WS server that integrates velocity into yaw/pitch over time, supports getPosition, ack/event semantics. Hook into `npm run test:smoke`.
6. **State-machine wiring:** velocity stream and stop on stick release work for a DJI-typed device. Verified end-to-end against the virtual bridge.
7. **Preset save/recall** for DJI devices using `kind:'gimbal'` positions, via app-side store.
8. **Status UI:** show gimbal connection state, bridge RTT, SDK state, current yaw/pitch.

**Phase 2 — Real Pi bridge**
9. **Pi bridge service (Python).** Skeleton: WS server, hello, heartbeat, safety watchdog, capability advertising, mock SDK adapter. Run on dev box first.
10. **DJI RS SDK adapter.** Evaluate ConstantRobotics/DJIR_SDK first (see §11). Implement `move_velocity`, `stop`, `get_attitude`. Pin to one model (RS4 Pro). Ship behind a `--driver dji-rs-sdk` flag; default driver remains `mock`.
11. **Hardware bring-up doc + systemd unit** for the Pi. Out-of-scope for app code but blocks Phase 3 acceptance.

**Phase 3 — Polish**
12. **Roll axis** (opt-in via config, capability-gated).
13. **Recenter / follow-mode buttons** mapped to a controller chord.
14. **Sony PZ lens stub:** a third `MotionDevice` impl that proves the abstraction holds.

Tiny, mergeable issues — none of these rewrite the app.

---

## 11. Test Plan

**Unit / integration (no hardware)**
- Extend [src/testing/virtualVisca.ts](src/testing/virtualVisca.ts) coverage to verify `ViscaDevice` wrapper produces identical wire output to today.
- New `VirtualDjiBridge`: hosted in-process, asserts the protocol contract end-to-end:
  - hello → capability negotiation
  - velocity ↦ integrated position
  - stop and safety-timeout stop
  - reconnect handles drop mid-stream
  - heartbeat RTT measurement
- State-machine test: with a mixed config (2 VISCA + 1 DJI), stick input routes to the controlled device only; switching cameras routes correctly; emergency stop hits both protocols.

**Smoke**
- `npm run test:smoke` extended to include a DJI device backed by the virtual bridge. Goal: prove no regression in the existing VISCA/ATEM smoke flow.

**Manual / hardware**
- Bench test the Pi bridge against the gimbal with a CLI client (`wscat`) before pointing the app at it.
- Run the app with `protocol: dji-bridge` pointing at the Pi. Verify: stick pan/tilt, stop on release, preset save/recall, watchdog stops gimbal on Pi power loss, emergency stop, reconnect after `kill -9` of the bridge.
- Soak test: 30-minute idle session, ensure no drift, no runaway motion, no zombie SDK sessions on the Pi.

**Pre-flight before any live show**
- Verify capability set matches expectations.
- Confirm `safetyTimeoutMs` is honored by physically yanking the Ethernet on the Pi.

---

## 12. SDK and Hardware — Verified Findings

Findings below are from fetching each project's docs/README in 2026-05. Cite this section, not §13, when planning Phase 2.

### 12.1 DJI Official RS SDK (dji.com/rs-sdk) — **PRIMARY ADAPTER**

- Officially lists **RS 5, RS 4 Pro, RS 4, and RS 3 Pro** as supported. This is the only source that explicitly covers RS4 Pro.
- SDK Documentation, Demo Software, and the "RS Stabilizer External Interface Diagram" PDF are **publicly downloadable, no NDA gate**.
- Transport: CAN over the gimbal's expansion port (1 Mbit, per the External Interface Diagram). Demo code historically C/C++.
- **Plan:** the Pi bridge wraps DJI's C/C++ demo into a small daemon. Node app stays untouched. If the SDK ships as Linux shared library, Python+ctypes is fine; if Windows-only binaries (a known DJI pattern), fall back to §12.2.

### 12.2 ConstantRobotics/DJIR_SDK — **SECONDARY FALLBACK**

- Pure C++, no ROS. Implements "DJI R SDK protocol v2.2" — same protocol family DJI extended through RS3/RS4 Pro, so likely wire-compatible (unverified by maintainer; README names RS2 only).
- API maps directly to our four verbs: `set_speed(yaw,roll,pitch)`, `move_to(...)`, `get_current_position()`, stop.
- **Two problems before we can ship it:**
  1. **License is not declared** in the README — must verify the repo's `LICENSE` file before vendoring into a proprietary app. If unclear, contact the author or reimplement.
  2. Hard-coded to **GCAN USBCAN-II C** adapter (Shenyang Guangcheng, proprietary driver, Windows-leaning). Would need porting to SocketCAN for Pi.

### 12.3 Hibiki1020/dji_rs3pro_ros_controller — **LIFT CAN FRAME LAYOUT ONLY**

- Python, but tightly coupled to ROS nodes/launch files. Not importable wholesale.
- README explicitly states it should work on "other DJI gimbals as long as DJI doesn't change the protocol" — best OSS signal we have that the protocol generalizes, still unverified for RS4 Pro.
- Uses **Lawicel CANUSB** with a 9-pin D-sub → DJI Focus Wheel's 4-pin Dupont.
- No license declared. Reference CAN-ID layout and SocketCAN wiring patterns, but don't vendor.

### 12.4 ceinem/dji_rs2_ros_controller — **REFERENCE ONLY**

- Python + ROS + `socketcan_bridge`. RS2 only. No license.
- Superseded by Hibiki's RS3 Pro fork. Keep only to cross-check protocol fields.

### 12.5 ArduPilot DJI-RS2 gimbal driver — **WIRING REFERENCE ONLY**

- Officially supports only RS2 and RS3 Pro. RS4 Pro not mentioned, explicitly excludes RSC2 and RS3 (non-Pro).
- Not code-reusable (lives inside ArduPilot rover firmware in C++), but **the wiring page is the canonical pinout reference**: CAN1/CAN2 → DJI R Focus Wheel → gimbal expansion port, with a documented Focus-Wheel-less variant (pinout rotated 180°).

### 12.6 rileycoyote87/DJI-Ronin-RS2-Log-and-Replay — **PATTERN ONLY, LICENSE-BLOCKED**

- Python 3, records/replays yaw/roll/pitch/focus over CAN (CANable Pro or CANUSB).
- **CC BY-NC 4.0 — non-commercial only.** Cannot ship its code in a closed product. Useful as a *pattern* for `moveToPosition` / preset recall, but write our own.

### 12.7 USB-C Alone Is Not An Option

**Verified:** the USB-C port on RS4 Pro / RS3 Pro / any RS-series gimbal cannot drive motion. It handles charging, firmware updates via the Ronin app, and camera-shutter passthrough — not gimbal commands. The RS SDK speaks **CAN bus only**, over the 4-pin RSA expansion port. Every open-source project that actually moves a gimbal (DJIR_SDK, Hibiki1020 RS3 Pro controller, rileycoyote87) uses a USB-CAN adapter. The DJI R Focus Wheel is another CAN client on the same bus, not a USB bridge.

There is no firmware-update path, no hidden HID interface, no webcam-mode trick. CAN is required.

### 12.8 Production Hardware (Raspberry Pi 5)

Recommended build for a permanent install on the camera cart. One Ethernet cable from the cart to the PoE++ switch carries both data and power; no separate PSU.

```
[PoE++ switch] ──Ethernet──▶ [PoE++ splitter] ──┬── Ethernet ──▶ Pi 5
                                                  └── 12V ──▶ PiCAN3 barrel-in
                                                                    │
                                                              PiCAN3 powers Pi
                                                              via GPIO 5V rail
                                                                    │
                                                              RSA pigtail ──▶ Gimbal R-Port
```

| Component | Purpose | Approx. cost |
|---|---|---|
| **Raspberry Pi 5** (4 GB or 8 GB) | Runs the bridge daemon | $60–80 |
| **PoE Texas GAF-1230Bt** (or equivalent 802.3bt splitter with 12V output, ≥30W) | PoE++ → 12V tap for the PiCAN3 + Ethernet passthrough | $25 |
| **PiCAN3 HAT (SK Pang)** | SocketCAN-native CAN controller; 6–20 V regulated input that powers the Pi via the GPIO 5V rail | $70 |
| **RSA pigtail cable** | 4-pin GH1.25 breakout to the gimbal's expansion port (ConstantRobotics, Middle Things APC-R, Inkwa) | $15–25 |
| Small enclosure + tall standoffs | Mechanical mount | $15 |

**Total ≈ $200**, single Ethernet drop, no USB cables to vibrate loose, swappable parts.

**Bus setup (same for every CAN HAT option):**
```bash
sudo ip link set can0 up type can bitrate 1000000   # DJI RS SDK protocol v2.2, 1 Mbit
```
Verify against the DJI RS Stabilizer External Interface Diagram PDF before powering on the gimbal.

**Alternative: stacked PoE HAT + CAN HAT.** If you want zero inline boxes (no splitter), use the **official Raspberry Pi PoE+ HAT for Pi 5** (or the Pi 5 PoE++ HAT, 802.3bt) on the bottom and a **Waveshare 2-CH CAN FD HAT** stacked on top via tall standoffs and a 2×20 extended stacking header. GPIO pins do not conflict in practice (PoE HAT uses the 4 dedicated PoE pins + I²C for the fan; CAN HAT uses SPI0 + 1–2 IRQ/CS pins). Trade-off: physically taller, harder to enclose, slightly more failure-prone if you ever pop a HAT off in the field. Software is identical (`can0` still appears via SocketCAN).

**Field-spare kit:** keep one **CANable Pro 2.0** (~$40) in the gig bag. If a HAT ever flakes mid-show, drop the SD card into any spare Pi with a CANable plugged in and the bridge is back up — same software, same `can0`.

**Avoid:** GCAN USBCAN-II C (Windows-only driver, what DJIR_SDK hard-codes).

### 12.9 Recommended Phase 2 Order of Operations

1. Download the official DJI RS SDK + External Interface Diagram PDF. Verify RS4 Pro CAN pinout, bitrate, and that the SDK ships a Linux build (or at least a documented protocol we can implement in 200 lines of C if it's Windows-only).
2. Order: PiCAN2, DJI R Focus Wheel (or fabricate the bypass cable per ArduPilot pinout), male-to-female Dupont jumpers.
3. On the Pi: bring up SocketCAN at 1 Mbit (`sudo ip link set can0 up type can bitrate 1000000`), use `candump` against the gimbal to confirm we can see frames before writing any bridge code.
4. Prototype the bridge daemon against the SDK's demo code or — if the SDK is Linux-unfriendly — against DJIR_SDK after a license check and a SocketCAN port.
5. Only then wire the daemon's WebSocket front-end to the Node app.

## 13. Remaining Risks

**SDK Linux support is the only real unknown left.** DJI has historically shipped Windows-only SDK binaries for some products. If that's true here, Phase 2 splits into:
- a small C daemon implementing the documented CAN protocol directly (the Interface Diagram PDF is the spec), or
- a SocketCAN-ported fork of DJIR_SDK (license permitting).

Either path is bounded work; the mock bridge from Phase 1 keeps the app shippable while this gets sorted.

**Firmware drift** on the gimbal can change SDK behavior. Pin a known-good firmware before each show.

**Operational:** one Pi per gimbal means more boxes to manage. Mitigated by treating the bridge like an appliance: static IP, systemd unit, read-only rootfs if we want to be fancy.

**Out of scope but worth flagging**
- Video routing for the gimbal's camera into ATEM (HDMI/SDI converter) is a separate problem.
- Sony PZ lens control is mentioned only to validate the abstraction — its own spec when we get there.

**Latency**
- WS over LAN: ~1–3 ms typical, well under one controller tick. Acceptable.
- SDK round-trip on Pi: unknown until measured. If `getPosition` blocks longer than a tick, app must poll asynchronously (already designed this way — `getPosition` returns a Promise).

**License**
- ConstantRobotics SDK and the ROS-based controllers need a license review before we vendor any code. Default plan is to call into them as a separate process or rewrite the minimal subset we need.

**Operational**
- One-Pi-per-gimbal means more boxes to manage. Mitigated by treating the bridge like a small appliance with a systemd unit and a static IP.
- Firmware drift on the gimbal can change SDK behavior. Pin a known-good firmware before each show.

**Out of scope but worth flagging**
- Video routing for the gimbal's camera into ATEM (HDMI/SDI converter) is a separate problem.
- Sony PZ lens control is mentioned only to validate the abstraction — actual integration is its own spec.

---

## 14. Summary

The smallest correct change is: introduce a `MotionDevice` interface, wrap the
existing `ViscaClient` behind it, and add a `DjiBridgeDevice` that speaks a small
WebSocket/JSON protocol to a Pi-hosted bridge. Generic motion commands flow
app → Pi; the Pi owns the DJI SDK, safety, and hardware messiness. Presets stay
app-side and unified. A mock bridge lets Phase 1 ship and be tested before the
real Pi or gimbal exists, and the same abstraction admits Sony PZ lens or NDI
PTZ later without further refactors.
