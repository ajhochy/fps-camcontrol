# T1 — Tracking config block + device-key resolution

**Labels:** `feature`, `tracking`, `config` · **Size:** S · **Depends on:** none · **Plan:** `docs/ai/current-plan.md`

## Goal
Add an optional, disabled-by-default `tracking:` block to `config/devices.yaml`, validated like the `sony:` block, and make a configured tracking source resolvable to the **currently active camera slot** for its gimbal.

## Context
- `resolveProfile()` in `src/config/configLoader.ts` turns profile slots into `config.cameras` and **drops the inventory device key** (`rs3`, `rs3pro-a`, …). A tracking source is tied to physical hardware (a Sony camera mounted on a specific gimbal), so it must reference the inventory key and be mapped to whichever slot uses that device in the active profile.
- `resolveSonyConfig()` (zod schema + env overrides) is the template to copy.

## Likely files
- `src/config/configLoader.ts` (schema, `resolveTrackingConfig`, `CameraConfig.deviceKey`, `AppConfig.tracking`)
- `config/devices.yaml` — **comment block only**; the file has unrelated uncommitted local edits, do not include them in this change
- `docs/ai/decisions/2026-09-30-auto-tracking-architecture.md` (link only if wording needs to change)

## Acceptance criteria
1. Absent `tracking` block ⇒ `config.tracking` is `{ enabled: false, … defaults }` and nothing else changes.
2. Schema fields: `enabled`, `sidecarUrl` (ws/wss URL, default `ws://127.0.0.1:7900`), `maxSpeed` (0.05–1, default 0.35), `deadzone` (0–0.3, default 0.04), `lostHoldMs` (default 3000), `sources[]` = `{ sonyCameraId, device, invertPan=false, invertTilt=false }`.
3. Env overrides `TRACKING_ENABLED` (true/false/1/0, else throws like `SONY_ENABLED`) and `TRACKING_SIDECAR_URL` take precedence over YAML.
4. `sources[].device` must exist in `devices:` inventory and be a `dji-bridge` device (v1); otherwise config load fails with a message naming the source.
5. `CameraConfig` gains `deviceKey` (set by `resolveProfile`; unset for the legacy `cameras:` form). Existing config behavior, saved YAML, and the UI config editor are unaffected.
6. A pure helper `resolveTrackingSources(config)` returns, per source, the active `cameraId` or `null` when the device is not in the active profile. A source whose device is absent is **not an error**.
7. Comments in `devices.yaml` document the block and stay intact across a UI save (see `writeDevicesYaml`).

## Tests / evaluation
- Smoke assertions: default when absent; valid block; each invalid field; env precedence and bad env value; unknown device; non-DJI device; profile switch flips resolver between `cam4` and `null`.
- `pnpm build`; `STATUS_PORT=<free> pnpm test:smoke`; `git diff --check`.

## Out of scope / data safety
No runtime tracking code. No UI editor. Do not commit local changes to `config/devices.yaml`, `config/presets.json`, or `config/sony-cameras.json`. Do not put real Sony camera IDs in committed examples.
