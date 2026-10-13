# Actual existing-app Electron manual package — 2026-10-01

## Assignment and preserved baseline

- Root: `/Users/ajhochhalter/.local/share/opencode/worktree/ec2e0fe3fdd54c2e9ab53bfa4cc75c91e40568ed/fps-electron-two-pr-plan`
- Branch: `feat/electron-foundation`; HEAD: `763122d5ef27097661773ccc16d4f704f950ea81`.
- Manager entry: `2026-10-01-packaging-first-scope.md`; existing backend/UI, not controller customization, probe, or tracking.
- Default configured model; no override, peer dispatch, commits, remote/branch mutation, live hardware, keychain changes or host-owned tracker calls.
- Prior modifications: README, current-plan, decisions, package.json, pnpm-lock.yaml, pnpm-workspace.yaml. Prior untracked files: .npmrc, LICENSE, controller/foundation/probe contracts and runs, manager approval, packaging-first scope, foundation decisions/plans, electron/probe, probe builder/scripts, controllerCustomizationTest.ts. All preserved; package script additions must be distinguished from prior dependency changes.

## Phase 0 — executed before implementation

- Skill: acceptance-contract invoked first.
- Own contract: `docs/ai/contracts/electron-manual-package-v1.json`.
- Command: `node scripts/test-electron-manual-package.cjs`.
- Result: **FAIL**, exit 1, `AssertionError: c1: actual full manual ARM64 .app must exist; probe is not a deliverable` (Node 22.23.0).
- 13 criterion IDs; artifact check runnable, full runtime/UI/lifecycle/signing checks explicitly UNVERIFIED until actual evidence. No mock of the app.

## Phase 1 — source and impact review

Read AGENTS, project-state, current-plan, repo-map, architecture, testing-guide, decisions, packaging scope and manager approval. Indexed repo `fps-camcontrol` refers to original checkout at stale d3cb437; assigned worktree source takes precedence.

- `main`, `src/index.ts`: upstream **LOW**, direct file caller index.ts, 25 total impacted nodes (depth 1/17/7), no indexed process aggregation. Scope: additive packaged readiness/shutdown/resources hooks only, legacy CLI behavior preserved.
- `startStatusServer`, `src/ui/statusServer.ts`: upstream **LOW**, direct main, 19 nodes (depth 1/1/17), 11 main process hits (Sony/ATEM/controller flows). Scope: authenticated embedded listener/readiness only.
- `createStatusServer`, same file: upstream **LOW**, same direct main/19 nodes/11 main flow hits. Scope: embedded-only loopback authentication middleware; existing route bodies/shapes unchanged.
- `api_impact(file=src/ui/statusServer.ts)`: 24 stale indexed routes, each LOW, no indexed consumers; actual UI references existing same-origin API. No HIGH/CRITICAL result received for these symbols. Existing applyCurve/CameraSelector HIGH approvals are unrelated and unused.

## Serial baseline checks — before shipping edits

Command: `pnpm build && CAMCONTROL_NO_CONTROLLER=1 pnpm test:smoke:isolated && CAMCONTROL_NO_CONTROLLER=1 pnpm sandbox:check && node scripts/check-page-js.cjs`.

Result: TypeScript PASS; isolated smoke **268/268**; FPS sandbox **104/104**; 2 emitted page blocks/2 standalone UI JS files parse. Isolated virtual hardware only, no live config/HID. Probe timing remains RED and unchanged, no third soak.

## Execution / final handoff

**BLOCKED — concurrent shared-path lifecycle changes and missing notary credentials.** Actual manual candidate app/DMG was built and locally signed; dashboard/runtime acceptance failed. It is not shipping ready and must not be distributed.

Manual targets c2,c4–c13: no-tools native runtime/workers; production instance/HID; ready/offline/error; renderer/IPC/navigation security; fresh-userData persistence; setup/import/absent optional services; owned lifecycle/no replay; mounted DMG/dashboard/keyboard/console/network; serial regressions; actual Apple notary/staple; independent artifact review. Genuine clean OS/TCC/hardware/Gatekeeper remain human gates.

## Implementation / command chronology

