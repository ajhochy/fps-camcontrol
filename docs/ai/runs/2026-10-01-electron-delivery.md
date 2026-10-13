# Electron delivery — 2026-10-01

## Delivery state

Both signed/notarized/stapled installers and both draft PRs are delivered for
smoke testing. Exact final-byte mounted runtime and independent review pass.
This record is not physical, clean-OS or production-operation approval.

## Draft PRs and provenance

1. Manual foundation: https://github.com/ajhochy/fps-camcontrol/pull/57 → main.
   Built source `133ae8d9620665b1e87b799a765a619ccae06ebc`.
2. Tracking: https://github.com/ajhochy/fps-camcontrol/pull/58 → `feat/electron-foundation`.
   Built source `3711a9e6475633a6cf889850ba3a23843a12c450`.

The foundation includes inherited PR36 rigs/Sony/sandbox work, not all authored
in this delivery. PR36 is unchanged. No merge, release publication, deployment,
force push, branch/worktree deletion, live service change or hardware operation.
The original checkout and three unrelated controller-customization drafts are
preserved. Tracking's later evidence/test-only commit does not change packaged
production files; built source is distinguished from eventual PR head.

## Installers

Both are Apple Silicon/arm64, version0.1.0. Only the final notarized paths below
are deliverables; prior probes/candidates are not substitutes.

### Manual — complete

- ID `com.ajhochhalter.fpscamcontrol`; macOS13.0+.
- Path: `release/manual-delivery-133ae8d/2026-10-01-final/FPS CamControl-0.1.0-arm64-notarized.dmg` under this worktree.
- Bytes:172838600.
- SHA256:`da02312a0e65e9bfd440090cf6f7cbc0b29764a5f71685182922806855c98f11`.
- Apple app job:`bc481bd1-4a19-4400-a9d1-6c83e0a74d63`; DMG job:`4dc7579f-483f-4d66-a50f-c09345dde698`; both Accepted, matching logs issues:null.
- Strict nested signatures, app/DMG staple validation and Gatekeeper pass.
- Final mounted report: `electron-manual-evidence/runtime-2026-10-01T20-00-00-684Z/runtime.json`; startup4653ms, all UI error arrays empty.

### Tracking — complete

- ID `com.ajhochhalter.fpscamcontrol.tracking`; macOS14.0+.
- Final native inventory:76 signed ARM64 binaries; highest native minimum14.0.
- Path: `release/tracking-delivery-3711a9e/2026-10-01-final/FPS CamControl Tracking-0.1.0-arm64-notarized.dmg` under this worktree.
- Bytes:288543586.
- SHA256:`5c021b66d2433df630677c4cab95fc3019e5617e134afc5dd094f967e4c81652`.
- Apple app job:`b8fbf315-f955-4154-bcbb-420eb0c48ed4`; DMG job:`b908430e-b90f-4f6d-9cf5-996af25742a1`; both Accepted, matching logs issues:null.
- Strict nested signatures, app/DMG staple validation and Gatekeeper pass.
- Final report: `electron-tracking-evidence/runtime-2026-10-01T20-47-24-065Z/runtime.json`; startup4018ms. Actual Track click, bundled live inference, explicit motion stops0.315/1.956ms before250ms watchdog, and lifecycle/recovery assertions pass.
- No page JS or unexpected HTTP/console/transport errors. The raw record retains one Sony busy503 with Retry-After1 during restart and one preview GET disconnect against the deliberately killed backend; both are narrowly classified and preview recovery is asserted. This is not a zero-console-errors claim.
- Candidate app ASAR SHA256:`12d6fbb8c529c39a1ddf7c8f87f85c45fb3bd01b5c82e5990ebcb444d47fe6b9`.

## Verification matrix

