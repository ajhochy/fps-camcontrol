# Activity Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real-time activity log to the web UI showing every discrete action (controller input → command → exact wire bytes → target device name + IP) for live troubleshooting of VISCA and ATEM messaging.

**Architecture:** A new `ActivityLog` class holds a 500-entry ring buffer and emits an `'entry'` event on each add. CSM calls `setContext(device, input, command)` just before each action; `ViscaClient.sendPayload()` and `AtemClient` command methods consume that context to create a complete log entry with real wire bytes. A new `/api/activity` REST endpoint and `/ws/activity` WebSocket push entries to a new Activity Log panel in the UI.

**Tech Stack:** TypeScript, Node.js EventEmitter, Express, `ws` WebSocket (already installed), existing `statusHtml()` template literal pattern.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/app/activityLog.ts` | **Create** | Ring buffer, context model, EventEmitter |
| `src/visca/viscaClient.ts` | **Modify** | Accept `activityLog` + `label`, log in `sendPayload` |
| `src/atem/atemClient.ts` | **Modify** | Accept `activityLog`, log in each command method |
| `src/model/controlStateMachine.ts` | **Modify** | Accept `activityLog`, movement tracking, `setContext` calls |
| `src/index.ts` | **Modify** | Construct `ActivityLog`, thread to ViscaClient/AtemClient/CSM/statusServer |
| `src/ui/statusServer.ts` | **Modify** | `/api/activity` GET+DELETE, `/ws/activity`, Activity Log panel HTML+JS |

---

## Task 1: Create ActivityLog class

**Files:**
- Create: `src/app/activityLog.ts`

- [ ] **Step 1: Write the file**

```typescript
// src/app/activityLog.ts
import { EventEmitter } from 'events';

export interface ActivityEntry {
  ts: number;
  device: string;
  input: string;
  command: string;
  protocol: 'VISCA' | 'ATEM' | 'System';
  message: string;
  targetName: string;
  targetIp: string;
}

interface PendingContext {
  device: string;
  input: string;
  command: string;
}

const MAX_ENTRIES = 500;

export class ActivityLog extends EventEmitter {
  private buffer: ActivityEntry[] = [];
  private pendingContext: PendingContext | null = null;

  setContext(device: string, input: string, command: string): void {
    this.pendingContext = { device, input, command };
  }

  addEntry(partial: Omit<ActivityEntry, 'ts' | 'device' | 'input' | 'command'>): void {
    const ctx = this.pendingContext ?? { device: 'unknown', input: '—', command: '—' };
    this.pendingContext = null;
    const entry: ActivityEntry = { ts: Date.now(), ...ctx, ...partial };
    if (this.buffer.length >= MAX_ENTRIES) this.buffer.shift();
    this.buffer.push(entry);
    this.emit('entry', entry);
  }

  addSystemEntry(command: string, message: string): void {
    const ctx = this.pendingContext ?? { device: '—', input: '—', command };
    this.pendingContext = null;
    const entry: ActivityEntry = {
      ts: Date.now(),
      device: ctx.device,
      input: ctx.input,
      command: ctx.command,
      protocol: 'System',
      message,
      targetName: '—',
      targetIp: '—',
    };
    if (this.buffer.length >= MAX_ENTRIES) this.buffer.shift();
    this.buffer.push(entry);
    this.emit('entry', entry);
  }

