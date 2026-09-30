---
type: project
---

# Plan — Electron wrapper: one installable, user-friendly CamControl app

Status: **plan only; issues filed (§15); only E13a (LICENSE) is implemented.** Written 2026-09-30; **decisions D1–D6 resolved by AJ the same
day (see §3) and folded in below.** Lives in `docs/ai/plans/` because
`docs/ai/current-plan.md` is the active click-to-track plan and another session is landing the
Device Config "rigs" work (`docs/ai/plans/2026-09-30-device-config-rigs-ui.md`).

## 1. Intent and constraints pass

**Goal (one sentence).** A volunteer can download one signed macOS app, open it, get walked through
setup, and run the whole camera-control stack — the CamControl app, the Sony camera service, and any
other helper services — without a terminal, `pnpm`, Python, or a compiler.

**In scope**
- Electron shell that hosts today's Node app and its web UI, plus process lifecycle, window, tray/menu.
- Bundling/locating the helper services (Sony `CameraWebApp`, the planned `tracker-sidecar`).
- First-run setup wizard, permission guidance, config location + seeding/import, diagnostics export.
- Signed, notarized, auto-updating macOS (Apple Silicon) distribution via public GitHub Releases.
- **Sony support without shipping Sony's SDK**: clear install instructions plus the app finding/validating
  the user's own `CameraWebApp` build.
- **Open-source readiness**: MIT for our code, correct third-party notices for everything we bundle.
- **Remote operation over Tailscale** (opt-in, later milestone): expose the app to the user's tailnet so an
  operator who is out of town can run it. Security hardening comes first; remote *control input* is a
  spike because today's gamepad input is local to the host Mac.

**Out of scope (v1) — file as follow-ups**
- Windows, Linux, Intel Macs (AJ: **Apple Silicon only**; the repo is macOS-only: `node-hid`, Sony build tested on arm64 only).
- Rewriting the UI as native Electron renderer code; the existing web UI stays as it is.
- The **Raspberry Pi bridge** (`pi-bridge/`): it runs *on the Pi* next to the gimbals' Bluetooth radio and
  cannot be bundled. The wrapper only reports its reachability (already in the UI). A "deploy/update
  the Pi bridge" helper is a separate later feature.
- Mac App Store / sandboxing (incompatible with HID + arbitrary LAN + spawned helpers).
- Any change to camera-control behavior.