| Gate | Manual | Tracking |
| --- | --- | --- |
| Full backend/dashboard/native HID, safe generic settings, offline first launch | PASS | PASS |
| App identity/resources/native architecture/minimum OS | PASS,17 native binaries,13.0 | PASS,76 native binaries,14.0 |
| Repository build/contracts/rigs/Sony/Pi, smoke268, sandbox104 | PASS | PASS,122 focused tests; latest harness regressions5/5 |
| Mounted fresh HOME/minimal PATH/random cwd | PASS exact final DMG | PASS exact final DMG |
| Persistence/import/auth/sandbox/single-instance | PASS | Inherited foundation plus tracking sandbox/auth/isolation PASS |
| Owned quit/crash/paused recovery, simulated sleep/no replay | PASS | PASS exact final DMG, tracking initially idle |
| Real bundled network-denied model execution | Not included | PASS,2 inputs,finite,input-dependent |
| Real TS↔Python motion/override/crash with virtual gimbal | Not included | PASS; physical hardware not used |
| UI modes/overlay/stop/resume, six viewports | Existing UI preserved | PASS9 checks with fixture; final installed Track click also PASS |
| Apple app+DMG Accepted/stapled/Gatekeeper | PASS | PASS |
| Genuine clean OS/TCC/download quarantine, real sleep, physical hardware | MANUAL_PENDING | MANUAL_PENDING |
| Physical latency/gain/direction, identity reliability,30-minute idle+active soaks | Not tracking scope | MANUAL_PENDING |

Model: Apache-2.0 OpenCV Zoo YOLOX-s, exact SHA256
`c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063`.
Pinned relocatable CPython, wheels and all component notices are bundled outside
ASAR. No Sony SDK/CameraWebApp, system Python/Node/pip, or first-run model download.
Generated images have zero people; inference execution is not accuracy proof.

## Clean-Mac smoke instructions — still to be witnessed

1. Use a genuinely clean Apple Silicon Mac: macOS13+ for manual,14+ for
   tracking; no existing app, Node, Python, package manager or developer tools.
   Keep internet off for first launch. Record OS/device and Gatekeeper behavior.
2. Transfer the final DMG through your normal download route so quarantine is
   retained. Open it normally and drag its named app to Applications. Launch
   without stripping quarantine or bypassing security. Record any macOS prompt;
   never treat a failed launch as a passed test.
3. With no gear configured, open the dashboard and check honest not-configured
   states. Manual must have no Track mode. Tracking starts disabled and Focus
   remains the default. No Python or Node installation prompts should appear.
4. In Setup/Import, first cancel; then try invalid YAML; then explicitly import
   a backed-up generic test configuration and consent to replacement. Confirm
   invalid/cancel leave settings intact, backup exists, and relaunch preserves
   approved changes. Each app has a separate Application Support directory.
5. Quit one app before opening the other. A second production owner must be
   rejected. Exercise real quit/relaunch and sleep/wake: controls must stay
   stopped until explicit restart, never replaying a prior target.
6. Optional Sony: obtain your own licensed CameraWebApp/SDK, follow
   `docs/sony-sidecar-setup.md`, configure its user-supplied endpoint/executable,
   discover and explicitly approve your camera. Import deliberately disables
   Sony and discards executable/approval paths. No license is accepted for you.
   Use an already-built compatible Sony service for this clean-machine smoke;
   building Sony's optional service itself may require developer tools and is
   outside the dependency-free core installer. Core offline launch must work
   without Sony or Tailscale.
7. Only in a cleared, supervised rig area, validate HID/TCC, manual mappings,
   emergency stop, device watchdog and bridge/BLE loss. For tracking, configure
   the source inventory mapping, verify direction/gain at low speed, then test
   click-to-track, same-camera stick override, explicit Resume, target/video
   loss and no replay after disconnect/crash/sleep. Follow the detailed physical
   record and both30-minute soaks in `2026-10-01-tracking-live-verification.md`.

Do not use experimental tracking unattended or for a safety-critical angle.
Developer-host isolation and virtual hardware cannot certify physical stopping.

## Scoped adaptations and issue closure

Tracking comments live in shipped generic `resources/defaults/devices.yaml`,
not the protected operator configuration (#23). Tracking status is projected
from the authoritative manager into `/api/status` rather than duplicated as an
`AppState` field (#26). Their user-visible behavior is implemented and tested;
the literal file/field adaptations remain explicit, with no closing keywords.
Authenticated sidecar development also intentionally requires credentials and
parent supervision, rather than the old unauthenticated CLI example (#29).
#34/#35 physical acceptance, broader Electron human gates, controller3–6,
remote control, auto-update and unrelated issues remain open/out of scope.
