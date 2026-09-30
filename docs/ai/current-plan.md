---
type: project
---

# Current Plan — Automated Sony Camera Operations

## Status
Design only; implementation is blocked on AJ's approval. Integration target: PR #2 branch `fix/controller-visca-ptz-and-multi-cam`, represented by verified combined commit `e9e4472`.

## Goal
Optionally launch a preconfigured Sony `alpha-sdk-api` sidecar, remember operator-approved camera IDs, and reconnect only those cameras across app/camera restarts without delaying or preventing normal CamControl startup.

## Constraints
- Ponytail full: no installer, updater, SDK downloader, or embedded build pipeline; a configured executable plus a developer/first-run setup script is sufficient.
- Unknown camera IDs are discovery results only and always require an explicit **Connect** action before they become remembered/auto-connect eligible.
- Sony is optional: absent executable, failed sidecar launch, unhealthy sidecar, or no Sony camera must not block existing startup or non-Sony operation.
- The Sony SDK ZIP must not be redistributed unless its license is separately reviewed and confirmed to permit redistribution.
- Developer setup (license acceptance, SDK download, sidecar build) is distinct from runtime process launch.
- Keep the sidecar on loopback by default; do not expose credentials, pairing secrets, or full sensitive upstream bodies in UI or logs.
- No new Node dependency unless the standard library proves insufficient.
- Per-camera work is serialized; retries are bounded, jittered, cancelable, and limited to remembered IDs.
- Existing dashboard behavior and explicit Device Config discovery/connect flow remain backward compatible.

## Current evidence and unknowns
- Current proxy contract and Sony UI live in `src/ui/statusServer.ts`; tests use an in-process fake upstream in `src/testing/smokeTest.ts`.
- Current sidecar base URL is `SONY_API_URL`, defaulting to `http://127.0.0.1:8181`.
- Upstream primary sources confirm launch as `CameraWebApp --port <port>`, health at `GET /api/server/status`, graceful shutdown at `POST /api/server/shutdown`, and the discovery/connection/property/live-view/touch shapes.
- The upstream contract explicitly has no stable machine-readable error code in every error body; exact pairing/authentication responses from AJ's built binary and cameras remain **UNVERIFIED** and require the live contract probe before implementation locks the classifier.

## Design

### Approaches

| Approach | Shape | Advantages | Costs / risks |
|---|---|---|---|
| **A. Optional in-process supervisor (recommended)** | CamControl probes the configured API URL, optionally spawns a configured `CameraWebApp`, and owns approval/reconnect state. | Meets automatic launch and reconnect requirements; no installer; Sony failure stays isolated; one place owns concurrency and state. | Adds a small lifecycle component and requires careful owned-vs-external shutdown behavior. |
| **B. External service only** | A first-run script or operator starts the sidecar through `launchd`; CamControl only probes it and reconnects approved IDs. | Smallest app change and strongest process isolation. | Does not provide app-owned start/crash recovery; setup is less portable and troubleshooting spans two service managers. |
| **C. Bundle/build/update Sony inside CamControl** | Vendor SDK artifacts or clone/build/update the sidecar automatically. | Lowest apparent operator effort after packaging. | Rejected: conflicts with Sony download/EULA constraints, increases release risk, and violates the requested no-installer/updater boundary. |

**Recommendation:** Approach A, with external-service adoption built in. If `sony.executable` is absent, CamControl behaves exactly like Approach B: it probes the URL, reports setup guidance, and never treats Sony as a startup prerequisite.

### Legal and packaging boundary

- `crsdk/alpha-sdk-api` is MIT, but its own primary documentation states that Sony Camera Remote SDK headers, libraries, Sony sample-derived `shared/core` sources, and SDK ZIP are not redistributed. Each developer/operator downloads the SDK from Sony after accepting Sony's license.
- **Developer setup:** an optional `scripts/setup-sony-sidecar.sh` accepts an already-downloaded SDK ZIP and an existing/local `alpha-sdk-api` checkout, invokes that checkout's `./crsdk install --zip …` and `./crsdk build`, verifies `/api/server/status`, and prints the resulting executable path. It neither downloads the Sony ZIP nor runs during CamControl startup.
- **Runtime launch:** CamControl only runs the already-built configured executable. It does not clone, install, build, update, sign, or redistribute the sidecar or Sony files.
- Shipping any built sidecar/runtime bundle to other users remains blocked on a separate Sony-license review; this plan assumes local builds only.

