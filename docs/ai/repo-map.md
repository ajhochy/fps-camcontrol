# Repo Map — fps-camcontrol

## Key directories
```
fps-camcontrol/
├── config/
│   ├── devices.yaml          ← ATEM + camera IPs, cameraType, meIndex, graphics, DJI bridge block
│   ├── mappings.yaml         ← controller button/axis mappings
│   ├── presets.json          ← saved PTZ positions per camera per slot
│   └── speeds.json           ← speed presets (Slow/Normal/Fast multipliers)
├── controller-profiles/      ← generic.yaml, wii-u-pro.yaml, xbox.yaml
├── src/
│   ├── app/                  ← controllerLoop (60Hz tick), eventBus, state, activityLog
│   ├── atem/                 ← atemClient (atem-connection wrapper), switcherActions
│   ├── config/               ← configLoader (YAML + Zod)
│   ├── devices/              ← motionDevice interface, viscaDevice, djiBridgeDevice, deviceFactory
│   ├── input/                ← gamepad (node-hid), normalizers, profileDetector, edgeTriggers, calibrationWizard
│   ├── model/                ← controlStateMachine, cameraSelector, presetManager, speedManager
│   ├── safety/               ← emergencyStop, watchdog (VISCA reconnect + 30s probe)
│   ├── testing/              ← smokeTest, virtualAtem, virtualController, virtualVisca, virtualDjiBridge
│   ├── ui/                   ← statusServer (Express status + config web UI), routes/
│   ├── visca/                ← viscaClient (UDP + VISCA-IP header + inquiry parser), ptzActions, speedCurves
│   └── index.ts              ← startup, wiring, connectivity probe summary
├── pi-bridge/                ← Python WebSocket→CAN bridge for DJI gimbals (runs on a Raspberry Pi)
│   ├── dji_bridge.py         ← async websockets server; 250ms safety watchdog
│   ├── drivers/              ← base.py (GimbalDriver protocol), mock_driver.py, dji_rs_driver.py (stub)
│   └── systemd/              ← dji-bridge.service production unit
├── docs/                     ← dji-gimbal-spec.md, pi-implementation.md, Visca_command_list_new.pdf, ai/
├── AGENTS.md                 ← agent guidance
└── package.json / tsconfig.json / pnpm-workspace.yaml
```

## Entry points
- App: `src/index.ts` (`pnpm start` runs `dist/index.js`; `pnpm dev` runs via ts-node).
- Smoke suite: `src/testing/smokeTest.ts` (`pnpm test:smoke`).
- Pi bridge: `pi-bridge/dji_bridge.py --driver mock --port 7878`.
- Status / config UI: Express on port 8080 (`STATUS_PORT`), bound to `0.0.0.0` for LAN access.

## Dependencies
**Runtime:** `atem-connection`, `node-hid`, `express`, `js-yaml`, `zod`, `pino`, `pino-pretty`, `ws`
**Dev:** `@types/express`, `@types/js-yaml`, `@types/node`, `@types/node-hid`, `@types/ws`, `ts-node`, `typescript`
**Pi bridge:** Python `websockets`, `python-can` (for the real CAN driver)

## Environment variables (from code scan)
- `DEVICES_CONFIG` — path to devices.yaml (default `config/devices.yaml`)
- `LOG_LEVEL` — pino log level
- `PRESETS_FILE` — path to presets.json (default `config/presets.json`)
- `SPEEDS_FILE` — path to speeds.json (default `config/speeds.json`)
- `STATUS_PORT` — Express status UI port (default `8080`)

## Hot files (auto-generated — snapshot)
From the auto-generated repo map (single initial commit — all files at 1 change). Most likely to be touched in future work:
- `src/visca/viscaClient.ts` — core VISCA-IP protocol, header, inquiry parsing
- `src/visca/ptzActions.ts` — all PTZ command functions
- `src/model/controlStateMachine.ts` — camera selection, speed, preset, cut logic
- `src/index.ts` — app entry, wiring, startup probe
- `src/ui/statusServer.ts` — Express status + config web UI
- `src/config/configLoader.ts` — YAML + Zod schema
- `src/model/presetManager.ts` — preset save/recall with VISCA inquiry

Largest source files: `src/testing/smokeTest.ts` (~8.6 KB), `src/model/controlStateMachine.ts` (~5.2 KB), `src/ui/statusServer.ts` (~5.1 KB), `src/index.ts` (~4.6 KB), `src/atem/atemClient.ts` (~3.1 KB).
