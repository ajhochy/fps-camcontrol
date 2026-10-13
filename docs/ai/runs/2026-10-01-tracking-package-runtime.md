---
status: unverified
---

# Tracking package/runtime — 2026-10-01

## Scope and provenance

Worktree: assigned `fps-electron-two-pr-plan`, branch `codex/electron-tracking`
stacked from foundation `133ae8d9620665b1e87b799a765a619ccae06ebc`.
Only new tracking packaging/runtime files and this run/issue50 contract are owned
here; root owns shared shell/config/integration/package metadata. No publication,
host Python installation, hardware or Sony redistributable payload.

## Changes

- `scripts/tracking-runtime-manifest.json`: exact Python, 11 wheels and YOLOX-s
  model plus six checksum-pinned full license/notice sources. NumPy14 selects
  system Accelerate without bundled GCC/Fortran/quadmath runtime libraries.
- `scripts/stage-tracking-runtime.cjs`: offline by default, explicit build-only
  resumable downloads, every asset verified before extraction, fresh target only,
  traversal checks, full Python/component and missing wheel/model notices,
  ARM64/minOS/link-graph inventory. Never calls pip or a host Python.
- `src/tracking/sidecarProcess.ts`: explicit enabled/nonpaused start, private
  per-launch token, verified model before spawn, isolated Python environment,
  exact ready port/PID, heartbeat pipe, no automatic restart, bounded awaited
  EOF/TERM/KILL stop. Raw helper stderr is bounded and never forwarded.
- New tracking builder/entry/package script: distinct identity/userData,
  macOS14 minimum, runtime/model outside ASAR, isolated Electron native rebuild,
  complete notices, truthful source/hash receipt. Existing manual output is not
  reused or overwritten.
- New staging/supervisor/package/runtime tests and `issue-50.json` contract.

## Checks performed

- Staging regressions: 3/3 PASS (pins/notices, corrupt/symlink/offline cache,
  archive traversal and exact audited SymPy `.data` manpage).
- Supervisor regressions: 5/5 PASS before root's timing-config extensions (disabled/paused inert; actual ready/PID and
  one-child concurrent start; heartbeat/EOF cleanup/new-token explicit restart;
  bad readiness/timeout; remote origin/corrupt model refusal; UTF-8 byte bound and
  spawn failure). Startup timeout uses the same settled cleanup path as readiness.
- Mounted-harness fixture regressions: 2/2 PASS. Real config schema resolves the
  disposable rig/source mapping; real SonyManager discovers, explicitly approves,
  persists approval and consumes exact binary frame bytes from the owned fixture.
  Syntax checks PASS. The final mounted tracking test itself remains UNVERIFIED
  until the frozen installer exists; it never silently skips a missing DMG.
- Actual fresh staging at `dist/tracking-runtime-packaging-v2`: 59 Mach-O files,
  all include arm64, highest actual minimum14.0, no non-system absolute library
  imports, retained original notices. Temporary prerequisite runtime imports all
  11 exact wheel dependencies successfully.
- Actual `test-tracking-sidecar-runtime.cjs --resources ... --sidecar-dir ...`:
  PASS. Evidence: `dist/tracking-runtime-evidence-8d8245e3-fb8a-46c9-a7bf-03f6687b052a.json`.
  Bundled3.12.14 interpreter, empty HOME/minimal PATH/random cwd, OS sandbox denies
  all network access during actual model inference. Two generated RGB images,
  `[1,8400,85]` finite input-dependent output, CoreMLExecutionProvider, model hash
  `c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063`.
  Inference-only p50 21.59ms/p95 22.46ms; zero persons in both images, NOT accuracy
  or camera-exposure/transport latency evidence. Real authenticated mock helper
  hello/select/tracking/cancel/idle/pong and awaited EOF shutdown passed (19ms).
