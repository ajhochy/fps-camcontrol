# ADR — stacked Electron foundation and tracking deliverables

Accepted by delegated manager handoff, 2026-09-30. Scope here: F0 + F2a only.

Baseline is PR36 `763122d5ef27097661773ccc16d4f704f950ea81`; main
`c9098d8ff4b771c369c56ca8a7bb1175bbfdb6f5` diverges at `57d5172`.
Integrate main's four-file MIT/license/docs delta without changing ancestry or losing
PR36 rigs and sandbox. Manager alone owns commits and the two draft PRs.

Manual foundation targets main; tracking/#23–35 + #50 starts from independently
verified foundation and targets that branch. Two immutable arm64 DMGs are required;
the feasibility probe is neither deliverable. No auto-close claims for human gates.

| Variant | Bundle ID | Future userData root | Future update feed |
|---|---|---|---|
| Manual | com.ajhochhalter.fpscamcontrol | ~/Library/Application Support/com.ajhochhalter.fpscamcontrol | manual/latest-mac.yml |
| Tracking | com.ajhochhalter.fpscamcontrol.tracking | ~/Library/Application Support/com.ajhochhalter.fpscamcontrol.tracking | tracking/latest-mac.yml |
| Non-shipping probe | com.ajhochhalter.fpscamcontrol.probe | test HOME only, separate .probe root | none |

Reuse existing Express/UI and one Electron-owned utilityProcess; renderer sandbox,
context isolation, no Node integration. This probe imports no production backend,
loads/enumerates native HID only, and never opens hardware. Its 60Hz synthetic idle
tick proves scheduling feasibility, not production controller-loop or physical timing.
Node and Electron native builds are in different dependency trees. Pin packaging
tools, hoist pnpm installs, ASAR-unpack native addons. No Sony SDK, CameraWebApp,
Python, tracker or personal config is included in this probe.

Retain default DJI gain **80** and per-instance 1..1000 knob unchanged. Physical
gain200 acceptance remains pending. No unrelated normalization/controller changes.

Signing: read-only reference to Rhythm's sign-and-notarize-mac.mjs and
signing-identity.mjs; use existing Developer ID Application identity on team
56Q69NYP9H without keychain changes/export. Local sign-only is allowed; no notary
upload here. Future signing must discover Mach-O by magic and sign inside-out,
runtime/timestamp, final notary Accepted only, staple app/DMG and rebuild ZIP after
stapling. APPLE_SIGNING_IDENTITY/TEAM_ID/ID/APP_SPECIFIC_PASSWORD remain private;
presence booleans only. Never copy restricted Rhythm entitlements or run its script
as-is. Probe's minimal JIT entitlement is not a production entitlement decision.

Future paths, auth, wizard, supervision, notices, updates, full production runtime,
tracking/Python/model and genuine clean OS/Gatekeeper/TCC/physical/tailnet gates
are NOT_RUN here. Empty HOME on this developer host is not a clean-machine claim.
