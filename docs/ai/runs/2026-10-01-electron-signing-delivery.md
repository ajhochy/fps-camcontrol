---
type: run
status: unverified
date: 2026-10-01
---

# Electron signing and notarization delivery

- Scope: signing helpers/tests, artifact evidence and release documentation in the
  assigned `fps-electron-two-pr-plan` worktree. Original checkout, existing raw
  probe/runtime evidence and unrelated developer services are preserved.
- Read-only references: Rhythm `apps/electron/scripts/sign-and-notarize-mac.mjs`
  and `signing-identity.mjs`; its release docs; existing Statement Automator
  `apps/web/scripts/sign.cjs` and `notarize.cjs` to identify the established local
  credential alias. No foreign release script was run.
- Files modified: `scripts/sign-electron-manual.cjs` (variant-aware safe signing,
  app+DMG notarization and final archives), `scripts/electron-signing-support.cjs`
  (private runner, literal Apple-only loader, native inventory),
  `scripts/test-electron-signing.cjs` (regressions),
  `scripts/electron-manual-artifact-evidence.cjs` (replace stale hardcoded source
  and runtime facts with hash-matched actual evidence), `docs/releasing.md`.
- Identity discovery: several valid Developer ID certificates share the same name.
  Existing FPS candidate's extracted **public** certificate has fingerprint
  `CF6C1EF1525E70E6E3324388A322938977779DB7`, team `56Q69NYP9H`, expires March 24,
  2031. New signing validates this explicit existing fingerprint; ambiguous names
  fail. No private key/certificate export or Keychain search-list mutation occurred.
- Credentials: current environment and Rhythm's dotenv contain none of the required
  Apple fields; that was not treated as proof of unavailability. The established
  local Statement Automator developer dotenv contains Apple ID/team and the
  supported `APPLE_ID_PASSWORD` alias. Presence/provenance only was reported. Only
  Apple fields were loaded internally; password went through secure stdin, absent
  from command arguments and child environment. No keychain-profile creation.
- Apple live preflight: read-only `notarytool history` reached Apple and returned
  HTTP 403: required legal agreement missing/expired. After the user reported
  agreement acceptance, one authorized retry returned the same specific 403.
  After a later single root-authorized propagation check, read-only Apple notary
  authentication **succeeded** with the same supported credential source. The
  agreement blocker is resolved. No agreement was accepted by automation; no
  notarization upload yet while the foundation candidate is being repaired.
- Checks: JavaScript syntax, signing regressions **12/12**, and owned diff whitespace
  pass. Initial symlink fixture
  exposed `/tmp` versus `/private/tmp` canonical-root mismatch; comparing real paths
  fixed the containment check without weakening escape rejection. Native app-level
  verification awaits the foundation owner's new package; the prior artifact had
  foreign Darwin-x64/Linux/Windows prebuilds and was reported for staging repair.
- Decisions: sign-only remains the existing packaging hook; notarization copies to
  a new evidence directory, requires two actual Accepted results plus matching Apple
  completed JSON logs, staples app before
  final ZIP/DMG creation, then staples the DMG. Least entitlement is Electron JIT
  only; full arm64/minimum-OS inventory blocks inaccurate installer metadata. The
  release runbook records these choices and clean-machine limits.
- Remaining gates: actual final app native inventory/signature/runtime, Apple
  acceptance/staples/Gatekeeper, exact committed-source receipts, independent
  verification, and separate tracking variant. Genuine clean OS/TCC/hardware
  checks are not represented by developer-host tests. Root owns final project-state
  update and PR/commit operations; this task performs neither.
