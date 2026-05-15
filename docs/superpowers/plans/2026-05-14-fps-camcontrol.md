# FPS CamControl Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a game controller into a live production camera control surface (ATEM switcher + VISCA-IP PTZ cameras).

**Architecture:** Node.js/TypeScript app with a 60Hz controller polling loop that maps HID inputs to ATEM switching and VISCA-IP PTZ commands. AppState owns `controlledCamera`; ATEM preview syncs to it on selection change. All hardware clients auto-reconnect with exponential backoff.

**Tech Stack:** Node.js, TypeScript, pnpm, `atem-connection`, `node-hid`, `js-yaml`, `zod`, `pino`, Express

---

## Implemented (2026-05-14)

All tasks below are complete. The build is clean (`tsc` exits 0) and all 17 smoke tests pass (`pnpm test:smoke`).

### Phase 1 — Foundation
- [x] `package.json`, `tsconfig.json`, `.env.example`, `.gitignore`, `README.md`
- [x] `config/devices.yaml`, `config/mappings.yaml`, `config/presets.json`, `config/speeds.json`
- [x] `controller-profiles/xbox.yaml`, `wii-u-pro.yaml`, `generic.yaml`
- [x] `src/config/configLoader.ts` — Zod-validated YAML/JSON loader

### Phase 2 — Hardware Clients
- [x] `src/atem/atemClient.ts` — atem-connection wrapper + exponential backoff reconnect
- [x] `src/atem/switcherActions.ts` — cut/autoTransition helpers
- [x] `src/visca/viscaClient.ts` — UDP VISCA-IP client + reconnect
- [x] `src/visca/ptzActions.ts` — panTilt/zoom/stop/gotoAbsolutePosition
- [x] `src/visca/speedCurves.ts` — curve shaping, deadzone, clamp

### Phase 3 — Input Processing
- [x] `src/input/gamepad.ts` — node-hid lifecycle + reconnect polling
- [x] `src/input/profileDetector.ts` — auto-detect controller by vendorId/productId
- [x] `src/input/normalizers.ts` — raw HID bytes → named axes/buttons/triggers (-1..1 / 0..1)
- [x] `src/input/edgeTriggers.ts` — rising/falling edge detection
- [x] `src/input/calibrationWizard.ts` — wizard for unknown controllers

### Phase 4 — Control Logic
- [x] `src/app/state.ts` — AppState + defaults
- [x] `src/app/eventBus.ts` — typed event bus
- [x] `src/app/controllerLoop.ts` — 60Hz setInterval loop
- [x] `src/model/cameraSelector.ts` — edge-triggered left-stick flick camera selection
- [x] `src/model/controlStateMachine.ts` — full button mapping → action dispatch
- [x] `src/model/presetManager.ts` — save/recall shot zone presets to JSON
- [x] `src/model/speedManager.ts` — D-pad speed preset cycling
- [x] `src/safety/emergencyStop.ts` — stop all PTZ + DSK off
- [x] `src/safety/watchdog.ts` — 1Hz connection state sync

### Phase 5 — App Entry & UI
- [x] `src/index.ts` — full startup sequence (10 steps from spec)
- [x] `src/ui/statusServer.ts` — Express status + config + presets API + HTML live panel

### Phase 6 — Testing
- [x] `src/testing/virtualController.ts` — programmatic controller mock
- [x] `src/testing/virtualAtem.ts` — mock ATEM client with log
- [x] `src/testing/virtualVisca.ts` — mock VISCA client with log
- [x] `src/testing/smokeTest.ts` — 17 assertions covering all critical paths

## Outstanding (requires real hardware)

- Preset save currently writes a `{pan:0, tilt:0, zoom:0}` placeholder — full implementation requires parsing VISCA inquiry responses (UDP + sequence numbers)
- Calibration wizard UI page in statusServer not yet wired (CalibrationWizard class exists; UI endpoint not exposed)
- `pnpm test:smoke` uses npm under the hood because node-hid native build isn't approved in pnpm; run via `npm run test:smoke`
