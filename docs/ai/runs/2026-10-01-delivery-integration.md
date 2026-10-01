---
date: 2026-10-01
repo: fps-camcontrol
branch: feat/electron-foundation
pr: null
issues: [40, 41, 42, 43, 44, 46, 47, 51]
status: in-progress
tags: [run, fps-camcontrol]
index: "[[fps-camcontrol]]"
---

# Two-installer delivery integration

## Scope and ownership

Exactly two new draft PRs: existing manual app to main, then tracking stacked on
the independently tested foundation commit. PR36's existing rigs/Sony/sandbox
work is inherited, not authored by this delivery run. The original checkout and
PR36 remain untouched. No merge, deployment, release publication, branch deletion
or worktree cleanup is authorized. Controller-customization drafts are preserved
but excluded from this work.

The two previous SDK sessions were inspected through their actual session API:
both finished with stop results, and session/status was empty. The old shipping
run produced a signed candidate but failed mounted startup after the entrypoint
changed concurrently. That failed candidate/evidence is retained. Active source
ownership is now explicit: one integration owner, one signing owner, root owning
repository workflow/docs/Git. Independent review may own only assigned new helpers.

## Files changed by integration root

- `scripts/run_ai_workflow.py`, `scripts/checks.cjs`, package scripts: executable
  repository workflow adapter and serialized real checks, replacing the invalid
  generic typecheck fallback. No implicit merge, branch reset or cleanup.
- `tests/security/desktop-session.spec.ts`: actual ephemeral HTTP/WebSocket
  session/host/origin/missing-secret regression. It initially failed on a forged
  `fps-session=undefined` WebSocket; integration added the missing-secret guard.
- `electron/production-lock.cjs`, `tests/electron/production-lock.spec.cjs`:
  OS-owned loopback listener keyed to canonical appData prevents the two app
  identities owning hardware concurrently. Collision fails closed; process death
  releases the kernel resource; no stale PID file or arbitrary process kill.
  Separate shell/backend leases keep the hardware boundary held while an old
  backend handles parent loss, even after the shell itself has already died.
  A separate Sony scope guards both native-child lifetime and the next backend's
  external-service health probe, preventing mis-adoption during crash cleanup.
- `.gitignore`: exclude release artifacts. Repository context docs updated for
  explicit startup, private loopback, resource roots, and current verification.

## Review-driven repairs

- A denied hardware-ownership lock still permitted Setup/Import to call backend
  startup: require ownership at the actual launch boundary and import boundary.
- A backend SIGKILL could orphan its managed Sony helper; add an owned guardian
  with parent-pipe loss handling and bounded force escalation, preserving adopted
  external services. Real packaged process evidence is required, not just mocks.
- `utilityProcess.kill()` is graceful SIGTERM, so resolving timeout immediately
  could release ownership while a blocked backend survived. Require actual exit
  confirmation and fail-closed force escalation on the current owned child.
- macOS default Electron data paths ignored a test HOME override. Derive explicit
  appData/userData before singleton/startup and test containment. The existing
  `~/Library/Application Support/fps-camcontrol` generic config was created by the
  prior packaging run at 10:23 local time; this attempt did not overwrite those
  defaults. No data was deleted. Future isolated launches use the supplied home.
- The mounted app's dashboard kept polling the old backend during normal teardown;
  switch to a local status page before stopping it. Do not hide network failures
  in the pre-fault-injection assertion.

## Checks and evidence boundaries

- Root: production-lock actual collision/release/killed-owner/backend-retention
  tests, 3/3 (new separate-backend contract captured failing before repair).
- Root: signing focused tests, 11/11; no real Apple upload in those synthetic tests.
- Root: workflow CLI status/run/help and Python adapter help exit 0; diff check.
  An accidental Node invocation of the Python adapter failed with SyntaxError;
  corrected interpreter invocation exited 0 (not an application defect).
- Integration checkpoint: full serial `checks.cjs pr` exited 0 before the final
  review repairs; rerun after those changes is required.
- Root independent `ai-workflow checks --level pr` caught an asynchronous fake
  shell assertion after the stopping-page fix (41/42 focused tests passed).
  It was reported for repair with the actual awaited shutdown boundary; this
  attempt was not a full gate pass. The final rerun remains required.
- Apple initially rejected authentication with required-agreement HTTP403. The
  account holder accepted the agreement; a later secure read-only preflight
  succeeded after propagation. Artifact Accepted/stapled evidence is separate.
- Historical probe timing failures remain unchanged; no timing fix or production
  soak pass is claimed. Fresh HOME is not clean OS/TCC/physical-hardware proof.
- No tart/utmctl/prlctl/vmrun CLI or UTM/Parallels/VMware app was found in the
  targeted local availability check. No genuine clean macOS VM was available to
  this run; no VM software was installed or real host network disabled.

## Independent foundation checkpoint — 19:49 UTC

- Root `ai-workflow checks --level pr` exited 0 after final production fixes:
  focused tests49/49, all existing schema/rig/profile/Sony suites, Pi tests,
  isolated smoke268/268, sandbox104/104, build, emitted page JS and diff.
- Root independently reran signing tests12/12. An extra invocation of the old
  `test-electron-foundation.cjs` failed its historical 30-minute probe-duration
  assertion because latest probe evidence is the preserved short diagnostic.
  That is not a production gate and no blind soak, test weakening or evidence
  overwrite followed; the original timing failure remains unresolved.
- Reviewed actual corrected mounted candidate receipt at
  `electron-manual-evidence/runtime-2026-10-01T19-44-46-301Z/runtime.json`:
  offline startup4657ms; resources/HID/security/import/persistence/single-instance,
  blocked utility, backend/main crash, simulated sleep and owned/adopted Sony
  lifecycle pass. Browser/page/network errors empty, including injected faults.
- Manual candidate is135487197bytes, SHA256
  `6855e936d3ea5307ffbe6306bdf8e7aa78284e1e8709f27f84754da14f1656e0`.
  Not the final installer: exact committed-source build, Apple Accepted/staples
  and final-byte runtime rerun remain required. Genuine clean OS/TCC and physical
  hardware checks remain explicitly pending.
- Remote main still `c9098d8ff4b771c369c56ca8a7bb1175bbfdb6f5`; neither requested
  delivery branch exists remotely at this checkpoint. Unrelated controller drafts
  remain excluded from staging.

## Next

Finalize actual mounted production DMG and independent baseline gates, record
artifact/commit provenance, and open the foundation draft. Only then create the
tracking branch and implement the frozen issue snapshot in the tracking handoff.