- Extended staged proof PASS:
  `dist/tracking-runtime-evidence-221b7497-e4b6-4a38-a1da-6023b2130b35.json`.
  Same real network-denied model path plus supported mock sine trajectory through
  actual TS control to virtual DJI: nonzero motion, manual override/resume, helper
  kill, awaited zero motion and no replay. `--app` loads those TS control modules
  from the installed Resources/backend, not source. No shipped source alteration
  or production helper-mode override is used.
- JavaScript syntax and diff whitespace: PASS. First parallel full TypeScript
  check saw still-being-created manager and shared mapping integration errors,
  none in this supervisor; later `pnpm exec tsc --noEmit` PASS. Final independent
  integrated gate remains root-owned.

## Diagnosed failures and repairs

- Temporary extractor rejected SymPy's legitimate wheel `.data/data/share/man`
  member. Preserved partial staging; allow only that audited documentation shape,
  with regression refusing arbitrary `.data/scripts` or traversal.
- macOS tar delegates zstd decompression to an external command absent from the
  deliberately restricted build PATH. Use Node's bounded zstd decoder and tar
  stdin for the exact pinned Python license archive; preserves no-Homebrew runtime
  boundary. Failed `dist/tracking-runtime-packaging-v1` remains intact.
- A 200ms normal subprocess fixture launch deadline timed out intermittently on
  this host. Normal fixture startup now has 5s; the intentional silent-helper test
  still exercises a 100ms timeout. Production startup remains bounded at30s.
- First Sony fixture-unit test omitted the required SonyStateStore constructor
  argument, so boot correctly could not discover. Fixed the harness dependency;
  the real manager/fixture roundtrip passes without a product change.

## Mounted runtime coverage prepared

`node scripts/test-electron-tracking-runtime.cjs --dmg /absolute/tracking.dmg`
mounts exactly that installer read-only and creates a fresh HOME and random cwd.
Checks disabled never launches Python; sandboxed renderer; real bundled HID
enumeration; network-denied bundled model and authenticated helper protocol;
configured production-live helper with only a generated geometric JPEG and an
owned loopback virtual gimbal; no-person selection stops without movement;
helper crash does not restart; backend crash recovers paused with no helper;
sleep stops both processes and wake stays inert; parent SIGKILL and normal quit
leave neither backend nor helper. Separately the bundled mock path proves moving
control commands/override/resume/crash stop to virtual hardware. It writes unique
read-only evidence, exact DMG/app.asar hashes and a screenshot, never frames or
credentials. Process discovery reads only PID/PPID/executable, never private argv
or environment. Existing manual mounted tests are retained, not weakened.

The smoke-test-writer final confirmation requirement is pending the frozen app;
fixture/source tests are not a replacement for executing this actual installer.

## Manual foundation notarization completed independently

Preserved directory: `release/manual-delivery-133ae8d/2026-10-01-final/`.
App job `bc481bd1-4a19-4400-a9d1-6c83e0a74d63`; DMG job
`4dc7579f-483f-4d66-a50f-c09345dde698`: both actual Apple Accepted, matching
completed logs with `issues:null`, app+DMG staple/validate, strict codesign and
Gatekeeper PASS. Final rebuilt ZIP140100411B SHA256
`643dbccae26fd8ecabbe8064ed7a4e775c976f87d80195701747210b6c4cb765`.
Final DMG172838600B SHA256
`da02312a0e65e9bfd440090cf6f7cbc0b29764a5f71685182922806855c98f11`.
17 arm64 Mach-O files; advertised and maximum actual minimum macOS13.0.
Exact foundation commit recorded; `sourceDirty:true` honestly preserves three
unshipped unrelated controller drafts, `trackedChanges:[]`. Build receipt and
app.asar digest match. Root owns final exact-DMG runtime and evidence aggregation.

## Remaining gates

Tracking full app not built/notarized yet. Run package/static checks, actual final
mounted-DMG model/helper proof, full app UI/fault/sleep lifecycle and root's
independent baseline/tracking matrix before committing and notarizing tracking.
Source-owned tests/staged runtime are not final app acceptance. Genuine clean OS,
download quarantine/TCC, physical controller/camera/gimbal and real30-minute
idle/active tracking soaks remain human gates unless actually witnessed.
