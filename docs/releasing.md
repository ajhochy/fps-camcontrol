# Electron testing releases

This workflow publishes one GitHub prerelease with two separately identified Apple Silicon DMGs: manual CamControl and CamControl Tracking. The release label (for example `testing-2026.10.01`) is separate from the embedded app version, which remains `0.1.0`. It does not merge either draft PR or make a stable/latest release.

## Source and prerequisites

`.github/electron-release-sources.json` pins the exact source commit for each variant. The workflow checks out each commit independently from this repository and refuses a different HEAD or dirty source. Updating either source requires changing this manifest in the tracking PR and reviewing the resulting release diff. The manual app requires macOS 13 or newer; tracking requires macOS 14 or newer. The hosted job runs on GitHub's ARM64 `macos-15` runner, with Node 22.23.0, pnpm 11.1.2 and Python 3.11.

Configure these repository Actions secrets before a hosted release: `APPLE_CERTIFICATE_BASE64` (Developer ID Application `.p12`, base64), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, and `APPLE_APP_SPECIFIC_PASSWORD`. The team must be `56Q69NYP9H`; `APPLE_SIGNING_IDENTITY` must be the full SHA-1 fingerprint of the imported Developer ID certificate. Certificate rotation can update that fingerprint without changing the workflow. Credentials are checked in the plan job before either macOS build starts. Certificate and notary values are exposed only to their dedicated steps. The public certificate fingerprint also reaches the packaging script's embedded sign-only step. Dependency installation and source tests receive no Apple secrets. The certificate is imported into a temporary runner keychain; its previous search list is restored and the owned keychain deleted on success or failure. No local keychain or credential export is part of this workflow.

The tracking build stages the checksum-pinned Python/model runtime and installs the test browser before running source checks. Both variants run `node scripts/checks.cjs pr`, package with the pinned source's own script, and invoke the existing signer for a *new* final app and DMG. Apple's app and DMG submissions must both report `Accepted`; the signer must pass strict codesign, staple and Gatekeeper checks. The final mounted DMG must pass the variant's packaged runtime script. Only then is the DMG copied into an upload artifact with a public receipt. The tracking source's generated UI screenshots are locally excluded from its Git status check; no source file is changed or cleaned.

## Start a run

The workflow has a read-only `pull_request` validation job. No PR event builds, signs or publishes. To register the unmerged workflow, push a testing tag pointing at the tracking PR commit containing this workflow, such as `electron-testing-2026.10.01`. Tag pushes run the full release and publish when both builds pass. Once registered, `workflow_dispatch` accepts `version: testing-YYYY.MM.DD[.N]` and `qualification_only`. Qualification-only defaults to true and uploads the two validated GitHub Actions artifacts without creating a GitHub Release. Use a fresh label for every publication; existing tags, releases and assets are never overwritten. A failed tag-triggered attempt can be rerun after fixing its cause if no release was created.

The single publisher waits for both ARM64 build jobs, verifies their exact bytes and shared run provenance, creates one *draft* prerelease, uploads both DMGs plus `release-manifest.json` and `SHA256SUMS`, downloads those release assets and compares their hashes and sizes, then makes the prerelease visible with `--latest=false`. If any step fails before publication, inspect the draft release and resolve it explicitly before retrying. The manifest contains source commits, embedded version, minimum OS, public Apple acceptance IDs, checksums, byte sizes, and workflow/run provenance. It contains no local paths or credentials.

For an initial testing release made from the already signed local DMGs, record `local-build` provenance and the existing Apple delivery receipts explicitly; do not call it a hosted workflow build. Verify the downloaded public DMGs against published checksums after upload. A local publication does not demonstrate that this workflow runs successfully on GitHub.

## Remaining acceptance

Developer-host mounted-DMG runtime evidence is not a clean macOS or TCC check. Physical HID, Sony/ATEM/DJI rigs, real-person tracking accuracy, and separate 30-minute idle/active tracking soaks remain `NOT TESTED` until witnessed. Keep both PRs open for their own review and merge decisions.

---

# Local macOS installer delivery

The manual app is `com.ajhochhalter.fpscamcontrol`; the tracking app is
`com.ajhochhalter.fpscamcontrol.tracking`. Each variant has a separate artifact
directory, application name and mutable app home. The manual installer contains
no Python tracker, model or Track controls. Sony SDK/CameraWebApp is never bundled.

The scripts below build local installers. They do not publish GitHub releases,
deploy services, import certificates, alter Keychain search lists or accept Apple
agreements. Build from the reviewed commit with owned dependencies; Electron native
modules are rebuilt only in a separate staging directory, never in the Node test
installation. Complete the package/runtime tests before notarizing a candidate.

## Signing identity and private credentials

`scripts/sign-electron-manual.cjs` is variant-aware despite its historical name.
It validates the requested bundle ID and every Mach-O file, including extensionless
helpers and embedded Python binaries. All binaries must include arm64, and the
advertised minimum macOS version must be at least every arm64 binary's real
`LC_BUILD_VERSION`/`LC_VERSION_MIN_MACOSX` requirement.

The existing FPS certificate fingerprint is
`CF6C1EF1525E70E6E3324388A322938977779DB7`, for Developer ID Application team
`56Q69NYP9H`. Each use checks that it remains a valid existing Keychain identity.
Override `APPLE_SIGNING_IDENTITY` explicitly for rotation. A display name matching
different fingerprints is rejected; duplicate Keychain references to the same
fingerprint are harmless. No key/private certificate material is exported.

