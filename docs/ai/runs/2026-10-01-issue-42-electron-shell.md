---
date: 2026-10-01
repo: fps-camcontrol
branch: feat/electron-foundation
pr: null
issues: [42]
status: unverified
tags: [run, fps-camcontrol, electron]
index: "[[fps-camcontrol]]"
---

### 2026-10-01 — issue-42-electron-shell

- Files modified: `electron/main.cjs` adds the single-instance, sandboxed shell, allowlisted utility-process environment, protocol-1 readiness/shutdown supervision, bounded restart and owned-child quit cleanup; `electron/backend.cjs`, `electron/preload.cjs`, and `electron/status.html` provide the minimal backend entry, fixed IPC bridge, and local status/restart view; `package.json` adds `electron:dev`; `tests/electron/shell.spec.cjs` exercises fake Electron crash/restart and graceful cleanup seams.
- Checks run: initial `node -r ts-node/register --test tests/contract/issue-42.spec.ts` failed 0/6 because `electron/main.cjs` was absent. After implementation, the same contract passed 6/6; `node -r ts-node/register --test tests/contract/issue-42.spec.ts tests/electron/shell.spec.cjs` passed 10/10; `pnpm build` passed; `git diff --check` passed.
- Decisions made: The utility child receives only `CAMCONTROL_EMBEDDED`, app-home/resource paths, and `CAMCONTROL_NO_CONTROLLER` when the parent itself received it. Ready envelopes must exactly match #41 protocol 1 and the current child PID before loading the actual `127.0.0.1` port. UI failure text is fixed and never includes a child error, credential, or token.
- Deviations from spec: `ai-workflow checks` remains unavailable because the repository has no `scripts/run_ai_workflow.py`; the documented issue-level contract/build/focused shell checks were used. No packaging, signing, installer resources/defaults, import flow, Sony locator, controller redesign, remote/updater/tray behavior, or live configuration changes were added.
- Concerns: No real Electron runtime was launched. Even with `CAMCONTROL_NO_CONTROLLER=1`, a development launch would create/use the Electron app home and exercise the actual backend/config path, which is outside this no-live-config/hardware run. Consequently actual Electron utility IPC, browser load, crash restart, and orphan cleanup are unverified runtime gates; the fake-Electron lifecycle coverage is not a substitute. Existing dirty foundation changes were preserved; no commit, stage, push, PR, package, signing, or service action was performed.