  getAll(): ActivityEntry[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer = [];
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/activityLog.ts
git commit -m "feat: add ActivityLog class with ring buffer and context model"
```

---

## Task 2: Wire ActivityLog into ViscaClient

**Files:**
- Modify: `src/visca/viscaClient.ts`

- [ ] **Step 1: Add `label` and `activityLog` to ViscaClient**

Add two private fields and update the constructor. Find the class declaration block:

```typescript
// BEFORE (existing fields near top of class):
  private cameraType: string;
  private backoff = BACKOFF_INITIAL;
  ...
  connected = false;

  constructor(cameraId: string, ip: string, port: number, cameraType = 'generic') {
    super();
    this.cameraId = cameraId;
    this.ip = ip;
    this.port = port;
    this.cameraType = cameraType;
  }
```

```typescript
// AFTER:
  private cameraType: string;
  label = '';
  private activityLog: import('../app/activityLog').ActivityLog | null = null;
  private backoff = BACKOFF_INITIAL;
  ...
  connected = false;

  constructor(cameraId: string, ip: string, port: number, cameraType = 'generic') {
    super();
    this.cameraId = cameraId;
    this.ip = ip;
    this.port = port;
    this.cameraType = cameraType;
  }

  setActivityLog(log: import('../app/activityLog').ActivityLog, label: string): void {
    this.activityLog = log;
    this.label = label;
  }
```

- [ ] **Step 2: Log in `sendPayload`**

Find the `sendPayload` method and add logging after building the packet, before calling `send`:

```typescript
  sendPayload(payload: number[]): void {
    this.seqNum = (this.seqNum + 1) >>> 0;
    const lenHi = (payload.length >> 8) & 0xFF;
    const lenLo = payload.length & 0xFF;
    const seqB0 = (this.seqNum >> 24) & 0xFF;
    const seqB1 = (this.seqNum >> 16) & 0xFF;
    const seqB2 = (this.seqNum >> 8) & 0xFF;
    const seqB3 = this.seqNum & 0xFF;
    const packet = Buffer.from([0x01, 0x00, lenHi, lenLo, seqB0, seqB1, seqB2, seqB3, ...payload]);
    if (this.activityLog) {
      const hex = payload.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
      this.activityLog.addEntry({
        protocol: 'VISCA',
        message: hex,
        targetName: this.label || this.cameraId,
        targetIp: this.ip,
      });
    }
    this.send(packet);
  }
```

Note: `send` now receives the pre-built `packet` Buffer directly. Update `send` to accept a Buffer parameter instead of building its own:

```typescript
  send(bytes: Buffer): void {
    if (!this.connected || !this.socket) {
      logger.warn({ cameraId: this.cameraId }, 'VISCA not connected, dropping command');
      return;
    }
    this.socket.send(bytes, 0, bytes.length, this.port, this.ip, (err) => {
      if (err) logger.warn({ err, cameraId: this.cameraId }, 'VISCA send error');
    });
  }
```

(No change needed to `send` — it already accepts a Buffer. Just make sure `sendPayload` passes the built packet rather than rebuilding inside `send`.)

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/visca/viscaClient.ts
git commit -m "feat: add activityLog + label to ViscaClient, log hex bytes in sendPayload"
```

---

## Task 3: Wire ActivityLog into AtemClient

**Files:**
- Modify: `src/atem/atemClient.ts`

- [ ] **Step 1: Add `activityLog` field and setter**

After the existing fields and constructor, add:

```typescript
  // existing fields:
  private atem: Atem;
  private ip: string;
  private backoff = BACKOFF_INITIAL;
  private reconnectTimer: NodeJS.Timeout | null = null;
  connected = false;
  private activityLog: import('../app/activityLog').ActivityLog | null = null;

  // add setter after constructor:
  setActivityLog(log: import('../app/activityLog').ActivityLog): void {
    this.activityLog = log;
  }
```

- [ ] **Step 2: Add logging to each command method**

Replace the five command methods with logging versions:

```typescript
  async changePreviewInput(inputId: number, meIndex = 0): Promise<void> {
    if (!this.connected) { logger.warn('ATEM not connected, dropping changePreviewInput'); return; }
    this.activityLog?.addEntry({
      protocol: 'ATEM',
      message: `changePreviewInput(inputId=${inputId}, me=${meIndex})`,
      targetName: 'ATEM Switcher',
      targetIp: this.ip,
    });
    await this.atem.changePreviewInput(inputId, meIndex);
  }

  async cut(meIndex = 0): Promise<void> {
    if (!this.connected) { logger.warn('ATEM not connected, dropping cut'); return; }
    this.activityLog?.addEntry({
      protocol: 'ATEM',
      message: `cut(me=${meIndex})`,
      targetName: 'ATEM Switcher',
      targetIp: this.ip,
    });
    await this.atem.cut(meIndex);
  }

  async autoTransition(meIndex = 0): Promise<void> {
    if (!this.connected) { logger.warn('ATEM not connected, dropping autoTransition'); return; }
    this.activityLog?.addEntry({
      protocol: 'ATEM',
      message: `autoTransition(me=${meIndex})`,
      targetName: 'ATEM Switcher',
      targetIp: this.ip,
    });
    await this.atem.autoTransition(meIndex);
  }

  async setDownstreamKeyOnAir(dskIndex: number, onAir: boolean): Promise<void> {
    if (!this.connected) { logger.warn('ATEM not connected, dropping setDownstreamKeyOnAir'); return; }
    this.activityLog?.addEntry({
      protocol: 'ATEM',
      message: `setDownstreamKeyOnAir(dsk=${dskIndex}, onAir=${onAir})`,
      targetName: 'ATEM Switcher',
      targetIp: this.ip,
    });
    await this.atem.setDownstreamKeyOnAir(onAir, dskIndex);
  }

  async setUpstreamKeyerOnAir(meIndex: number, keyIndex: number, onAir: boolean): Promise<void> {
    if (!this.connected) { logger.warn('ATEM not connected, dropping setUpstreamKeyerOnAir'); return; }
    this.activityLog?.addEntry({
      protocol: 'ATEM',
      message: `setUpstreamKeyerOnAir(me=${meIndex}, key=${keyIndex}, onAir=${onAir})`,
      targetName: 'ATEM Switcher',
      targetIp: this.ip,
    });
    await (this.atem as any).setUpstreamKeyerOnAir(meIndex, keyIndex, onAir);
  }
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/atem/atemClient.ts
git commit -m "feat: add activityLog to AtemClient, log all command methods"
```

---

## Task 4: Instrument ControlStateMachine

**Files:**
- Modify: `src/model/controlStateMachine.ts`

- [ ] **Step 1: Add `activityLog` and movement-tracking fields, update constructor**

```typescript
import { ActivityLog } from '../app/activityLog';

// Input label map — human-readable names for log entries
const INPUT_LABELS: Record<string, string> = {
  rightStick: 'Right Stick',
  leftStickY: 'Left Stick Y',
  leftStickX: 'Left Stick X',
  rightTrigger: 'Right Trigger',
  RB: 'RB Button',
  A: 'A Button',
  B: 'B Button',
  X: 'X Button',
  Y: 'Y Button',
  dpadUp: 'D-pad Up',
  dpadDown: 'D-pad Down',
  dpadLeft: 'D-pad Left',
  dpadRight: 'D-pad Right',
  back: 'Back Button',
};

export class ControlStateMachine {
  private edgeState: EdgeState = createEdgeState();
  private lastInput: NormalizedInput | null = null;
  private cameraSelector: CameraSelector;
  private presetManager: PresetManager;
  private speedManager: SpeedManager;
  private wasMovingPT = false;
  private wasMovingZoom = false;
  private activityLog: ActivityLog | null;

  constructor(
    private state: AppState,
    private config: AppConfig,
    private atem: AtemClient,
    private viscaClients: Map<CameraId, ViscaClient>,
    activityLog: ActivityLog | null = null
  ) {
    this.activityLog = activityLog;
    this.cameraSelector = new CameraSelector(state, config.cameras, atem, viscaClients);
    this.presetManager = new PresetManager(state, config, viscaClients);
    this.speedManager = new SpeedManager(state, config);
  }
```

- [ ] **Step 2: Replace the `tick()` method with movement tracking and `setContext` calls**

Replace the entire `tick()` method:

```typescript
  tick(): void {
    const input = this.lastInput;
    if (!input) return;

    const device = this.state.activeControllerProfile ?? 'Unknown';

    this.state.precisionMode = (input.triggers['leftTrigger'] ?? 0) >= LT_THRESHOLD;
    this.state.sprintMode = input.buttons['LS'] ?? false;

    // Camera selector — left stick X flick
    const leftX = applyDeadzone(input.axes['leftStickX'] ?? 0);
    const prevCamera = this.state.controlledCamera;
    this.cameraSelector.handleLeftStickX(leftX);
    if (this.state.controlledCamera !== prevCamera) {
      const camLabel = this.config.cameras.find(c => c.id === this.state.controlledCamera)?.label ?? this.state.controlledCamera;
      this.activityLog?.setContext(device, INPUT_LABELS['leftStickX'], `Cam → ${camLabel}`);
      this.activityLog?.addSystemEntry(`Cam → ${camLabel}`, '—');
    }

    // PTZ — right stick + left stick Y
    const rightX = applyDeadzone(input.axes['rightStickX'] ?? 0);
    const rightY = applyDeadzone(input.axes['rightStickY'] ?? 0);
    const leftY = applyDeadzone(input.axes['leftStickY'] ?? 0);
    const movingPT = rightX !== 0 || rightY !== 0;
    const movingZoom = leftY !== 0;

    const currentClient = this.viscaClients.get(this.state.controlledCamera);
    if (currentClient) {
      // Pan/tilt start
      if (movingPT && !this.wasMovingPT) {
        this.activityLog?.setContext(device, INPUT_LABELS['rightStick'], 'Pan/Tilt Start');
      }
      // Pan/tilt stop
      if (!movingPT && this.wasMovingPT) {
        this.activityLog?.setContext(device, INPUT_LABELS['rightStick'], 'Pan/Tilt Stop');
        stopPTZ(currentClient);
      }
      if (movingPT) {
        panTilt(currentClient, this.getEffectiveSpeed(rightX), this.getEffectiveSpeed(-rightY));
      }

      // Zoom start
      if (movingZoom && !this.wasMovingZoom) {
        this.activityLog?.setContext(device, INPUT_LABELS['leftStickY'], 'Zoom Start');
      }
      // Zoom stop
      if (!movingZoom && this.wasMovingZoom) {
        this.activityLog?.setContext(device, INPUT_LABELS['leftStickY'], 'Zoom Stop');
        zoom(currentClient, 0);
      }
      if (movingZoom) {
        zoom(currentClient, this.getEffectiveSpeed(-leftY));
      }
    }

    this.wasMovingPT = movingPT;
    this.wasMovingZoom = movingZoom;

    // RT — cut live
    if (triggerRisingEdge('rightTrigger', input.triggers['rightTrigger'] ?? 0, RT_THRESHOLD, this.edgeState)) {
      this.activityLog?.setContext(device, INPUT_LABELS['rightTrigger'], 'Cut Live');
      cutControlledCameraLive(this.atem, this.state, this.config.cameras).catch(err => {
        logger.error({ err }, 'cut live error');
      });
    }

    // RB — auto transition
    if (risingEdge('RB', input.buttons['RB'] ?? false, this.edgeState)) {
      this.activityLog?.setContext(device, INPUT_LABELS['RB'], 'Auto Transition');
      autoTransitionControlledCamera(this.atem, this.state, this.config.cameras).catch(err => {
        logger.error({ err }, 'auto transition error');
      });
    }

    // LB modifier — preset save/recall
    const lbHeld = input.buttons['LB'] ?? false;
    for (const slot of ['A', 'B', 'X', 'Y'] as PresetSlot[]) {
      const pressed = risingEdge(slot, input.buttons[slot] ?? false, this.edgeState);
      if (pressed) {
        if (lbHeld) {
          this.activityLog?.setContext(device, `LB + ${slot}`, `Preset ${slot} Save`);
          this.presetManager.savePreset(this.state.controlledCamera, slot).catch(err => {
            logger.error({ err }, 'preset save error');
          });
        } else {
          this.activityLog?.setContext(device, `${slot} ${INPUT_LABELS[slot]}`, `Preset ${slot} Recall`);
          this.presetManager.recallPreset(this.state.controlledCamera, slot).catch(err => {
            logger.error({ err }, 'preset recall error');
          });
        }
      }
    }

    // Speed presets — D-pad up/down
    if (risingEdge('dpadUp', input.buttons['dpadUp'] ?? false, this.edgeState)) {
      this.speedManager.increment();
      const name = this.config.speeds.presets[this.state.speedPreset]?.name ?? String(this.state.speedPreset);
      this.activityLog?.setContext(device, INPUT_LABELS['dpadUp'], 'Speed Up');
      this.activityLog?.addSystemEntry('Speed Up', `Speed → ${name}`);
    }
    if (risingEdge('dpadDown', input.buttons['dpadDown'] ?? false, this.edgeState)) {
      this.speedManager.decrement();
      const name = this.config.speeds.presets[this.state.speedPreset]?.name ?? String(this.state.speedPreset);
      this.activityLog?.setContext(device, INPUT_LABELS['dpadDown'], 'Speed Down');
      this.activityLog?.addSystemEntry('Speed Down', `Speed → ${name}`);
    }

    // Lower thirds — D-pad left or right
    const ltToggle =
      risingEdge('dpadLeft', input.buttons['dpadLeft'] ?? false, this.edgeState) ||
      risingEdge('dpadRight', input.buttons['dpadRight'] ?? false, this.edgeState);
    if (ltToggle) {
      const newState = !this.state.lowerThirdsActive;
      this.activityLog?.setContext(device, 'D-pad Left/Right', `Lower Thirds ${newState ? 'ON' : 'OFF'}`);
      toggleLowerThirds(this.atem, this.state, this.config).catch(err => {
        logger.error({ err }, 'lower thirds toggle error');
      });
    }

    // Emergency stop — back button
    if (risingEdge('back', input.buttons['back'] ?? false, this.edgeState)) {
      this.activityLog?.setContext(device, INPUT_LABELS['back'], 'Emergency Stop');
      this.activityLog?.addSystemEntry('Emergency Stop', 'All cameras stopped, PTZ halted');
      emergencyStopAll(this.state, this.config, this.atem, this.viscaClients).catch(err => {
        logger.error({ err }, 'emergency stop error');
      });
    }
  }
```

Note: `stopPTZ` from ptzActions already calls `stopPanTilt` + `stopZoom` which each call `sendPayload` — those calls will pick up the context set just before. `zoom(currentClient, 0)` sends a stop zoom payload the same way.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/model/controlStateMachine.ts
git commit -m "feat: instrument CSM with activityLog context, movement start/stop tracking"
```

---

## Task 5: Wire ActivityLog through index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Construct ActivityLog and pass to all consumers**

Add the import at the top with the other imports:

```typescript
import { ActivityLog } from './app/activityLog';
```

After `const state: AppState = { ...defaultState };`, add:

```typescript
  const activityLog = new ActivityLog();
```

After constructing `atem`, call:

```typescript
  atem.setActivityLog(activityLog);
```

In the camera construction loop, after `new ViscaClient(...)`, add:

```typescript
    client.setActivityLog(activityLog, cam.label);
```

So the loop becomes:

```typescript
  for (const cam of config.cameras) {
    const client = new ViscaClient(cam.id, cam.viscaIp, cam.viscaPort, cam.cameraType);
    client.setActivityLog(activityLog, cam.label);
    client.on('connected', () => { state.cameraConnected[cam.id as CameraId] = true; });
    client.on('disconnected', () => { state.cameraConnected[cam.id as CameraId] = false; });
    viscaClients.set(cam.id as CameraId, client);
    client.connect();
  }
```

Update the `ControlStateMachine` construction to pass `activityLog`:

```typescript
  const machine = new ControlStateMachine(state, config, atem, viscaClients, activityLog);
```

Update `createStatusServer` call to pass `activityLog`:

```typescript
  const app = createStatusServer(state, config, presetManager, activityLog);
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```
Expected: one error about `createStatusServer` signature not yet accepting `activityLog` — that's fine, it gets fixed in Task 6.

- [ ] **Step 3: Commit (after Task 6 compiles clean)**

Hold this commit until Task 6 is done.

---

## Task 6: Add API endpoints and WebSocket in statusServer

**Files:**
- Modify: `src/ui/statusServer.ts`

- [ ] **Step 1: Update `createStatusServer` signature**

Change the function signature to accept `activityLog`:

```typescript
import { ActivityLog } from '../app/activityLog';

export function createStatusServer(
  state: AppState,
  config: AppConfig,
  presetManager: PresetManager,
  activityLog: ActivityLog
): express.Express {
```

- [ ] **Step 2: Add REST endpoints for activity log**

Inside `createStatusServer`, after the existing `app.get('/api/presets', ...)` block, add:

```typescript
  app.get('/api/activity', (_req, res) => {
    res.json({ entries: activityLog.getAll() });
  });

  app.delete('/api/activity', (_req, res) => {
    activityLog.clear();
    res.json({ ok: true });
  });
```

- [ ] **Step 3: Add `/ws/activity` WebSocket in `startStatusServer`**

Update `startStatusServer` to accept `activityLog`:

```typescript
export function startStatusServer(
  app: express.Express,
  activityLog: ActivityLog,
  port = 8080
): http.Server {
```

Inside `startStatusServer`, after the existing `wss` setup, add:

```typescript
  const activityClients = new Set<WebSocket>();
  const wssActivity = new WebSocketServer({ server, path: '/ws/activity' });

  wssActivity.on('connection', (ws) => {
    activityClients.add(ws);
    ws.on('close', () => activityClients.delete(ws));
    ws.on('error', () => activityClients.delete(ws));
    // Send current buffer on connect
    const current = activityLog.getAll();
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'snapshot', entries: current }));
  });

