# Sony sidecar setup — 2026-08-13

## Scope

Slice 1 only: developer-local setup boundary in `scripts/setup-sony-sidecar.sh` and `docs/sony-sidecar-setup.md`. No runtime, config, store, production TypeScript, test, package, dashboard, `current-plan`, or `project-state` changes.

## Acceptance contract

Contract: `docs/ai/contracts/task-sony-sidecar-setup.json`.

The first contract run failed before implementation as required:

```text
AssertionError: setup script is missing
```

Four setup-boundary criteria are exercised by an isolated fake checkout: it asserts the explicit ZIP passed to `crsdk install`, creates the expected macOS binary only during fake `crsdk build`, verifies the printed exact path, and rejects a missing ZIP. Interactive-license and documentation criteria remain manual because they require a terminal/operator attestation or content review.

## Validation

| Check | Result |
| --- | --- |
| Isolated acceptance contract | PASS |
| `bash -n scripts/setup-sony-sidecar.sh` | PASS |
| `git diff --check` | PASS |
| Supplied checkout/ZIP validation with interactive reply `N` | PASS; both inputs and `./crsdk` validated, then exited before invoking `crsdk` |

The supplied `/Users/ajhochhalter/Documents/alpha-sdk-api-test` checkout already contains Sony CLI license-marker support (`shared/.license-accepted`), but this run deliberately did not inspect/use it or accept terms for AJ. Therefore it did **not** invoke install/build against that checkout or start any sidecar.

## Manual verification targets

- Review the interactive prompt and explicit `SONY_LICENSE_ACCEPTED=1` / `--accept-sony-license` opt-ins; neither silently accepts Sony terms.
- After the operator has accepted Sony's EULA, run the documented command with the supplied checkout and ZIP; confirm `./crsdk install --zip`, `./crsdk build`, and the reported macOS `api/server/build/CameraWebApp` executable.
- Launch it temporarily with `--port 8181`, confirm `GET /api/server/status`, then use `POST /api/server/shutdown`; confirm no persistent process remains.
- Review `docs/sony-sidecar-setup.md` for developer/runtime separation, non-redistribution, official links, loopback warning, endpoints, environment variables, and no-credential-persistence statement.

## Risk

The helper follows the current `alpha-sdk-api` documented binary layout. An upstream layout change will fail safely after build because the expected executable is missing; update the helper only after verifying the new upstream layout.