1. Added shipping `electron/manual/` main/preload/utility bootstrap/minimal setup, generic resources/defaults, `electron-builder.manual.cjs`, isolated package/sign scripts, actual artifact and Electron/Playwright runtime checks. Added only the manual package/artifact scripts and Playwright 1.58.2 to the already-dirty package/lock. No probe scripts or controller source edits.
2. Bounded own index hooks: packaged nonblocking ATEM, PROFILES_DIR, real ready port, parent shutdown, stop loop/watchdog and enqueue stops before closing. Own statusServer hooks: embedded-only Host/Origin/session middleware and WS protection, read-only docs resource root, log actual port. No existing route body/response redesign. Package.json GitNexus upstream LOW, zero dependents.
3. `node scripts/package-electron-manual.cjs`, first run: frozen owned production install/rebuild succeeded, then FAIL copying dist into a stage within dist. One repair: copy explicit backend output directories instead of recursively copying dist into itself; exclude build-time Python/node_gyp_bins, test/example/prebuild/obj dirs from staged runtime. Failed stage preserved.
4. Second package run: frozen install of 157 runtime packages, separate Electron rebuild for node-hid and @julusian/freetype2, Electron44.5.1 ARM64 app built, 29 nested Mach-O/bundle targets signed using existing Developer ID and timestamp, strict verify PASS; actual manual DMG built. Tool command hit 120s timeout after DMG/blockmap build started; no third package build attempted. Artifact subsequently exists and passed the contract. Tool timeout is recorded, not represented as a fully successful package command exit.
5. `pnpm add --save-dev --save-exact playwright@1.58.2 --ignore-scripts`: owned test dependency installed; no browsers/system tools installed and no Node-native rebuild performed. Root lock preserves prior probe dependencies plus this new test dependency.
6. `node scripts/test-electron-manual-package.cjs`: PASS actual bundle identity/minOS, ARM64 executable, DMG existence, backend/UI/docs/controller/notices, forbidden resource and ASAR payload names. These are artifact-layout checks, not a runtime pass.
7. `node scripts/test-electron-manual-runtime.cjs`: actual DMG mounted read-only; actual Electron executable launched from mounted volume under random cwd with spaces, fresh temporary HOME, `/usr/bin:/bin` PATH and `CAMCONTROL_NO_CONTROLLER=1`. **FAIL** after 20s: backend exited; real window showed `Backend stopped unexpectedly. Motion is not replayed. Quit and restart to reconnect.` The dashboard did not appear. Harness closed its app and detached its own volume.
8. Shared-path conflict discovered while diagnosing failure; stopped all further product/shared-file edits. Final combined contract re-run remains **FAIL**, same actual failure, with durable error-window screenshot. This second runtime check is evidence capture, not a second implementation repair or a soak.
9. `node scripts/electron-manual-artifact-evidence.cjs`: strict codesign verify PASS, actual hash/bytes/versions recorded. `node scripts/sign-electron-manual.cjs`: exit 1, `BLOCKED: missing credentials: APPLE_SIGNING_IDENTITY, APPLE_TEAM_ID, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD`. Presence-only check showed false for each; existing Developer ID identity available for local sign-only. No credential values or credential-bearing errors printed. No Apple upload performed.
10. `git diff --check`: PASS. Final build/smoke/sandbox re-run deferred because another owner changed shared lifecycle paths during this run; initial 268/104 baseline is not claimed as final integrated regression evidence.

## Exact serial-ownership blocker

At entry, src/index.ts was unmodified and unconditionally invoked main; src/embed.ts, src/config/paths.ts and issue-40/41 contracts/tests/run notes did not exist. During this run a different owner added them, changed src/config/configLoader.ts and src/model/presetManager.ts, rewrote src/index.ts to exported `startApplication` with inert imports and guarded CLI `main`, changed src/ui/statusServer.ts readiness, and changed project-state/current-plan. These changes are not mine and were not reverted.

Current wrapper `electron/manual/backend.cjs` requires backend/dist/index.js relying on the originally observed autostart. Current shared source makes that import inert and introduces `src/embed.ts` as the embedded entrypoint. This source mismatch is consistent with the observed utility exit/no ready. A source ownership handoff/integration is required before changing the wrapper/lifecycle together or rebuilding; do not overwrite the new issue-40/41 work. No HIGH/CRITICAL warning was bypassed; this blocker is the actual concurrent write/entrypoint mismatch, not controller approval or the probe's timing result.

## Actual candidate artifacts (not verified shipping output)

- App absolute path: `/Users/ajhochhalter/.local/share/opencode/worktree/ec2e0fe3fdd54c2e9ab53bfa4cc75c91e40568ed/fps-electron-two-pr-plan/release/manual/mac-arm64/FPS CamControl.app`.
- App regular-file logical bytes: **337137389**, 1038 files; app.asar SHA256 `0c8da6518a8355908507ee5ff06dabf2327fca91923e2f03ccc72892823737e1` (directory has no single file hash).
- DMG absolute path: `/Users/ajhochhalter/.local/share/opencode/worktree/ec2e0fe3fdd54c2e9ab53bfa4cc75c91e40568ed/fps-electron-two-pr-plan/release/manual/FPS CamControl-manual-0.1.0-arm64.dmg`.
- DMG bytes: **137706616**; SHA256 `88a824c42f0bc1e33e9f418d04a61205da640e89ed90379e870a70686e78a3a6`.
- Bundle ID `com.ajhochhalter.fpscamcontrol`; version0.1.0; minOS13.0; arm64. Build Node22.23.0, Electron44.5.1, electron-builder26.15.3, rebuild4.2.0, Playwright1.58.2. Candidate built from dirty mixed source, not an immutable commit.
- Durable metadata: `docs/ai/runs/electron-manual-evidence/artifact.json`.
- Actual runtime FAIL: `docs/ai/runs/electron-manual-evidence/runtime.json`.
- Actual error screenshot: `docs/ai/runs/electron-manual-evidence/mounted-dmg-startup-failure.png`; **not dashboard evidence**. No dashboard screenshot, persisted restart, keyboard/UI/API/native utility success is claimed.
- Apple final Accepted: absent; stapled app/DMG: absent; Gatekeeper: UNVERIFIED. Final-DMG notary/staple pipeline still incomplete even if app credentials become available. Independent actual-app verification has not passed.

