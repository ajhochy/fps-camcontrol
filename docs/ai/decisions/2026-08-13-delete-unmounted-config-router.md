# 2026-08-13 — Delete the unmounted `src/ui/routes/config.ts` router

**Decision:** Removed `src/ui/routes/config.ts` outright rather than repairing its write path.

**Context:** The file exported `createConfigRouter()`, which was never mounted anywhere (only self-reference in the tree). Its private `persistDevices()` helper did a wholesale `fs.writeFileSync(devicesPath, yaml.dump({atem, cameras, graphics}))` on every `POST /cameras` and `POST /atem`. `config/devices.yaml` carries a commented-out DJI RS4 Pro camera block (lines 31–40) that documents the bridge config shape; any wholesale `yaml.dump` write erases it. The legacy `lowerThirds` key that `DevicesSchema` still accepts would also be dropped. `src/ui/statusServer.ts` already owns `/api/config` (GET at :32, POST at :129) with Zod validation via `validateDevicesConfig()` plus ATEM-reconnect handling, so the router was pure duplication.

**Alternatives considered:** Route the router's writes through `saveDevicesConfig()` from `src/config/configLoader.ts`. Rejected — `saveDevicesConfig()` (configLoader.ts:128) is itself a wholesale `yaml.dump` write with no merge and no comment preservation, so it would not have fixed the data loss, only relocated it.

**Consequences:** One landmine removed. `src/ui/routes/` still holds `presets.ts` and `status.ts`, both also unmounted but read-only/harmless. The underlying comment-destroying write in `saveDevicesConfig()` remains on the *mounted* `POST /api/config` path and is unresolved — tracked as follow-up work.

**Verification:** `npx tsc --noEmit` → 0; `npm run build` → 0; `STATUS_PORT=8093 npm run test:smoke` → 36/36 passed, 0 failed.

**Update (2026-09-30):** the unresolved risk noted above — `saveDevicesConfig()` doing a comment-destroying wholesale write on the mounted `POST /api/config` path — was fixed by issue #18 (`7e62203`): saves now merge into the existing YAML and preserve comments and gimbals.
