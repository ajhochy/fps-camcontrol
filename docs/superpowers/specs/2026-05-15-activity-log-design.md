# Activity Log — Design Spec
*2026-05-15*

## Goal

Add a real-time activity log to the web UI showing every discrete action the app takes, including the exact bytes or API calls sent over the network, so operators can verify that controller inputs produce the correct VISCA and ATEM messages and can diagnose routing errors by name and IP.

---

## Log Entry Shape

Each entry is a flat object:

| Field        | Type   | Description |
|---|---|---|
| `ts`         | number | Unix ms timestamp |
| `device`     | string | Controller profile name ("Xbox", "Wii U Pro", "Unknown") |
| `input`      | string | Human-readable input label ("Right Stick", "A Button", "Right Trigger") |
| `command`    | string | Action name ("Pan/Tilt Start", "Zoom Stop", "Cut Live", "Preset A Recall", "Lower Thirds ON", "Emergency Stop", etc.) |
| `protocol`   | string | `"VISCA"` \| `"ATEM"` \| `"System"` |
| `message`    | string | Exact wire content: hex bytes for VISCA ("81 01 06 01 0C 0C 01 02 FF"), API call string for ATEM ("changePreviewInput(2) + cut()"), or description for System events |
| `targetName` | string | Friendly device name from config ("BirdDog 1", "V-BOT", "ATEM Switcher", "All Cameras") |
| `targetIp`   | string | IP address of target device |

---

## Architecture

### ActivityLog class (`src/app/activityLog.ts`)

- Ring buffer capped at 500 entries.
- Extends `EventEmitter`; emits `'entry'` with each new `ActivityEntry` so consumers can push in real time.
- Public API:
  - `setContext(device: string, input: string, command: string)` — called by CSM just before an action fires; stored as pending context.
  - `addEntry(partial: Omit<ActivityEntry, 'ts' | 'device' | 'input' | 'command'>)` — called by ViscaClient / AtemClient; merges pending context, stamps timestamp, pushes to buffer, emits `'entry'`. Clears pending context after use.
  - `getAll(): ActivityEntry[]` — returns a copy of the ring buffer in chronological order.
  - `clear()` — empties the buffer.

### Context flow

```
CSM.tick()
  ├─ setContext("Xbox", "Right Stick", "Pan/Tilt Start")
  ├─ panTilt(client, panX, panY)
  │     └─ client.sendPayload([0x81, 0x01, 0x06, 0x01, ...])
  │           └─ activityLog.addEntry({ protocol:"VISCA", message:"81 01 06 01 ...", targetName:"BirdDog 1", targetIp:"192.168.50.16" })
  │                 → merges context → emits entry
  └─ (context cleared)
```

`setContext` is called immediately before the action that will trigger a `sendPayload` or ATEM call. If context is not consumed within a single synchronous call chain it is silently cleared on the next `setContext` call to prevent stale context leaking.

### ViscaClient changes (`src/visca/viscaClient.ts`)

- Accepts optional `activityLog: ActivityLog` in constructor (default `null`).
- In `sendPayload()`: after building the packet, if `activityLog` is set, call `activityLog.addEntry({ protocol: 'VISCA', message: hexString, targetName: this.label, targetIp: this.ip })`.
- New `label` property set from camera config at construction time.

### AtemClient changes (`src/atem/atemClient.ts`)

- Accepts optional `activityLog: ActivityLog` in constructor.
- Each public method (`cut`, `autoTransition`, `changePreviewInput`, `setDownstreamKeyOnAir`, `setUpstreamKeyerOnAir`) calls `activityLog.addEntry(...)` with a descriptive `message` string and `targetName: "ATEM Switcher"` / `targetIp: this.ip` before dispatching to the `atem-connection` library.

### ControlStateMachine changes (`src/model/controlStateMachine.ts`)

- Receives `activityLog: ActivityLog` in constructor.
- Movement start/stop tracking: two new private booleans `wasMovingPT` and `wasMovingZoom`. On each tick, after applying deadzone:
  - If `(rightX !== 0 || rightY !== 0) && !wasMovingPT` → `setContext(..., "Pan/Tilt Start")`, then call `panTilt`. Set `wasMovingPT = true`.
  - If `(rightX === 0 && rightY === 0) && wasMovingPT` → `setContext(..., "Pan/Tilt Stop")`, then call `stopPanTilt`. Set `wasMovingPT = false`.
  - Same pattern for zoom with `leftY` and `wasMovingZoom`.
