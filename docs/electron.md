# Existing-app Electron manual package

The final manual app from foundation commit `133ae8d` is signed, Apple Accepted,
stapled and Gatekeeper-assessed. Its exact final DMG passed mounted automation on
the developer Mac. A genuinely clean macOS/TCC/physical-hardware test remains
pending. Historical failed candidates and screenshots remain preserved.

## Commands

These manual-only build commands apply to `feat/electron-foundation`. The stacked
`codex/electron-tracking` branch uses `pnpm electron:package:tracking` and the
tracking-specific checks in [tracking.md](tracking.md). Do not build a manual-only
artifact from tracking sources; use the frozen foundation commit/branch.

```sh
pnpm electron:package                    # isolated native rebuild, full app, Developer ID sign-only and DMG
pnpm test:electron:manual                # actual identity, minOS, privacy metadata, resources and exclusions
pnpm test:electron:runtime               # actual mounted default DMG with fresh HOME/minimal PATH
node scripts/test-electron-manual-runtime.cjs --dmg /absolute/final.dmg
ai-workflow checks --level pr            # serial repository checks; see docs/ai/testing-guide.md
```

The identity is `com.ajhochhalter.fpscamcontrol`, minimum macOS is 13.0, and Electron is pinned in package.json. Native dependencies are rebuilt only inside an isolated temporary staging project. The installer includes the existing backend/dashboard, native HID module, controller definitions, docs and legal notices. It excludes Python, tracking/models, Sony SDK and CameraWebApp. No installed Node, Python, pnpm, Homebrew or compiler is needed to launch it. The Sony service remains optional and user-supplied; this does not implement issue45's native locator.

## Configuration and security

Manual app data lives in `~/Library/Application Support/FPS CamControl/`; logs and mutable devices/mappings/presets/Sony approvals stay under that app home. The tracking variant must supply a distinct app identity and data-directory name. Shipped controller definitions and docs are read-only resources. First launch exclusively seeds generic empty-camera defaults; subsequent launches preserve user edits. No production IP, camera ID or approval is seeded.

Setup / Import is available from the app menu. Import validates the complete devices YAML before any change, asks explicit replacement consent, backs up existing devices and working configuration, and writes atomically. Imported executable and Sony approval paths are discarded and Sony is disabled until explicitly configured. Existing UI/controller mappings and deadman behavior are retained; an empty configuration is shown as Not configured.

The backend binds only an ephemeral `127.0.0.1` port, reports actual readiness, and uses a per-launch HttpOnly session cookie. HTTP and WebSocket boundaries reject missing sessions and untrusted origins. The renderer is sandboxed and context-isolated, with Node disabled; validated preload calls are restricted to the expected local setup/status pages. External navigation, popups and permission requests are denied. Children receive an allowlisted environment, not arbitrary shell credentials or Node options.

## Lifecycle and ownership

Shell and backend hold separate kernel-managed shared leases across manual/tracking identities. A second owner fails closed; no PID files, process-name scans or arbitrary process kills are used. Quit sends stop before closing services and waits for the owned utility's exit, escalating a hung utility only by its captured live ownership handle/PID. Backend cleanup covers HTTP, WebSockets, timers, controller and device connections.

One bounded crash recovery loads a paused status page and starts no controller, ATEM, camera or Sony helper. Resume requires explicit Restart controls. A sleep event stops the backend; wake does not restart it automatically. Parent loss is detected by a heartbeat deadline. This is not proof that real hardware stops after an uncatchable crash: device watchdog/physical motion acceptance remains a human gate.

For a configured managed Sony executable, a small guardian runs using bundled Electron Node, owns the native child and drains private output. Parent pipe EOF or heartbeat loss triggers TERM, then KILL if needed, and cleanup waits for actual exit. A third lease stays with the guardian through native shutdown and is held across a replacement manager's health probe, preventing adoption of a dying managed child. Services already running outside the app are adopted without ownership and are never killed on quit. Force-killing the guardian itself cannot provide cleanup guarantees.

## Verification and release boundary

The runtime harness mounts the actual DMG read-only with a fresh temporary HOME, minimal PATH and unrelated working directory with spaces. It tests dashboard/assets/API, real Electron HID module loading without opening a device, persisted edits/relaunch, import rejection/cancel/consent/backup, sandbox/auth/navigation, single instance, hung utility escalation, real child/main crashes, and simulated power events. Sony lifecycle checks use disposable loopback fixtures executed by bundled Node, not a real Sony service. Screenshots, timings and normal versus fault-injection browser errors are recorded separately.

See [releasing.md](releasing.md) for inside-out signing, safe Apple credentials, app and final-DMG Accepted results, staples, final archives and exact hash-bound evidence. Packaging does not publish a release. Developer-host automation is not a genuine clean macOS/TCC test, physical controller/camera/ATEM test, real sleep test or substitute for human hardware safety validation.

Evidence: `docs/ai/runs/2026-10-01-electron-manual-integration.md`, `docs/ai/contracts/electron-manual-package-v1.json`, and timestamped files under `docs/ai/runs/electron-manual-evidence/`. `latest-runtime.json` identifies the latest run; never infer current status from the preserved original `runtime.json`.
