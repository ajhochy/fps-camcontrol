# CamControl development handoff

## Published work and checkout

Current combined Studio/framing work is published as draft [PR #91](https://github.com/ajhochy/fps-camcontrol/pull/91), branch `feat/combined-studio-framing`, observed head `ce2a951274b4ef978c03e2e1a59bc77b00d14670`. Another owner rebased it and merged PR #60 during this preservation run; this manager performed neither action. It now contains the latest integration, deployed iPhone assets, and desktop/iPad Hold this framing. The handoff itself is on separate branch `docs/camcontrol-preservation-handoff`, stacked on PR #91, to avoid pushing over another owner's rewritten branch. Check out an isolated development copy, not the live rig directory:

```sh
git clone --branch feat/combined-studio-framing https://github.com/ajhochy/fps-camcontrol.git <new-development-directory>
cd <new-development-directory>
git rev-parse HEAD
git merge-base --is-ancestor ce2a951274b4ef978c03e2e1a59bc77b00d14670 HEAD
```

Confirm the checked-out branch/commit against PR #91 before proceeding. The manager owns commits, pushes, PR #91 updates and inserts actual verifier results; do not treat this handoff as approval to publish, merge or deploy.

## Other preserved/published work (separate; do not merge by copying)

- Draft [PR #90](https://github.com/ajhochy/fps-camcontrol/pull/90), branch `feat/streaming-s1-media-proof`, tested product commit `f708df369cbaf8ab2e0c66fe1a00c426ffa47007`, is separately based on `aea1f13`. Its two recovered synthetic MP4 fixtures (13,976 bytes total) are included in this preservation update. Check the PR publication receipt for the final fixture/docs commit. Do not combine it with PR #91.
- Integration `integration/combine-open-prs` at `1c94e68b95fc134aead338ae9e1dce9b8c154f9b` was externally merged in PR #60 at `ce98b2d684ea31a4b8adda21d2fd1ee82b5f485b` during this run. It contributes zoom/transition and remote-switch persistence across 23 paths since `aea1f13`; phone bytes match PR #91. No local merge/rebase/force-push/deployment was performed by this manager. The rewritten PR #91 already contains it, rather than requiring another merge.
- Published remote `feat/ipad-remote-touch-redesign` (`fa389cb`) is a docs-only source for merged PR #62. Remote `codex/electron-tracking` (`237c54d`) is evidence-only, associated with open #58. Retain as published provenance; do not overwrite current docs with those historical snapshots.
- All other original feature remotes are ancestors of integration except documented metadata-only exceptions. The remaining stash and reflog-only snapshots are accounted for in the dated preservation inventory; historical code is not to be replayed.
- Separate branch `preserve/decklink-sdk16-checkpoint` preserves the 53-file stash from base `3f719b0`, targeting integration; its publication receipt provides the draft URL/SHA. The stash is retained unchanged. Script and SDK bytes are preserved, not fixed or safe to run. No generated media matrix/hour-long media is included.

## Target environment and prerequisites

Target deployment is an Apple-Silicon MacStudio with macOS 14+ for tracking; manual-only installation supports macOS 13+. These are documented target requirements, not a measurement of the current host or a verified rig. Target machine OS, driver and runtime versions were not queried. The host development environment has been observed with Node `22.23.0` and pnpm `11.1.2`; pnpm is pinned by `packageManager`, no `engines` minimum is declared, and Node 22 is a tested development baseline, not a confirmed target runtime. The Pi BLE bridge requires Python >=3.10.

The framing browser test requires Google Chrome at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (hardcoded executable), in addition to locked Playwright dependencies. A fresh Mac without that executable cannot reproduce the browser gate unchanged. Tracking inference separately needs the pinned `dist/tracking-runtime` Python/model staging; no download or installed-app inference qualification was performed here.

Sony SDK/CameraWebApp is user-supplied. Existing historical Desktop Video 14.2 versus SDK 16 incompatibility remains blocked under issue #63; preview-only FFmpeg is not a streaming-capable runtime. No driver-install, deployment, camera-motion, recording or live-service commands are authorized by this handoff.

## Local configuration and secret handling

- Never copy `.env`, operator configs, PINs, API/signing credentials, or OS-stored secrets into Git, another checkout, or evidence. No secret values belong in this document.
- Sony approval/config is local (`config/sony-cameras.json`); remote PIN is configured in local devices configuration. PR #60 additionally persists the switch in `config/remote-control.json` (ignored on that branch). CLI target history identifies `~/Developer/fps-camcontrol-live` and launchd `com.fpscamcontrol.app`: do not alter either for this development checkout. Electron user data is `~/Library/Application Support/FPS CamControl/` or `~/Library/Application Support/FPS CamControl Tracking/`, with `config/` beneath it. Signing/API credentials stay in OS/local secret stores outside Git; `.env` is local only.
- Tracked CLI config files are examples and must not be treated as an automatic live configuration. `sandbox` runtime config is isolated test material. Do not point an isolated check at the operator's config or live user-data directory.
- The retained ignored root data, generated outputs and private recovery archive are not product source; details and exclusions are in `docs/ai/runs/2026-10-13-preservation-inventory.md`.

## Safe development checks

In the isolated checkout, after verifying it is not the live directory and dependencies resolve:

```sh
pnpm install --frozen-lockfile
pnpm build
node scripts/check-page-js.cjs
```

Run focused tests only with disposable test configuration, isolated user-data and the documented test ports free. `CAMCONTROL_NO_CONTROLLER=1` prevents real controller access but does **not** by itself prevent normal startup from reading configuration or reaching network devices. Do not run `pnpm start`, `pnpm dev`, or an unisolated smoke test on a configured rig.

Safe focused checks used here (no capture or recording):

```sh
CAMCONTROL_NO_CONTROLLER=1 node --test --test-concurrency=1 -r ts-node/register/transpile-only tests/security/desktop-session.spec.ts tests/security/tracking-frame-access.spec.ts tests/tracking/controller.spec.cjs tests/tracking/combined-studio-framing.test.cjs tests/tracking/keep-this-framing.test.cjs
# On the separate streaming branch only:
CAMCONTROL_NO_CONTROLLER=1 node --test --test-concurrency=1 -r ts-node/register/transpile-only tests/broadcast/ffmpegArgs.spec.ts tests/broadcast/tsRelay.spec.ts
```

Both builds and primary page parsing passed; focused primary 32/32 and broadcast 3/3 passed. Contracts failed 1/23; manager suite failed and timed out. These are development checks, not full-suite acceptance. Exact failed commands, skipped gates and current-source identities are in [verification receipt](ai/runs/2026-10-13-safe-verification.md). Recovery fixtures are now present, but recovery/media/soak checks were not rerun.

After the external rewrite, a fresh independent re-gate at **`ce2a951`** also passed build, page parsing and **32/32** serialized focused tests without skips; source hashes were unchanged across execution. The broad failures above are earlier-head evidence and remain unresolved, not fresh pass/fail claims for the rewritten head. The docs-only publication commit will retain this tested product source unchanged.

## Delivered behavior and limits

PR #91 carries Sony/tracking integration, rig/remote/safety and Slides/Clear focus behavior, plus desktop/iPad Hold this framing. The iPhone assets do not add phone Hold. No automatic tracking zoom is included. After the external rewrite, PR #91 also inherits PR #60's zoom/transition and remote-switch persistence; those features are not authored by this preservation run. Program streaming/media proof remains separate in PR #90. DeckLink SDK 16 checkpoint remains a separate blocked draft. None of this handoff establishes physical camera, tracking, safety, Safari, capture, packaged-app or clean-Mac qualification.

## Outstanding operator qualification (manual, later)

After explicit operator authorization and a reviewed safety plan: off-center framing/no-jump; direction and gain calibration; override/dead-man/emergency-stop and idle/active soaks; Safari devices; HID/TCC and Sony setup; ATEM; captured driver/format/audio; and clean-Mac packaged acceptance. These checks are not authorized or claimed complete here. Keep the work development-only until independently reviewed results and operator sign-off.