**Hard constraints**
- **We do not ship Sony's SDK or any binary built from it (AJ, D1).** No `CameraWebApp`, no Sony libraries,
  no SDK ZIP in the installer, the repo, or release assets. The app only *finds and supervises* a copy the
  user built themselves, and the install instructions are first-class product work (E6), not an afterthought.
  (Our own setup script and the status-fix patch may ship: they contain no Sony material — re-confirm the
  patch's upstream `alpha-sdk-api` license is MIT before bundling.)
- **Never expose camera control without authentication.** The status server has no auth today; it is safe
  only because it binds `127.0.0.1`. Any network exposure (Tailscale) requires the auth/host-validation work
  in R1 first.
- **Live-production safety**: quitting, crashing, updating, or sleeping must never leave a camera moving
  or surprise the operator mid-show. All exits send `stop()`; updates never install while on air.
- The smoke suite boots the real app as an import side effect — packaging tests use the sandbox/isolated
  path (`CAMCONTROL_NO_CONTROLLER=1`, `pnpm test:smoke:isolated`), never two live copies on one controller.
- Don't regress the existing `pnpm start` developer flow; the wrapper is additive.
- Data safety: no credentials, Sony pairing material, or camera approvals in logs, diagnostics bundles, or
  release artifacts. `config/sony-cameras.json` stays per-machine.

**Design tensions**
1. *Friendly vs. licensed*: the friendliest Sony story (bundle it) is off the table, so friendliness has to
   come from excellent guidance, prerequisite checks, and automatic discovery of the user's build.
2. *One supervisor vs. two*: Electron main could supervise every process, but `SonyManager` already
   launches, health-checks, restarts and shuts down the Sony sidecar. Two supervisors would fight.
3. *Installer size vs. capability*: a bundled Python + ONNX stack is large; model weights even more.
4. *Stable identity vs. speed*: macOS privacy grants (Input Monitoring for the controller) depend on a
   stable signing identity; ad-hoc builds lose them on every update.

**Cheapest version that proves the idea.** An **unsigned dev DMG** containing Electron + the existing app in a
`utilityProcess`, config in `~/Library/Application Support`, the window showing `http://127.0.0.1:<port>`,
Sony left as "not set up". That answers the two real unknowns — does `node-hid` work packaged, and does the
control loop hold timing in the shell — before any signing/bundling investment.

## 2. Verified repo facts this plan builds on

| Fact | Where |
|---|---|
| App is a single Node process: `main()` wires ATEM, devices, controller, watchdog, status server, Sony manager; SIGINT/SIGTERM run a graceful `shutdown()` (stops supervisor, closes devices, `sonyManager.stop()`) | `src/index.ts` |
| Config/state paths come from `process.cwd()` or env: `DEVICES_CONFIG`, `SPEEDS_FILE`, `MAPPINGS_FILE`, `PRESETS_FILE`, `PROFILES_DIR`; `controller-profiles/` and `docs/sony-sidecar-setup.md` are read relative to cwd | `configLoader.ts:342-344,528,722`, `index.ts:61`, `statusServer.ts:254,508` |
| Sony state file defaults beside `devices.yaml`; `logs/` exists (gitignored) | `configLoader.ts:305`, `.gitignore` |
| Static UI assets served from `__dirname/../../ui` | `statusServer.ts:42` |
| Status server binds **127.0.0.1** and port from `STATUS_PORT` (default 8080) | `statusServer.ts:588`, `index.ts` |
| **Doc drift:** `docs/ai/architecture.md` says the UI is bound `0.0.0.0` for LAN access; code is loopback-only. LAN viewing (phone/tablet) may or may not be wanted — needs a decision | architecture.md vs `statusServer.ts:588` |
| Sony sidecar is already supervised: set `SONY_SERVER_EXECUTABLE` + `SONY_API_URL`; manager spawns `CameraWebApp --port N`, health `GET /api/server/status`, graceful `POST /api/server/shutdown`, bounded restarts; absent sidecar never blocks startup | `src/sony/sonyManager.ts`, `docs/sony-sidecar-setup.md` |
| Sony sidecar is built locally from `crsdk/alpha-sdk-api` + Sony SDK ZIP with a repo patch; tested on macOS arm64, SDK v2.02.00 | `scripts/setup-sony-sidecar.sh`, `scripts/sony-sidecar-status-fix.patch` |
| Controller: `node-hid`; on macOS a denied Input Monitoring permission shows up as "opens but no data" and is already diagnosed in the UI | `src/input/gamepad.ts`, `controllerSupervisor.ts` |
| `CAMCONTROL_NO_CONTROLLER=1` disables HID; a sandbox/isolated smoke mode exists | `src/index.ts`, `package.json` (`sandbox`, `test:smoke:isolated`) |
| Two copies of the app fight over the controller's exclusive HID handle | `docs/ai/project-state.md` |
| Planned: `tracker-sidecar/` (Python, ONNX, loopback WS :7900), issues #29–#31; launch supervision is explicitly a follow-up there | `docs/ai/current-plan.md` (tracking) |
| Pi bridge is Python on a Raspberry Pi (`websockets`, `bleak`); separate deployment | `pi-bridge/`, `docs/pi-implementation.md` |
| Package managers: both `pnpm-lock.yaml` and `package-lock.json` exist; `.npmrc-pnpm`, `pnpm-workspace.yaml` | repo root |
| No Electron/packaging config exists today | `package.json` |

## 3. Decisions (resolved by AJ, 2026-09-30)

| # | Question | Decision | Consequence in this plan |
|---|---|---|---|
| D1 | Ship Sony's `CameraWebApp` + SDK? | **No, cannot ship.** Need clear install instructions and the app must find it. | Sony is a user-supplied module (E6): guided install, prerequisite checks, auto-discovery, file picker, health validation. No Sony material in installer/repo/releases. |
| D2 | Apple Developer ID? | **Yes**; AJ's main agents on his main machine already know the signing/notarization process. | E8 runs on that machine using its existing procedure (discover it; never copy certs/secrets into the repo). No signing identity exists on this dev machine. |
| D3 | LAN / remote access? | **Wanted**: expose the app on AJ's **Tailscale** network so the camera operator can run it when out of town. | New opt-in remote-access milestone (R1–R3). Auth hardening first; remote control input is a spike (see §5b). |
| D4 | Audience? | Internal now; **open source** if it works well. | Open-source readiness work (E13); keep the code generic (no church-specific defaults); docs written for strangers. |
| D5 | Apple Silicon only? | **Yes.** | arm64 builds only; no universal binary. |
| D6 | Release hosting? | **GitHub Releases; repo is public** (verified: `visibility=PUBLIC`, **no LICENSE file yet**). | `electron-updater` from public releases (no token); add MIT `LICENSE` and complete third-party notices (E13). |

Still open (small): **copyright holder name** for the MIT notice (plan uses a placeholder);
whether remote operators must be able to use a gamepad (R3 scope); whether you want the release built by
hand on the main machine or by CI (recommended: hand/script on the main machine, see E8).

## 4. Prior art (swarm summary — Haiku-sourced, unverified; treat as leads)
- **Electron + native modules**: `node-hid` must be rebuilt for Electron's ABI (`@electron/rebuild`); prefer
  `utilityProcess.fork()` over `child_process.fork` for the server; pnpm needs hoisted `node_modules`
  (`node-linker=hoisted`/`shamefully-hoist`) for electron-builder; set `backgroundThrottling: false`; wire
  cleanup to `before-quit`.
- **Signing/permissions**: sign every nested binary and dylib before packaging (one unsigned dylib fails
  notarization); use a stable Developer ID identity so privacy grants survive updates; add
  `NSLocalNetworkUsageDescription` (macOS 15+ otherwise silently denies LAN access); hardened runtime needs
  explicit entitlements for library loading and USB. **Exact entitlements for our Sony helper and HID must be
  verified empirically, not taken from summaries.**
- **Sidecars**: python-build-standalone is preferred over PyInstaller for ML stacks; give helpers their own
  process group and keep a spawn ledger to avoid orphans after crash/force-quit; download model weights on
  first run with resumable downloads; `electron-updater` will not preserve config or restart helpers for you.
- **Not adopting**: the summary's claim that Electron `userData` is "cloud-backed" on macOS — it is
  `~/Library/Application Support`, which is not; models still go under a cache-style path to keep them out of
  backups.

## 5. Architecture

```
CamControl.app
├─ Electron main (electron/main.ts)              window · tray/menu · single-instance · updates
│    ├─ owns: first-run wizard, permissions help, diagnostics, power-save blocker
│    └─ supervises exactly ONE child ──────────────┐
│                                                  ▼
├─ App process (utilityProcess → dist/index.js)  today's Node app, unchanged control logic
│    ├─ status server on 127.0.0.1:<port>  ◀── BrowserWindow loads it
│    ├─ SonyManager ── spawns/supervises ──▶ CameraWebApp  [USER-BUILT, located by the app; never shipped]
│    └─ TrackingManager ─ launches ────────▶ tracker-sidecar (bundled Python) [optional module]
└─ Resources/ (extraResources, asarUnpack)
     defaults/  config templates · controller-profiles/ · docs
     sony-setup/ our setup script + status-fix patch + install guide (no Sony files)
     python/    python-build-standalone + wheels (only when tracking ships)
```
Network beyond the Mac: ATEM, VISCA cameras, and the Pi bridge over the LAN (unchanged). Optional, opt-in:
the UI exposed to the user's Tailscale network (see §5b).

**Key decisions**
1. **Single-level supervision.** Electron main supervises only the app process. The app keeps supervising
   its own helpers (the existing `SonyManager` pattern; the tracking manager follows it). Electron main
   just passes helper executable paths through environment variables (`SONY_SERVER_EXECUTABLE` = the path
   the locator validated, `TRACKER_SIDECAR_CMD` = the bundled Python) — **zero change to the Sony logic**.
2. **`utilityProcess` for the app**, not the main process: a crash in control code can't take down the window,
   and the main process can restart it. `node-hid` is rebuilt against Electron's ABI.
3. **One place decides paths.** New `src/config/paths.ts` returns the app home; `CAMCONTROL_HOME` overrides.
   Packaged: `~/Library/Application Support/CamControl/` (config, presets, Sony approvals, logs); dev:
   unchanged (`process.cwd()`), so `pnpm start` and the smoke suite are untouched.
4. **Seed, never overwrite.** First run copies bundled defaults into the app home only if absent; the UI's
   comment-preserving YAML saves keep working on the seeded file.
5. **Ready/shutdown contract.** The app process picks a free port (or honors `STATUS_PORT`), announces
   `{type:'ready', port}` over the utilityProcess channel, and on `{type:'shutdown'}` runs the existing
   graceful `shutdown()` — Electron waits (bounded) before killing.
6. **Keep-awake.** `powerSaveBlocker('prevent-app-suspension')` while the control loop runs, plus
   `backgroundThrottling: false`, because macOS App Nap would throttle the 60 Hz loop and heartbeats.
7. **Single instance** lock: a second launch focuses the first (prevents two copies fighting for the HID
   handle).

## 5b. Remote operation over Tailscale (D3) — opt-in, later milestone

**Goal.** An operator who is out of town opens a tailnet URL and operates the production Mac's app.
Tailscale is already installed on this dev machine (`/usr/local/bin/tailscale`), so this is testable locally.

**Today's blockers (verified):** the status server has **no authentication** and is safe only because it
binds `127.0.0.1`; and **controller input comes from a HID gamepad attached to the host Mac**
(`ControllerSupervisor` → `ControlStateMachine`), so a remote browser can look at the dashboard but cannot
"hold the stick". Exposure without auth would let anyone on the tailnet move physical cameras.

**Exposure options**
| Option | How | Verdict |
|---|---|---|
| **`tailscale serve`** | App stays on loopback; Tailscale publishes it to the tailnet over HTTPS (MagicDNS name) and adds identity headers for the requesting user/device | **Recommended.** Keeps the app unexposed, gives us HTTPS and per-user identity, tailnet ACLs apply. (Header names/behavior to be verified against current Tailscale docs.) |
| Bind to the Tailscale interface IP | App listens on `100.x.y.z` | Works, but we'd own TLS and identity ourselves; no identity headers |
| Tailscale Funnel / 0.0.0.0 | Public internet / whole LAN | **Forbidden** — camera control must never be internet-public |

**Design (issues R1–R3)**
- **R1 — Auth and request hardening (valuable even locally).** Host-header allowlist (defeats DNS-rebinding
  against loopback), Origin/CSRF checks on every mutating route and WebSocket upgrade, roles
  (*viewer* vs *operator*; config/profile/remap/Sony-connect/tracking-select are operator-only), and a
  trusted-identity mode: honor Tailscale identity headers **only** when the request arrives from the local
  `tailscale serve` proxy, matched against an allowlist of tailnet logins. Anything else from a non-loopback
  source is refused.
- **R2 — Remote access switch + UX.** Settings → Remote access: detect Tailscale installed/running
  (`tailscale status --json`), one-click enable (creates only *our* `serve` mapping, removes only that on
  disable), shows the tailnet URL + QR code and the active allowlist editor, plus a prominent "Remote access is
  ON" indicator on the host. The wizard offers it as an optional step. Never enables Funnel.
- **R3 — Spike: remote control input.** Feed a *second input source* into `ControlStateMachine.updateInput`
  from the browser (Gamepad API → WebSocket), with a **single active operator** lock and explicit takeover
  (host can always reclaim), dead-man behavior (the existing 250 ms stale-input stop applies to remote input
  too), a latency indicator, and e-stop reachable from both sides. Open questions: what video the remote
  operator sees (Sony live-view previews exist; ATEM program/multiview video does not), and whether
  remote PTZ is usable at Tailscale latency (measure first).
- The host Mac must stay awake and the Electron app running (already covered by keep-awake + launch-at-login).

## 6. User experience

**First run (wizard, all steps skippable and re-enterable from a Setup menu)**
1. Welcome + "Import existing configuration" (pick an old `config/` folder) or start fresh.
2. **Controller**: plug in or pair; the wizard shows detected vs connected (reusing the app's existing
   status detail) and, if silent, a button that opens *System Settings → Privacy → Input Monitoring* with
   plain-language instructions.
3. **Network**: ATEM IP (probe and show green/red), cameras are added later in Device Config.
4. **Sony cameras (optional)**: the app first looks for an existing `CameraWebApp` (see §7). If found and
   healthy → green, nothing to do. If not → **"Set up Sony cameras"**: prerequisite check, numbered steps with
   copy buttons, file pickers for the SDK ZIP you downloaded from Sony, and a live validation step.
   Skippable; everything else works without it.
5. **Gimbals (optional)**: explains the Pi bridge; asks for its address and shows reachability.
6. Done → opens the dashboard.

**Every day**: double-click → window opens on the dashboard within seconds; dock/menu-bar icon shows
overall health (green / amber / red: ATEM, controller, cameras, helpers). Quit asks "Cameras will stop
responding — quit?" and sends `stop()` first. Launch-at-login is an opt-in toggle.

**When something's wrong**: plain-language banners already exist for many states; the wrapper adds
**Help → Export diagnostics** (zip of logs, versions, redacted config, process/health snapshot — no
credentials, Sony approvals, or frames) and **Help → Open logs folder**.

**Updates**: check at launch and daily; download in the background; **never install while a show is live**
(ATEM program active / controller active / tracking on) — show "Update ready — install when you're done".
Config in the app home is untouched by updates; helper processes are stopped and restarted by the shell.

## 7. Sony support without shipping Sony (D1) — locate, guide, validate

We ship **no** Sony material. The product work is making the user-built sidecar easy to install and
effortless for the app to find. Because the app already treats the sidecar as optional and adopts it by
URL/path, nothing in `SonyManager` has to change.

**Locator (E6) — tried in order, first valid wins, result persisted as an absolute `sony.executable`:**
1. `SONY_SERVER_EXECUTABLE` env / `sony.executable` in `devices.yaml` (power users, dev flow).
2. The managed location in the app home: `~/Library/Application Support/CamControl/sony/CameraWebApp`
   (where the guided install puts its output).
3. The default build output of our setup script
   (`<checkout>/api/server/build/CameraWebApp`) for checkouts the app has seen before, plus a short list of
   conventional locations (e.g. `~/alpha-sdk-api/…`).
4. **Locate CameraWebApp…** file picker.

**Validation (every candidate):** file exists and is executable · is arm64 (Apple Silicon only, D5) ·
launches with `--port <free loopback port>` · `GET /api/server/status` returns the expected shape within a
timeout · report its version + SDK version in the UI · then stop it cleanly (`POST /api/server/shutdown`).
A failed candidate yields a specific, plain-language reason and the matching fix from the known-issues list
in `docs/sony-sidecar-setup.md`.

**Guided install ("Set up Sony cameras") — an in-app step-by-step wizard (not a `.pkg`; see below):**

| Step | What the user sees | What the app does |
|---|---|---|
| 0. Prerequisites | Green/red checklist: Xcode Command Line Tools, CMake ≥ 3.16, Node/npm (upstream's `./crsdk` wrapper runs `npm install && npm run build` on first use), git | `xcode-select -p`, `cmake --version`, `node -v`, `git --version`; each missing item shows the exact install command with a copy button. **E6 investigates skipping the `crsdk` wrapper and running upstream's documented raw CMake steps, which would drop the Node requirement.** |
| 1. Get Sony's SDK | "Download the Camera Remote SDK from Sony" + **Open Sony's download page** | Opens the page in the browser. Links only — the app never downloads Sony files. |
| 2. Choose the ZIP | **Choose SDK ZIP…** file picker | Checks it is the macOS package and notes the version (tested: `V2.02.00`); warns on other versions. Stores the path only; never copies or uploads the ZIP. |
| 3. Sony's license | Sony's own license page shown in a panel (it is a web page at Sony's URL, **not a file inside the ZIP**), an explicit "I have read and accept" checkbox, then **Accept and continue** | Nothing is accepted on the user's behalf. Only after that explicit click does the app answer `crsdk install`'s own y/n prompt, which writes Sony's `.license-accepted` marker. **To verify:** how `setup-sony-sidecar.sh` and `crsdk` layer their two prompts, and whether relaying the acceptance click is acceptable to Sony — if not, this one step opens Terminal instead. |
| 4. Get the server code | Use an existing `alpha-sdk-api` checkout, **or** "Download it for me" (pinned revision `225ab52`, MIT) | Optional user-initiated `git clone` (see open question below). |
| 5. Build | One big **Build camera service** button, live log, progress stages, Cancel | Runs our bundled `setup-sony-sidecar.sh` (applies the status-fix patch, `./crsdk install --zip`, `./crsdk build`), streams output, maps known failures to plain-language fixes. Also performs/verifies upstream's macOS step of clearing quarantine and ad-hoc signing the SDK/OpenCV dylibs (**verify whether `crsdk build` already does this**). Build time is unmeasured. |
| 6. Finish | "Sony support ready" with version + SDK version | The locator registers the built binary, starts it, health-checks it, shuts it down cleanly; `sony.executable` is saved. |

Re-runnable any time from Setup (new SDK version, rebuilt binary, moved folder). Camera-side guidance (PC Remote
mode, FX3A pairing, one-session-at-a-time) appears beside the camera list, reusing the existing troubleshooting text.
`docs/sony-sidecar-setup.md` is rewritten as the user-facing "Install Sony camera support" page (screenshots, plain
language), opened from the wizard and Help; the `statusServer` route that serves it must resolve to the bundled copy (E1).

**Why an in-app wizard rather than a macOS `.pkg` installer:** a `.pkg` (Installer.app) gives Welcome/License/Destination
pages, but it is built for copying files, typically runs with administrator privileges (we do not want to compile third-party
code as root), cannot stream a live build log or offer a retry button, and cannot be re-opened later. The recommended
shape is a plain DMG (drag to Applications) for the main app, then this wizard on first launch.

**About/legal:** About → Licenses states plainly "The Sony Camera Remote SDK is **not** included; you download
it from Sony under Sony's license." Release notes repeat it.

**Open question (small):** should the app be allowed to `git clone` upstream `alpha-sdk-api` (MIT, pinned
revision) on an explicit click, or must users bring their own checkout? The existing policy ("never clones")
was written for the *runtime*; a user-initiated, pinned, MIT clone in the setup flow is recommended for
friendliness. **Unverified:** that a locally built, ad-hoc-signed `CameraWebApp` launches cleanly as a child
of the hardened/notarized app — E6 must test this on a clean machine.

## 8. Python sidecar (tracking) — later, after #29–#31

Bundle a relocatable Python (python-build-standalone) with pinned wheels; launched by the app with
`TRACKER_SIDECAR_CMD`; model weights downloaded on first use to the cache path with checksum + resume,
licensed per the tracking plan's T8 check. Expect the installer to grow by hundreds of MB once ONNX stack
and opencv are included — measure before promising a size. Pure-Node helpers (none today) would add nothing.

## 9. Signing, permissions, and update mechanics
- **Who/where**: D2 — release builds are made on AJ's main machine, which already has the Developer ID and a known
  notarization procedure. E8's first task is to *discover and document that existing procedure* (no certificates,
  passwords, or notary credentials are ever committed or pasted into issues/CI logs). Recommended: a release
  script run on that machine that builds, signs, notarizes, staples, and publishes with `gh release create`;
  GitHub Actions only for unsigned build/test checks, unless AJ later chooses to put signing secrets in CI.
- Tooling: **electron-builder** (extraResources, asarUnpack, notarization, `electron-updater`) — confirmed
  by the swarm as the mature path for native modules; alternatives (Forge) noted, not adopted.
- Sign order: sign all nested binaries/dylibs → sign app → notarize → staple → DMG. Entitlements file to
  be derived empirically from failures, recorded in the run note.
- Info.plist: `NSLocalNetworkUsageDescription` (ATEM/VISCA/Pi on the LAN), usage strings for any other
  prompts discovered in testing. Input Monitoring is granted by the user in System Settings to the signed app.
- Stable bundle ID (`com.<org>.camcontrol`) and a single long-lived Developer ID; never re-sign with a
  different identity between releases.
- Updates: signed `latest-mac.yml` from public GitHub Releases (D6 — no token needed since the repo is public); version pinning/downgrade refusal;
  pre-update graceful stop; post-update helper restart.

## 10. Issues (Electron milestone set)

Sizes: S ≤ ½ day, M ≈ 1 day, L ≈ 2 days. **Gate** = needs a human/external decision.

| Order | ID | Title | Goal | Likely files | Tests / evaluation | Depends on |
|---|---|---|---|---|---|---|
| 0 | **E13a** | **MIT LICENSE + package metadata (do first, independent)** | The repo is public with **no license file**. Add MIT `LICENSE`, `license`/`author` in `package.json`, README licensing note | `LICENSE`, `package.json`, `README.md` | `git diff --check`; GitHub shows the license; holder name confirmed by AJ | — (S) |
| 1 | E0a | Record resolved decisions D1–D6 (ADR) | One decision record: Sony not shipped, Tailscale, open source, arm64, GitHub Releases | `docs/ai/decisions/2026-09-30-electron-wrapper.md`, `decisions.md` index | Reviewed | — (S) |
| 2 | E0b | Spike: Electron + `node-hid` + `utilityProcess` | Prove the app runs packaged, HID reads a real controller, 60 Hz loop holds timing, no App Nap drift | throwaway `electron/` spike branch, run note | Timing histogram of loop ticks for 30 min idle + active; HID works; result in `docs/ai/runs/` | — (M) |
| 3 | E1 | App home paths abstraction | `src/config/paths.ts`; `CAMCONTROL_HOME`; replace `process.cwd()` uses; dev behavior unchanged | `configLoader.ts`, `index.ts`, `statusServer.ts`, `sonyStateStore.ts`, logger file dir | Smoke: default = cwd; env override; all config/profile/doc reads resolve under the home; `pnpm build`; coordinate with in-flight rigs work on `configLoader.ts`/`statusServer.ts` | E0b (M) |
| 4 | E2 | Embedded-mode contract | Free-port + `ready`/`shutdown` messages, `process.parentPort` handling, log to app home, flag to disable HID for tests | `src/index.ts`, new `src/embed.ts`, `statusServer.ts` (port) | Smoke: ready message carries port; shutdown message runs graceful shutdown and exits 0; unchanged behavior when not embedded | E1 (M) |
| 5 | E3 | Electron shell skeleton | `electron/` main: window, utilityProcess supervisor w/ crash restart + "restarting" UI, single-instance, `powerSaveBlocker`, quit-safety prompt, `pnpm electron:dev` | `electron/**`, `package.json` | Automated: launch under `CAMCONTROL_NO_CONTROLLER=1`, window loads health endpoint, kill child ⇒ restarts, quit ⇒ no orphans | E2 (L) |
| 6 | E4 | Packaging (unsigned dev DMG) | electron-builder config, hoisted deps, `@electron/rebuild` for `node-hid`, asarUnpack, resource layout, seeded defaults | `electron-builder.yml`, `.npmrc`, `package.json`, `resources/defaults/` | Build on clean checkout; open the DMG on a second Mac/user account; app starts, config seeded once, second launch doesn't overwrite | E3 (L) |
| 7 | E5 | First-run wizard + permissions helper + import | Wizard steps, Input-Monitoring help, ATEM probe, import-old-config | `electron/wizard/**`, small API additions | UI fixtures for each step; idempotent re-entry; import never overwrites without confirm; manual run on a fresh user account | E4 (L) |
| 8 | E6 | Sony locator + guided install (no Sony shipped) | Locator order, validation (arm64, launch, health, versions), prerequisite check, guided install runs our `setup-sony-sidecar.sh`, registers result; rewrite the install doc for end users | `electron/sony/**`, `scripts/setup-sony-sidecar.sh` (bundled), `docs/sony-sidecar-setup.md`, `statusServer.ts` doc route | Unit tests for locator precedence and validation failures with fake binaries; module absent ⇒ app starts normally; valid build ⇒ adopted and healthy; no Sony file ever appears in the app bundle or release assets (scripted check); **clean-machine run of the full guided install by a human**; confirm ad-hoc-signed child launches under the notarized app | E1, E4 (L) |
| 9 | E7 | Helper process ledger + orphan cleanup | Spawn ledger so helpers die with the app even after crash/force-quit (process group + startup sweep of stale PIDs) | `src/` helper spawning, `electron/` | Kill -9 the app ⇒ next start cleans stale helper; no port collision | E3, E6 (M) |
| 10 | E8 | Signing, notarization, release script | Document the existing main-machine procedure; script: build → sign nested binaries → notarize → staple → DMG → `gh release create`; hardened-runtime entitlements derived empirically | `scripts/release.sh`, `build/entitlements*.plist`, `docs/releasing.md`, optional CI for unsigned checks | Notarization succeeds; `spctl` accepts; Input Monitoring grant persists across a version bump; **no secrets in repo/logs** (grep check) | E4 (L, **human on main machine**) |
| 11 | E9 | Auto-update with live-show guard | `electron-updater` (public GitHub Releases, no token), background download, install deferral while live, helper stop/restart | `electron/updater.ts` | Update from N to N+1 on a test channel preserves config; deferral honored; signature failure refuses | E8 (M) |
| 12 | E10 | Diagnostics, tray/menu, launch-at-login | Export diagnostics (redacted), logs folder, health icon, login item toggle | `electron/**` | Redaction test (no credentials/approvals/frames in bundle); manual | E3 (M) |
| 13 | E11 | Tracker sidecar packaging | python-build-standalone + pinned wheels, model fetch w/ checksum/resume | `resources/python/`, `electron/` | Offline-after-first-run start; checksum failure handled; size recorded | tracking #29–#31, E8 (L) |
| 14 | E12 | Clean-machine verification + docs + state update | Fresh macOS user/VM install, permission prompts, 30-min soak in packaged app, runbook | `docs/electron.md`, `docs/ai/*` | Human drill recorded in `docs/ai/runs/` | all (S + human) |
| 15 | **E13b** | Third-party notices + license tooling | Generated `THIRD_PARTY_NOTICES.md` for everything we bundle (npm prod deps, Electron/Chromium license files, Python stack when E11 lands, `pi-bridge` notice, alpha-sdk-api patch attribution); About → Licenses viewer; CI/script check that fails on GPL/AGPL/unknown prod licenses | `THIRD_PARTY_NOTICES.md`, `scripts/licenses.*`, `electron/about/**`, `electron-builder.yml` | Script run reproduces the file; check fails on a fake GPL dep; installer contains the license files (inspect the built app); direct deps today are MIT/ISC/(MIT OR X11) | E4 (M) |
| 16 | **E13c** | Open-source readiness audit | Secret/history scan; move personal network data (`192.168.50.x`, hostnames) out of committed defaults into examples; review `docs/CamControl-Volunteer-Guide.pdf`; `SECURITY.md` (important: this controls physical cameras), `CONTRIBUTING.md`, issue templates, trademark/nominative-use disclaimer (Sony, DJI, Blackmagic/ATEM, BirdDog, V-BOT, Raspberry Pi, Tailscale) | repo root docs, `config/` (templates), `README.md` | Scan report recorded in a run note; fresh clone builds with generic example config | E13a (M) |
| 17 | **R1** | Auth + request hardening | Host allowlist, Origin/CSRF checks, viewer/operator roles, trusted Tailscale-identity mode with login allowlist; applies to HTTP + WebSocket | `src/ui/statusServer.ts`, new `src/ui/auth.ts`, `configLoader.ts`, smoke | Smoke: bad Host/Origin refused; mutating routes need operator; identity headers ignored unless from the local proxy; loopback behavior unchanged for the Electron window | E1 (L) |
| 18 | **R2** | Remote access switch + UX (Tailscale serve) | Detect Tailscale, enable/disable *our* `tailscale serve` mapping only, tailnet URL + QR, allowlist editor, "remote ON" indicator, wizard step | `electron/remote/**`, `statusServer.ts` (settings API) | Fake `tailscale` CLI tests (enable/disable idempotent, never Funnel, removes only our mapping); manual test over a real tailnet from a second device | R1, E5 (L) |
| 19 | **R3** | Spike: remote control input | Browser Gamepad → WS second input source, single-operator lock + takeover, stale-input stop, latency indicator, e-stop both sides; written go/no-go with measured latency | spike branch, run note | Measured end-to-end input latency over Tailscale; safety drills (drop connection mid-move ⇒ stops ≤ ~0.5 s) | R1, R2 (L, **spike**) |

Dependency graph:
```
E13a (LICENSE) — do first, independent ──▶ E13c
E0a (ADR)   E0b ─ E1 ─ E2 ─ E3 ─ E4 ─┬─ E5 ─────────┐
                      │               ├─ E6 ─ E7      │
                      └─ R1 ─ R2 ─ R3 ├─ E8 ─ E9      ▼
                                      ├─ E10 ──────▶ E12 ◀─ E11 (after tracking #29–#31)
                                      └─ E13b
```
Suggested milestones: **Electron M1 — Foundation** (E0a, E0b, E1, E2, E3), **M2 — Installable app** (E4, E5, E6, E7),
**M3 — Shippable & open** (E8, E9, E10, E13b, E13c), **M4 — Tracking + verification** (E11, E12),
**M5 — Remote access** (R1, R2, R3). **E13a** is a standalone quick win — do it now, separately from all milestones.

**Shared hot files — serialize or coordinate with other work:** `configLoader.ts` and `statusServer.ts`
(E1, E2, R1) are also being edited by the rigs UI work; `src/index.ts` (E2) is touched by tracking (T4).

## 11. Validation plan
- Per issue: `pnpm build`; `STATUS_PORT=<free> pnpm test:smoke`; `pnpm test:smoke:isolated` for packaged paths.
- Packaged-app checks (E3/E4): launch with HID disabled → health endpoint green → child killed → restart →
  quit → zero leftover processes (`pgrep` for app/Sony/Python).
- Clean-machine drill (E12), human: fresh macOS user, download DMG, Gatekeeper opens it, wizard completes,
  controller permission flow works, ATEM probe, (if present) Sony camera connects, tracking (if present) works,
  30-minute idle and active soak with timing stable, force-quit leaves nothing running, update N→N+1 keeps
  config and permissions.

## 12. Risks
1. **Sony setup friction** — not shipping Sony means every user must build the sidecar (Xcode CLT, cmake, Sony's
   license). Mitigated by prerequisite checks, the guided flow, and a clean-machine test; still the roughest edge
   of the product. **Unverified:** a locally built child process under a notarized, hardened app.
2. **Loop timing in a GUI app** (App Nap, renderer contention) — E0b spike measures it first.
3. **`node-hid` + hardened runtime + TCC** may need entitlement tuning and can silently fail only when
   signed/notarized — test signed builds early, not at the end.
4. **Notarization of third-party binaries** can fail cryptically if any dylib/adapter is unsigned.
5. **Updates mid-show** — guard + deferral is required, not optional.
6. **Remote exposure** — once on Tailscale the UI can move physical cameras from any permitted device. R1 (auth,
   roles, host/origin checks) must land before R2; Funnel/public exposure is never enabled; latency and
   dead-man behavior decide whether R3 is viable.
7. **Path refactor regressions** (E1) touch code the rigs work is also changing — serialize and keep smoke green.
8. **Installer size** with the Python/ONNX stack.
9. **License obligations when bundling** — Electron/Chromium notices must ship in the app; if we later bundle
   `opencv-python` wheels they include FFmpeg (LGPL — **verify**); detector model weights need their own license
   check; the repo is public with no license today (E13a).
10. **Two lockfiles** (`pnpm-lock.yaml`, `package-lock.json`) — pick one before packaging; electron-builder needs a
   hoisted layout.

## 13. Out-of-scope follow-ups (not issues yet)
Pi-bridge deploy/update helper · Windows / Intel builds · remote diagnostics upload · remote ATEM program video
/ multiview for the out-of-town operator · in-app Sony SDK build pipeline (only if option B proves viable) · Mac App Store.

## 14. Completion checklist
- [x] Plan written
- [x] Issues atomic with likely files and tests
- [x] Dependencies and gates stated
- [x] Data-safety risks documented
- [x] User answers D1–D6 (2026-09-30) folded in
- [x] Copyright holder: AJ Hochhalter
- [x] Issues filed (see §15)

## 15. Filed on GitHub (2026-09-30)

| ID | Issue | Milestone |
|---|---|---|
| E13a | https://github.com/ajhochy/fps-camcontrol/issues/37 | — (standalone; closed by the LICENSE commit) |
| E0a | https://github.com/ajhochy/fps-camcontrol/issues/38 | Electron M1 |
| E0b | https://github.com/ajhochy/fps-camcontrol/issues/39 | Electron M1 |
| E1 | https://github.com/ajhochy/fps-camcontrol/issues/40 | Electron M1 |
| E2 | https://github.com/ajhochy/fps-camcontrol/issues/41 | Electron M1 |
| E3 | https://github.com/ajhochy/fps-camcontrol/issues/42 | Electron M1 |
| E4 | https://github.com/ajhochy/fps-camcontrol/issues/43 | Electron M2 |
| E5 | https://github.com/ajhochy/fps-camcontrol/issues/44 | Electron M2 |
| E6 | https://github.com/ajhochy/fps-camcontrol/issues/45 | Electron M2 |
| E7 | https://github.com/ajhochy/fps-camcontrol/issues/46 | Electron M2 |
| E8 | https://github.com/ajhochy/fps-camcontrol/issues/47 | Electron M3 |
| E9 | https://github.com/ajhochy/fps-camcontrol/issues/48 | Electron M3 |
| E10 | https://github.com/ajhochy/fps-camcontrol/issues/49 | Electron M3 |
| E11 | https://github.com/ajhochy/fps-camcontrol/issues/50 | Electron M4 |
| E12 | https://github.com/ajhochy/fps-camcontrol/issues/51 | Electron M4 |
| E13b | https://github.com/ajhochy/fps-camcontrol/issues/52 | Electron M3 |
| E13c | https://github.com/ajhochy/fps-camcontrol/issues/53 | Electron M3 |
| R1 | https://github.com/ajhochy/fps-camcontrol/issues/54 | Remote access |
| R2 | https://github.com/ajhochy/fps-camcontrol/issues/55 | Remote access |
| R3 | https://github.com/ajhochy/fps-camcontrol/issues/56 | Remote access |