## Change flags and owned vs prior/concurrent diff

Product changes YES; dependency changes YES (own Playwright only beyond prior probe deps); packaging/signing YES; API response-shape changes NO; controller/mapping/curve/state-machine logic changes NO; probe/timing data changes NO; live hardware/config NO; original checkout/PR36 NO; peers/commits/push/GitHub/branch mutation/merge/deploy/release publication/keychain mutation/global kills NO. Only owned staging temporaries were unlinked during exclusive seed promotion; no user settings/probe/raw evidence/worktree/branch was deleted. Runtime test app/DMG cleanup is owned and bounded.

Tracked mixed diff against HEAD (`git diff --numstat`):

| File | + / − | Ownership |
|---|---:|---|
| README.md |19/0|prior, untouched|
| docs/ai/current-plan.md |253/243|prior + concurrent, untouched by this owner|
| docs/ai/decisions.md |1/0|prior, untouched|
| docs/ai/project-state.md |12/140|concurrent, untouched|
| package.json |17/1|prior probe metadata/deps + own two manual scripts and Playwright|
| pnpm-lock.yaml |1921/1|prior probe lock + own Playwright install; no baseline snapshot exists to attribute exact hunks independently|
| pnpm-workspace.yaml |3/0|prior, untouched|
| src/config/configLoader.ts |7/6|concurrent, untouched|
| src/index.ts |65/28|own bounded startup/stop hooks + concurrent issue41 rewrite; mixed ownership, do not stage as solely owned|
| src/model/presetManager.ts |2/1|concurrent, untouched|
| src/ui/statusServer.ts |37/3|own embedded auth/resource/actual-port hooks + concurrent issue40/41 paths/readiness|

New exclusively owned production/test/docs files (`git diff --no-index --numstat /dev/null <file>`), all deletions0:

| File | additions |
|---|---:|
| electron/manual/main.cjs |134|
| electron/manual/backend.cjs |12|
| electron/manual/preload.cjs |6|
| electron/manual/setup.html |7|
| electron/manual/setup.js |6|
| electron/manual/entitlements.plist |3|
| electron-builder.manual.cjs |14|
| resources/defaults/devices.yaml |8|
| resources/defaults/speeds.json |1|
| resources/defaults/mappings.yaml |15|
| resources/defaults/presets.json |1|
| scripts/package-electron-manual.cjs |49|
| scripts/sign-electron-manual.cjs |54|
| scripts/test-electron-manual-package.cjs |32|
| scripts/test-electron-manual-runtime.cjs |105|
| scripts/electron-manual-artifact-evidence.cjs |34|
| docs/electron.md |32|
| docs/ai/contracts/electron-manual-package-v1.json |22|

This run note and evidence JSON/PNG are additionally owned. Release/manual and UUID-named dist/electron-manual stages are generated owned output, not source to commit. Other new paths (src/embed, config/paths, tests, issue40/41 docs/contracts) belong to the concurrent owner. Existing electron/probe and probe builder/scripts are preserved, not shipping-owned additions.

## Phase disposition / manager handoff

- Phase0 COMPLETE: own contract/test created before logic and actual failing assertion recorded.
- Phase1 COMPLETE for originally analyzed bounded symbols: LOW, source traced; no HIGH edits. Reanalysis/integration is required for the newly changed lifecycle ownership before continuing.
- Phase2 INCOMPLETE/BLOCKED: actual full app/DMG built, but runtime contract RED. One packaging staging repair; no broad refactor or third soak. Product edits frozen after conflict discovery.
- Final status **BLOCKED**, not READY_FOR_VERIFICATION. Resume requires serial source ownership reconciliation of the existing startup/embedded API and wrapper, then successful actual mounted-DMG dashboard/lifecycle/persistence/security checks and final regressions. Notary credentials/final app+DMG Accepted/staple and independent gate remain separately required. Human clean OS/TCC/hardware/Gatekeeper are still pending and cannot be inferred from a fresh HOME test.