- All discrete actions (cut, auto, preset recall/save, speed, lower thirds, emergency stop, camera switch) call `setContext` with the appropriate input/command label before the action.
- Active controller profile name comes from `state.activeControllerProfile` (already on AppState).

### Input label map (inside CSM)

| Raw input key    | Display label     |
|---|---|
| `rightStickX/Y`  | Right Stick       |
| `leftStickY`     | Left Stick Y      |
| `leftStickX`     | Left Stick X      |
| `rightTrigger`   | Right Trigger     |
| `RB`             | RB Button         |
| `LB + A/B/X/Y`  | LB + A / LB + B … |
| `A/B/X/Y`        | A / B / X / Y Button |
| `dpadUp/Down`    | D-pad Up / Down   |
| `dpadLeft/Right` | D-pad Left/Right  |
| `back`           | Back Button       |

---

## API & Delivery

### REST endpoint

`GET /api/activity` — returns `{ entries: ActivityEntry[] }` (all entries in the ring buffer, oldest first).

### WebSocket channel

New WebSocket path `/ws/activity` on the existing HTTP server. On connection, sends the full current buffer as a JSON array. Each new entry is pushed as a single-line JSON object as it arrives. The browser appends rows without needing to poll.

---

## UI Panel

- New "Activity Log" panel added to the bottom of the status page.
- Fixed-height scrollable table, 320px tall, `overflow-y: auto`.
- Columns (left to right): **Time** | **Device** | **Input** | **Command** | **Proto** | **Message** | **Target** | **IP**
- Row color coding:
  - VISCA rows: subtle blue tint (`background: #0a1a2a`)
  - ATEM rows: subtle orange tint (`background: #2a1a0a`)
  - System rows: default dark (`background: #111`)
- Auto-scroll to bottom when new entries arrive, **unless** the user has manually scrolled up (detect via `scrollTop + clientHeight < scrollHeight - 10`).
- "Clear" button in the panel header — calls `DELETE /api/activity` and clears the local display.
- On page load, opens the WebSocket and requests the current buffer. Falls back to polling `/api/activity` every 2 s if WebSocket fails.
- Time column shows `HH:MM:SS.mmm` (local time).
- Message column is monospace, truncated to ~60 chars with full text on hover (title attribute).

---

## Files Changed

| File | Change |
|---|---|
| `src/app/activityLog.ts` | **New** — ActivityLog class |
| `src/visca/viscaClient.ts` | Add `label` property, accept `activityLog`, log in `sendPayload` |
| `src/atem/atemClient.ts` | Accept `activityLog`, log in each public command method |
| `src/model/controlStateMachine.ts` | Accept `activityLog`, add movement tracking, call `setContext` before all actions |
| `src/index.ts` | Construct `ActivityLog`, pass to ViscaClient, AtemClient, CSM, statusServer |
| `src/ui/statusServer.ts` | Add `/api/activity` GET + DELETE, `/ws/activity` WebSocket, Activity Log UI panel |

---

## Example Log Lines

```
10:25:37.001 | Xbox  | Right Stick  | Pan/Tilt Start | VISCA | 81 01 06 01 0C 0C 01 02 FF  | BirdDog 1     | 192.168.50.16
10:25:37.640 | Xbox  | Right Stick  | Pan/Tilt Stop  | VISCA | 81 01 06 01 00 00 03 03 FF  | BirdDog 1     | 192.168.50.16
10:25:37.641 | Xbox  | Right Stick  | Zoom Stop      | VISCA | 81 01 04 07 00 FF           | BirdDog 1     | 192.168.50.16
10:25:38.123 | Xbox  | Rt Trigger   | Cut Live       | ATEM  | changePreviewInput(2)+cut() | ATEM Switcher | 192.168.50.10
10:25:39.400 | Xbox  | LB + A       | Preset A Save  | VISCA | 81 09 06 12 FF              | V-BOT         | 192.168.50.15
10:25:40.011 | Xbox  | D-pad Left   | Lower Thirds   | ATEM  | setDSK(0, on=true)         | ATEM Switcher | 192.168.50.10
10:25:41.300 | Xbox  | Left Stick X | Cam → BirdDog 2| System| —                          | —             | —
```