Primary sources checked: [alpha-sdk-api README](https://github.com/crsdk/alpha-sdk-api), [SDK setup](https://github.com/crsdk/alpha-sdk-api/blob/main/docs/SDK_SETUP.md), [building binaries](https://github.com/crsdk/alpha-sdk-api/blob/main/docs/BUILDING_BINARIES.md), and its [OpenAPI contract](https://github.com/crsdk/alpha-sdk-api/blob/main/api/openapi.yaml).

### Minimal architecture

#### Configuration

Add one optional top-level block to `config/devices.yaml`, validated in `src/config/configLoader.ts`:

```yaml
sony:
  enabled: true
  apiUrl: http://127.0.0.1:8181
  executable: /absolute/path/to/CameraWebApp # optional; absent = external sidecar
  stateFile: config/sony-cameras.json
```

Environment overrides, in precedence order over YAML: `SONY_ENABLED`, existing `SONY_API_URL`, `SONY_SERVER_EXECUTABLE`, and `SONY_STATE_FILE`. Defaults are `enabled: true`, loopback `http://127.0.0.1:8181`, no executable, and `sony-cameras.json` beside `DEVICES_CONFIG`. Do not add configurable command arguments: the verified sidecar contract only needs `--port <apiUrl.port>`.

#### Components and ownership

- `SonyManager` is constructed once in `src/index.ts`, injected into `createStatusServer`, and owns sidecar health, approved-camera state, discovery, connect/retry scheduling, and per-camera operation lanes.
- `SonySidecar` is a small internal helper owned by the manager. It probes, spawns, drains logs, reports status, and stops only a child it spawned. It never kills or shuts down an already-running external server it merely adopted.
- Existing `/api/sony/*` proxy routes delegate through the manager, so UI actions and background reconnects share validation, classification, and the one-operation-per-camera rule.
- `statusServer.ts` remains the UI/API adapter; it does not own durable Sony state or background timers.

#### Sidecar process behavior

1. `SonyManager.start()` returns immediately; `src/index.ts` does not await Sony readiness. Existing ATEM, motion devices, controller loop, watchdog, and status server continue to start even when Sony is absent.
2. In the background, probe `GET /api/server/status` at the configured URL with a 1.5 s timeout. A valid `200` object containing `success`, `server.version`, `server.sdkVersion`, and camera counts is healthy.
3. If healthy, adopt it as `external`; never stop it. If unhealthy and no executable is configured, enter `absent` and keep low-rate health probes.
4. If an executable is configured, require a loopback API URL, verify an absolute executable file, and spawn `[executable, "--port", apiUrl.port]` with `cwd = dirname(executable)`, `stdio = [ignore, pipe, pipe]`, and no shell. Drain both streams continuously; retain/log only bounded, redacted lines.
5. Poll health every 250 ms for at most 15 s. Readiness failure kills only the owned child and marks Sony degraded; it never fails `main()`.
6. An unexpected owned-child exit triggers jittered restarts after 1, 2, 4, 8, then 15 s (±20%), capped at five attempts per five-minute outage. After the cap, remain `crashed` until a UI **Retry Sony service** action or app restart. A healthy run of five minutes resets the budget.
7. Shutdown handles both `SIGINT` and `SIGTERM`: stop timers/queues, request owned-sidecar `POST /api/server/shutdown` (2 s), wait up to 3 s, send `SIGTERM`, wait 2 s, then `SIGKILL` only the still-running owned child. Repeated stop calls are safe. External/adopted servers are untouched.

#### Persisted approvals

Default location: `config/sony-cameras.json`, or the directory containing `DEVICES_CONFIG` when that override is used. `sony.stateFile` / `SONY_STATE_FILE` can override it.

```json
{
  "version": 1,
  "approvedCameras": [
    {
      "id": "D10F60149B0C",
      "model": "ILCE-9M3",
      "connectionType": "USB",
      "approvedAt": "2026-08-13T20:00:00.000Z"
    }
  ]
}
```

- `id` and `approvedAt` are authoritative; model/connection type are display hints only. Runtime connection status, retry counters, and errors are not persisted.
- An explicit **Connect** adds/updates an ID only after the sidecar confirms a successful connection. Discovery alone never approves. **Forget** removes approval atomically and prevents future auto-connect; it may best-effort disconnect but succeeds even if the camera/sidecar is absent.
- Validate schema/version and reject duplicate or unsafe IDs. Do not retain the current MAC-only assumption: upstream examples use stable alphanumeric hardware IDs. URL path segments use `encodeURIComponent` rather than interpolation after a MAC regex.
- Serialize writes. Write JSON plus newline to a same-directory uniquely named temp file with mode `0600`, `fsync` and close it, then atomic `rename` over the destination; clean up stale temp files on failure. A malformed existing file is quarantined to `.corrupt-<timestamp>`, logged without contents, and starts with no approvals rather than approving anything implicitly.
- No username, password, fingerprint, token, or other credential is stored in this file or logged.

#### Discovery, reconnect, and concurrency

1. Once sidecar health is confirmed, call `GET /api/cameras` and refresh the visible discovery set.
2. Unknown IDs appear as `discovered_unapproved` with an explicit **Connect** action; no background operation targets them.
3. For each approved ID: if already connected, mark connected; if discovered but disconnected, enqueue connect in `remote` mode; if absent, mark disconnected and schedule rediscovery.
4. A powered-off approved camera is retried in bounded bursts at 2, 5, 10, 20, and 30 s (±20% jitter). After a burst, a low-rate 60 s discovery probe continues so a camera powered on later is recovered. Its reappearance starts a fresh burst. Delays are capped, timers are cancelable, and one sidecar outage creates one shared health probe rather than N camera probes.
5. Each camera has one operation lane. Connect, connection status, property writes, live-view start, and touch actions are serialized. Polling reads (status/frame/property refresh) coalesce and are skipped with `503` plus `Retry-After` when a lane is occupied; they never form an unbounded queue. Explicit user actions wait behind at most the current operation and retain existing endpoint timeouts.
6. Sidecar loss cancels camera work and marks approved cameras disconnected. Sidecar recovery performs the startup sequence again. Forget cancels that camera's timer and queued lifecycle work before persisting removal.

#### Pairing-required classification

The upstream OpenAPI explicitly says its error body has no stable machine-readable code, while current source sometimes adds `data.error_code` for SDK connect failures. Therefore classification must be conservative:

- `needs_pairing` only when a real-sidecar contract probe has pinned an exact allowlist for authentication/fingerprint refusal codes or a documented remote-shooting/pairing-required response. Known examples to probe are fingerprint mismatch (`CrError_Connect_SSH_ServerAuthenticationFailed`), username/password rejection (`CrError_Connect_SSH_UserAuthenticationFailed`), and connection timeout guidance when remote shooting is disabled.
- Camera absent from discovery, unplugged/powered off, connection lost, timeout, `ECONNREFUSED`, or sidecar unavailable is `disconnected`/sidecar degraded, never pairing-required.
- Any unrecognized `400` or SDK failure is `error`, with no automatic pairing claim. It may be retried only if the probe classifies it as transient.
- This scope does not persist Sony access-auth credentials. A camera requiring credentials shows **Needs pairing / camera setup** and an explicit **Retry Connect** after the operator completes camera-side setup. Adding secure credential storage is a separate, approval-gated feature.

Before implementation, run the actual locally built sidecar against the target Sony body and capture sanitized HTTP status/body samples for: successful connect, camera off, remote shooting disabled, fingerprint mismatch, bad credentials (if applicable), disconnect, and reconnect. Pin those fixtures in smoke tests. Until then the numeric code allowlist is **UNVERIFIED**.

#### Health/status API and UI

Add `GET /api/sony/status`:

```json
{
  "sidecar": {
    "mode": "managed",
    "state": "healthy",
    "owned": true,
    "apiUrl": "http://127.0.0.1:8181",
    "version": "3.0.0",
    "sdkVersion": "V2.02.00",
    "message": null
  },
  "cameras": [
    {
      "id": "D10F60149B0C",
      "approved": true,
      "state": "connected",
      "model": "ILCE-9M3",
      "connectionType": "USB",
      "lastSeenAt": "2026-08-13T20:01:00.000Z",
      "nextRetryAt": null,
      "message": null
    }
  ]
}
```

Sidecar states: `disabled`, `absent`, `starting`, `healthy`, `crashed`. Camera states: `discovered_unapproved`, `connecting`, `connected`, `disconnected`, `needs_pairing`, `error`. The API omits executable paths, process environment, raw sidecar logs, and credentials.

UI behavior:

| User job | Entry point | Visible result | Action |
|---|---|---|---|
| Approve a new camera | Device Config → Discover | `New camera — approval required`; it does not appear as an active dashboard widget | **Connect** |
| Resume a known camera | App startup / camera power-on | `Connecting`, then dashboard controls appear without another approval | automatic; **Retry Connect** on demand |
| Fix camera setup/auth | Device Config | Amber `Needs pairing / camera setup`, concise camera-side guidance | **Retry Connect** only after setup |
| Distinguish ordinary outage | Dashboard + Device Config | Red/neutral `Disconnected — camera not found` with next retry time | automatic retry; **Retry Connect** |
| Recover sidecar | Sony status banner | `Sony service absent/crashed`; all non-Sony UI remains usable | **Retry Sony service**; setup instructions if no executable |
| Revoke trust | Device Config | Camera remains discoverable but will not auto-connect again | **Forget** with confirmation |

Dashboard widgets remain connected-camera-only. Device Config is the authoritative place for discovery, approval, pairing guidance, and forget/retry actions. Existing Sony property/live-view/touch controls remain unchanged when connected.

#### Security and logging

- Managed launch is permitted only for loopback `apiUrl`; remote URLs are external-only. The sidecar has no HTTP authentication, so documentation must warn against binding/exposing it beyond trusted localhost.
- Spawn with an argument array and `shell: false`; do not accept arbitrary argument strings from YAML or the browser.
- Logs may contain state, camera ID/model, attempt count, delay, HTTP status, sidecar version, and sanitized error class. Never log request bodies for connect, environment dumps, credentials, fingerprints, or complete raw error bodies. Throttle recurring sidecar/camera warnings through the existing log-throttle pattern.
- Browser endpoints continue validating camera IDs and property names; IDs are encoded before upstream use. UI receives curated messages, not raw sidecar output.

### Doubt review

This design is wrong if the deployed sidecar differs materially from current `alpha-sdk-api` main (notably camera-ID format, port default, connect body, health shape, or authentication errors). The cheapest proof is the contract probe above against AJ's exact binary and cameras, followed by recording its commit/version and fixtures. Do not infer pairing from message substrings until that probe passes.

## File structure map

| File | Responsibility |
|---|---|
| `src/config/configLoader.ts` | Validate/load optional Sony runtime configuration and environment overrides. |
| `src/sony/sonyStateStore.ts` (new) | Versioned approval schema and serialized atomic persistence. |
| `src/sony/sonyManager.ts` (new) | Sidecar process/health lifecycle, discovery, state machine, retries, and per-camera lanes. |
| `src/index.ts` | Construct/start the optional manager without awaiting it; stop it on SIGINT/SIGTERM. |
| `src/ui/statusServer.ts` | Delegate Sony routes to the manager; expose status/retry/forget actions and render states. |
| `src/testing/smokeTest.ts` | Fake sidecar/process/store coverage and startup-nonblocking regression checks. |
| `scripts/setup-sony-sidecar.sh` (new) | Developer-only helper around an existing sidecar checkout and user-supplied Sony ZIP. |
| `docs/sony-sidecar-setup.md` (new) | License boundary, setup, configuration, camera preparation, and live checks. |

## Approval-level implementation slices

| Slice | Likely files | Falsifiable acceptance criteria | Dependencies | Required validation |
|---|---|---|---|---|
| **1. Contract probe + setup boundary** *(disjoint)* | `scripts/setup-sony-sidecar.sh`, `docs/sony-sidecar-setup.md`, sanitized fixtures under `src/testing/fixtures/` if established by repo convention | Script requires an existing checkout + local ZIP, never downloads Sony assets, builds/prints the executable, and the target binary's health/connect/failure shapes are recorded with version/commit. | AJ-provided SDK ZIP/license acceptance and physical camera; blocks final pairing classifier. | Shell syntax check; run setup against local checkout; curl `/api/server/status`; execute the live failure matrix above. |
| **2. Config + approval store** *(parallel/disjoint production files)* | `src/config/configLoader.ts`, `src/sony/sonyStateStore.ts`, `config/devices.yaml` comments | Env precedence matches the named contract; approval survives restart; unknown discovery cannot write state; concurrent saves yield valid schema; interrupted write leaves old or new complete JSON, never truncation. | Design approval only. | `pnpm build`; focused smoke assertions using a temp state/config directory; `git diff --check`. |
| **3. Sony manager lifecycle** *(parallel after interfaces are fixed)* | `src/sony/sonyManager.ts`, `src/index.ts` | Existing app reaches status-server ready state with no executable/sidecar; healthy external server is adopted and not killed; owned process receives graceful shutdown/fallback; crash budget and late camera power-on recover exactly as specified; one in-flight call per ID. | Slice 2 interfaces; Slice 1 fixtures for final pairing codes. | `STATUS_PORT=<free> pnpm test:smoke`; fake child + fake HTTP lifecycle tests; process-leak check after SIGINT/SIGTERM. |
| **4. Routes + operator UX** *(mostly disjoint; integrate last)* | `src/ui/statusServer.ts`, `src/testing/smokeTest.ts` | Status JSON matches the documented shape; only successful explicit Connect approves unknown IDs; Forget prevents restart auto-connect; all named UI states/actions render; connected widgets retain current controls; sidecar absence does not degrade other tabs/routes. | Slices 2–3. | `pnpm build`; `STATUS_PORT=<free> pnpm test:smoke`; `node scripts/check-page-js.cjs`; browser fixture for every journey row; live two-camera/power-cycle check. |

Parallel coding order after approval: run Slice 1 (hardware/contract) alongside Slice 2; freeze the manager/store interfaces; run Slice 3; then integrate Slice 4 because `statusServer.ts` and `smokeTest.ts` are shared hot files. A fresh implementation dispatch is recommended rather than carrying planning research context into coding agents.

## Acceptance criteria

1. With no `sony` block, no sidecar, or an invalid/missing executable, CamControl's existing status UI and non-Sony operations start normally; Sony reports a nonfatal actionable state.
2. CamControl never downloads/builds/updates Sony components at runtime and the repository/package contains no Sony SDK ZIP, headers, libraries, or sample-derived sources.
3. A discovered unknown ID receives no automatic connect request before explicit Connect succeeds; after success it is atomically persisted and reconnects after app restart.
4. A remembered camera that is off at startup reconnects without operator approval after later discovery, within 75 seconds under the dormant 60-second probe schedule.
5. Pairing-required is emitted only for pinned sidecar evidence; camera absence/sidecar outage is displayed as disconnected/degraded instead.
6. At most one upstream operation per camera is in flight, polling cannot build an unbounded queue, and retries stay within the specified caps/jitter.
7. Owned sidecars shut down gracefully on SIGINT/SIGTERM and are force-killed only after deadlines; adopted/external sidecars remain running.
8. Approval writes are atomic and schema-valid after simulated write interruption; no credentials or fingerprints appear in state, UI JSON, or logs.
9. Existing Sony properties, previews, touch focus, and non-Sony smoke behavior remain passing.

## Automated and live checks

```bash
pnpm build
STATUS_PORT=8175 pnpm test:smoke
node scripts/check-page-js.cjs
git diff --check
```

Use a genuinely free `STATUS_PORT`; the smoke import boots the app and can contend for HID. Automated checks use temporary state files and fake HTTP/child-process adapters—never the developer's approval file or real sidecar.

Live gate on macOS:
1. Start with sidecar executable unset and then set to a missing path; confirm CamControl startup and all non-Sony tabs continue.
2. Run the developer setup with the user-supplied SDK ZIP; verify health version/SDK version and managed start/stop without orphan processes.
3. Discover two cameras; approve one only; restart and prove only that ID auto-connects.
4. Power the approved camera off before app start, then power it on after the retry burst; prove dormant discovery reconnects it.
5. Exercise real pairing/setup/auth failure and ordinary camera-off failure; confirm distinct UI classification using captured response evidence.
6. Kill the owned sidecar and verify bounded restart; exhaust the budget and recover with **Retry Sony service**.
7. Re-run the remaining physical Sony gates: simultaneous two-camera operation, FX3 touch focus, and HDMI coexistence.

## Open approval questions

1. Approve **Approach A** and the separate `config/sony-cameras.json` approval store (rather than mutating `devices.yaml` on every Connect/Forget)?
2. Approve the conservative pairing scope: remember camera approval only, store no Sony access-auth credentials, and require camera-side setup plus explicit Retry when auth is needed?
3. Is the 60-second dormant probe (worst-case 75 seconds including connect) acceptable for a camera powered on long after startup, or should recovery target 30 seconds at the cost of more SDK discovery calls?

No product code should be implemented until AJ approves this design and the three choices above.

---

## Other workstreams folded in on the consolidation branch (2026-09-29)
The sections below are the pre-consolidation plan from the PR #2 / Sony dashboard / RS3 lines of work, kept verbatim (headings demoted).


### Active plan
Open a draft PR for the verified Sony multi-camera dashboard, then complete the remaining physical-camera smoke checks. Automated verification and browser-fixture evaluation passed; the feature remains incomplete and unmerged pending manual validation.

### Next steps

1. Open a draft PR from `feat/sony-dashboard`.
2. Verify two physical cameras simultaneously.
3. Verify FX3 touch focus.
4. Verify HDMI coexistence.

The final-gate live physical sidecar timed out. Automated verification still passed: `pnpm build`, smoke 89/89, and `git diff --check`; browser artifacts are under `docs/ai/runs/artifacts/sony-dashboard/`.

### Remaining DJI live-use checks

1. Run a controller-driven live pan/tilt test through FPS CamControl.
2. Verify preset `moveTo` and `recenter` against the physical RS3.
3. Verify safe stop on bridge SIGTERM and Ethernet yank.
4. Verify app/bridge recovery after reconnect and Pi reboot.
5. Complete 30-minute idle and representative-show soaks.

The deployed target is `dji-bridge.local` (`192.168.10.150`), user `worship`.
The active and enabled `dji-bridge` service uses `/home/worship/dji-bridge`, a
symlink to `/home/worship/fps-camcontrol/pi-bridge`; RS3 address
`34:D2:62:15:A5:47` is set in `/etc/default/dji-bridge`. FPS CamControl `cam4`
is enabled as DJI RS3.

After redeployment, the Pi service remained active and the app, RS3, and Switch
Pro controller were all live-connected.

The `websockets.server` type-import deprecation warning is non-blocking cleanup,
not a live-use gate.

### Post-hardware polish (not blockers)
- Web UI editor for DJI devices — `statusHtml()` only exposes VISCA fields today; DJI cameras are YAML-only. ~30 min to add `protocol`, `bridge.host`, `bridge.port`, `rollEnabled`.
- Activity-log rendering for `DJI-BRIDGE` protocol entries (enum accepted, default styling). Cosmetic.
- Sony PZ lens stub — Phase 3 step 14, skipped; would validate a third protocol. ~1 hr.
- Roll velocity from sticks — capability + protocol support exist, but no controller input maps to roll yet. Needs a chord + state-machine route.

### First-service config (before any live use of the VISCA/ATEM path)
- Set ATEM IP + confirm input IDs + DSK index via the web UI.
- Confirm V-BOT tilt direction on the actual unit (`cameraType: vbot`).
- Save shot-zone presets (LB + hold A/B/X/Y) per camera.

### Out of scope / parked
- CAN/PiCAN3 gimbal transport — retained as a fallback, superseded by the tested RS3 BLE path.
- USB-C gimbal control (unsupported on RS-series; use BLE primary or CAN fallback).
