---
type: project
---

# Project State — fps-camcontrol

## Current focus
Packaging-first Electron delivery is underway on `feat/electron-foundation`.
The production shell and explicit backend lifecycle are integrated. Independent
review repairs and the actual mounted manual candidate runtime now pass. The
foundation is ready to freeze; committed-source rebuilding and Apple notarization
are separate remaining gates before final installer delivery.

## Active branch / PR
Branch: `feat/electron-foundation`, based on inherited PR36 HEAD
`763122d5ef27097661773ccc16d4f704f950ea81`. This foundation checkpoint records
independently verified production inputs before the final committed-source build.
No new draft PR or Apple artifact acceptance has been recorded yet.

## In progress
- One shared production/development shell, private HTTP/WS sessions, real port IPC,
  immutable resources, generic userData setup and consented whole-file import.
- Actual mounted-DMG runtime and owned helper/blocked-event-loop fault tests.
- Apple Developer ID signing and app/DMG notarization tooling. After account-holder
  acceptance and propagation of the required agreement, read-only authentication
  succeeds; actual artifact submission/Accepted results remain pending.
- Tracking remains preparation only. Current issue bodies, frozen protocol,
  permissive model and audited macOS-14-compatible runtime pins are in
  `docs/ai/runs/2026-10-01-tracking-implementation-handoff.md`.

## Risks / known issues
- No final notarized-DMG runtime, notary Accepted/staples, genuine clean OS/TCC, or
  physical controller/camera/gimbal acceptance yet. Developer-host isolated HOME
  testing must not be reported as clean-Mac proof.
- Historical probe soak failures are unchanged, not production-loop results and
  not a blocker to implementing packaging. Unrelated controller #3–6 drafts are
  preserved but excluded from packaging implementation.

## Test status
- `ai-workflow` now routes to the repository adapter and serial checks runner;
  no nonexistent `npm run typecheck` fallback.
- Independent root `ai-workflow checks --level pr` exit 0 after all production
  repairs: 49/49 focused tests, schema/rig/profile/Sony suites, Pi tests,
  smoke 268/268, sandbox 104/104, build, page-JS and diff. Signing tests 12/12.
- Actual candidate mounted-DMG runtime passed with no browser/page/network errors:
  `runs/electron-manual-evidence/runtime-2026-10-01T19-44-46-301Z/runtime.json`.
  Includes real managed-helper faults, paused recovery, import and persistence.
  Final source-committed/notarized artifact must rerun this exact gate.

## Next step
Commit the verified foundation, rebuild/sign/notarize it, and open its draft PR.
Branch tracking from that exact commit after manual build inputs are copied;
implement and test the second app, then open its stacked draft PR. Preserve PR36,
the original checkout, existing branches/worktrees and all failed evidence.