Authentication accepts an existing `APPLE_NOTARY_PROFILE` (and optional existing
`APPLE_NOTARY_KEYCHAIN` path), or the established Apple ID credentials:

- `APPLE_ID`
- `APPLE_TEAM_ID` (the expected team above)
- `APPLE_APP_SPECIFIC_PASSWORD`, with `APPLE_ID_PASSWORD` supported as the existing
  local release-loader alias

Variables can already be in the caller environment, or use
`--credentials-file /absolute/private/Apple.env`. This literal dotenv reader loads
only the named Apple fields; it never sources executable shell content or copies
unrelated provider credentials. It does not create or modify that private file.
Passwords pass to notarytool's secure standard-input prompt, never command-line
arguments or child environment. Credential-bearing child diagnostics are suppressed.
The signer reports Apple's known missing/expired-agreement HTTP 403 through fixed
text; only the account holder can resolve that agreement.

Read-only credential preflight (no upload):

```sh
node scripts/sign-electron-manual.cjs --check-credentials \
  --credentials-file /absolute/private/Apple.env
```

## Local signing and final notarization

The existing package hook remains compatible:

```sh
node scripts/sign-electron-manual.cjs --sign-only
```

For a reviewed manual candidate:

```sh
node scripts/sign-electron-manual.cjs --variant manual \
  --app '/absolute/build/FPS CamControl.app' \
  --credentials-file /absolute/private/Apple.env \
  --output-dir /absolute/new-delivery-directory
```

For tracking, select `--variant tracking` and its `FPS CamControl Tracking.app`.
The output directory must not already exist. The full delivery operation:

1. Checks Apple access without uploading, then validates/copies the selected app
   into an isolated output directory.
2. Signs nested Mach-O code inside-out, then containing bundles and the outer app,
   with Developer ID, hardened runtime and secure timestamps. Only Electron app
   bundles receive `com.apple.security.cs.allow-jit`; native addons, Python,
   crashpad and other helpers receive no Electron JIT/library-validation exception.
3. Verifies every signed target and the strict/deep outer signature.
4. Submits an app ZIP, records its SHA-256/submission ID, and requires Apple's
   explicit final `Accepted` result. Pending/Invalid/Rejected never count as pass.
5. Staples and validates the app, performs `spctl` execution assessment, and creates
   a **new final ZIP** containing the stapled app.
6. Creates a new drag-to-Applications DMG from that same stapled app, signs it,
   submits it separately, requires `Accepted`, staples/validates the DMG, and runs
   strict signature and `spctl --type open` assessment.
7. Retains Apple's completed JSON log for each matching accepted job, and writes
   exclusive, read-only JSON receipts containing actual submission IDs,
   final hashes/sizes, app identity/version/architecture/minimum OS and observed
   source commit/dirty state. Existing receipts and upload archives remain intact.

For an already-built DMG, `--dmg-only --dmg /absolute/installer.dmg` makes a private
copy, validates the embedded variant, its signature/team and existing app staple
through a read-only mount, then signs/notarizes/staples the new DMG copy. This mode
cannot compensate for an unstapled app inside an old image; use the full path above
to regenerate the image after app stapling.

The script has no publication step. Final delivery requires an artifact produced
from the committed reviewed source, followed by the independent artifact/runtime
gate. A dirty-build receipt is development evidence, not immutable commit provenance.

## Verification and evidence

```sh
node --test scripts/test-electron-signing.cjs
node scripts/electron-manual-artifact-evidence.cjs --variant manual \
  --app '/absolute/delivery/FPS CamControl.app' \
  --dmg '/absolute/delivery/FPS CamControl-0.1.0-arm64-notarized.dmg' \
  --source-receipt /absolute/build/build-provenance.json \
  --runtime-evidence /absolute/evidence/runtime.json \
  --signing-evidence /absolute/delivery/delivery.json
```

The evidence tool writes a new timestamped report; it never overwrites historical
`artifact.json` or failed runtime evidence. It inspects actual app/installer bytes,
all native minimum OS requirements, signatures, staples and Gatekeeper assessments.
Runtime evidence is accepted only when its recorded DMG hash matches this exact
installer. Source evidence is accepted only when its app.asar hash matches and its
commit is valid; an observed checkout HEAD alone is explicitly unverified build
provenance. The signing receipt must match the DMG hash to establish both actual
Apple acceptance IDs. Tests of mocked signing order do not satisfy those live gates.

A fresh HOME/minimal PATH on the build Mac is useful packaged-runtime evidence,
but is not a clean macOS installation, download-quarantine or physical TCC/HID test.
On a compatible clean Apple Silicon Mac: retain download quarantine, verify the
published SHA-256, open the DMG, drag the app to Applications, start offline, finish
or skip setup, save a benign setting and relaunch. Confirm the dashboard works
without Node/Python/pnpm/Homebrew/CLT or Sony software. Grant controller permissions
through macOS only when prompted and verify physical input under operator control.
Optional Sony operation requires the user's separately supplied licensed sidecar;
follow the bundled Sony setup guide. Test actual camera/gimbal stop, sleep/wake,
loss/recovery, and tracking overrides with an operator before live production.