  activityLog.on('entry', (entry) => {
    const payload = JSON.stringify({ type: 'entry', entry });
    for (const ws of activityClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  });
```

- [ ] **Step 4: Update `startStatusServer` call in index.ts**

In `src/index.ts`, update the call to match the new signature:

```typescript
  startStatusServer(app, activityLog, port);
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 6: Commit Tasks 5 and 6 together**

```bash
git add src/index.ts src/ui/statusServer.ts
git commit -m "feat: wire ActivityLog through index and statusServer, add /api/activity + /ws/activity"
```

---

## Task 7: Add Activity Log UI panel

**Files:**
- Modify: `src/ui/statusServer.ts` (the `statusHtml()` template literal)

- [ ] **Step 1: Add CSS for the Activity Log panel**

Inside the `<style>` block in `statusHtml()`, before the closing `</style>`, add:

```css
  .activity-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
  .activity-table th { text-align: left; color: #666; padding: 4px 8px; border-bottom: 1px solid #333; font-size: 0.72rem; text-transform: uppercase; }
  .activity-table td { padding: 3px 8px; border-bottom: 1px solid #1f1f1f; vertical-align: top; }
  .activity-table td.msg { font-family: monospace; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-visca { background: #0a1828; }
  .row-atem  { background: #1e1206; }
  .row-sys   { background: #111; color: #888; }
  .log-wrap  { height: 320px; overflow-y: auto; }
  .log-meta  { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .btn-sm    { padding: 2px 10px; font-size: 0.78rem; background: #222; border: 1px solid #444; color: #ccc; cursor: pointer; border-radius: 3px; }
  .btn-sm:hover { background: #333; }
```

- [ ] **Step 2: Add the Activity Log panel HTML**

Inside the `<body>` section of `statusHtml()`, after the `controllers-panel` div and before the closing `</body>`, add:

```html
<div class="panel">
  <div class="log-meta">
    <h2 style="margin:0">Activity Log</h2>
    <button class="btn-sm" onclick="clearActivityLog()">Clear</button>
  </div>
  <div class="log-wrap" id="activity-log-wrap">
    <table class="activity-table">
      <thead><tr>
        <th>Time</th><th>Device</th><th>Input</th><th>Command</th>
        <th>Proto</th><th>Message</th><th>Target</th><th>IP</th>
      </tr></thead>
      <tbody id="activity-log-body"></tbody>
    </table>
  </div>
</div>
```

- [ ] **Step 3: Add Activity Log JavaScript**

Inside the `<script>` block in `statusHtml()`, add the following functions (append after the existing `refreshControllers` code):

```javascript
// ---- Activity Log ----
var activityWs = null;
var activityAutoScroll = true;

function fmtTime(ts) {
  var d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function activityRowClass(proto) {
  if (proto === 'VISCA') return 'row-visca';
  if (proto === 'ATEM') return 'row-atem';
  return 'row-sys';
}

function appendActivityEntry(entry) {
  var tbody = document.getElementById('activity-log-body');
  if (!tbody) return;
  var tr = document.createElement('tr');
  tr.className = activityRowClass(entry.protocol);
  var msg = entry.message || '—';
  tr.innerHTML =
    '<td>' + fmtTime(entry.ts) + '</td>' +
    '<td>' + esc(entry.device) + '</td>' +
    '<td>' + esc(entry.input) + '</td>' +
    '<td>' + esc(entry.command) + '</td>' +
    '<td>' + esc(entry.protocol) + '</td>' +
    '<td class="msg" title="' + esc(msg) + '">' + esc(msg) + '</td>' +
    '<td>' + esc(entry.targetName) + '</td>' +
    '<td>' + esc(entry.targetIp) + '</td>';
  tbody.appendChild(tr);
  // Trim to 500 rows in DOM
  while (tbody.rows.length > 500) tbody.deleteRow(0);
  if (activityAutoScroll) {
    var wrap = document.getElementById('activity-log-wrap');
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
  }
}

function initActivityLog() {
  var wrap = document.getElementById('activity-log-wrap');
  if (wrap) {
    wrap.addEventListener('scroll', function() {
      activityAutoScroll = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 10;
    });
  }

  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  activityWs = new WebSocket(proto + '//' + location.host + '/ws/activity');

  activityWs.onmessage = function(evt) {
    var msg = JSON.parse(evt.data);
    if (msg.type === 'snapshot') {
      var tbody = document.getElementById('activity-log-body');
      if (tbody) tbody.innerHTML = '';
      for (var i = 0; i < msg.entries.length; i++) appendActivityEntry(msg.entries[i]);
    } else if (msg.type === 'entry') {
      appendActivityEntry(msg.entry);
    }
  };

  activityWs.onerror = function() {
    // fallback: poll every 2s
    setTimeout(function pollActivity() {
      fetch('/api/activity').then(function(r) { return r.json(); }).then(function(data) {
        var tbody = document.getElementById('activity-log-body');
        if (tbody) tbody.innerHTML = '';
        for (var i = 0; i < data.entries.length; i++) appendActivityEntry(data.entries[i]);
        setTimeout(pollActivity, 2000);
      }).catch(function() { setTimeout(pollActivity, 2000); });
    }, 2000);
  };
}

function clearActivityLog() {
  fetch('/api/activity', { method: 'DELETE' }).then(function() {
    var tbody = document.getElementById('activity-log-body');
    if (tbody) tbody.innerHTML = '';
  });
}

initActivityLog();
```

- [ ] **Step 4: Verify TypeScript compiles and JS syntax is clean**

```bash
npx tsc --noEmit
```

Then check the rendered JS:
```bash
npm run dev &
sleep 5
curl -s http://127.0.0.1:8080/ | python3 -c "
import sys
html = sys.stdin.read()
start = html.index('<script>') + 8
end = html.rindex('</script>')
with open('/tmp/test_script.js', 'w') as f:
    f.write(html[start:end])
print('written')
"
node --check /tmp/test_script.js
kill %1
```
Expected: `written` then no output from `node --check`.

- [ ] **Step 5: Commit**

```bash
git add src/ui/statusServer.ts
git commit -m "feat: add Activity Log panel to web UI with WebSocket real-time updates"
```

---

## Task 8: Smoke test end-to-end

- [ ] **Step 1: Start the app and open the UI**

```bash
npm run dev
```

Open `http://127.0.0.1:8080` in a browser.

- [ ] **Step 2: Verify Activity Log panel renders**

The "Activity Log" panel should be visible at the bottom of the page with column headers: Time | Device | Input | Command | Proto | Message | Target | IP. The table body is empty at startup (no controller inputs yet).

- [ ] **Step 3: Verify REST endpoints**

```bash
curl -s http://127.0.0.1:8080/api/activity | python3 -m json.tool | head -5
```
Expected: `{"entries": []}` or entries if actions have fired.

```bash
curl -s -X DELETE http://127.0.0.1:8080/api/activity
```
Expected: `{"ok": true}`.

- [ ] **Step 4: Verify WebSocket connects**

In browser DevTools → Network → WS tab, confirm `/ws/activity` shows status 101 (Switching Protocols) and a `snapshot` message arrives on connect.

- [ ] **Step 5: Verify controller inputs produce log entries**

Connect a controller. Move the right stick — confirm rows appear with:
- `protocol = VISCA`
- `message = 81 01 06 01 ...` (hex bytes)
- `targetName` = camera label from config
- `targetIp` = camera IP

Release the stick — confirm a Stop entry appears.

Press Right Trigger (cut live) — confirm an ATEM row appears with `message = changePreviewInput(inputId=N, me=0)` followed by `cut(me=0)` (two rows: one for changePreviewInput, one for cut).

- [ ] **Step 6: Final commit if any cleanup needed**

```bash
git add -p
git commit -m "chore: activity log smoke test cleanup"
```
