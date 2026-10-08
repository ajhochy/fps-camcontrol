# Manager decision and AJ approval — 2026-10-01

AJ explicitly confirmed in this workflow: **“rhythm approvals are not working in this environment, I approve whatever”**, after disclosure of the HIGH-impact shared motion-curve change and the inconclusive packaged timer diagnosis. This records conversational approval; it does not claim the pending Rhythm approval record was changed or the approval service repaired.

## Controller change approved

- Worktree: `fps-electron-two-pr-plan`; branch: `feat/electron-foundation`; starting HEAD: `763122d5ef27097661773ccc16d4f704f950ea81`.
- Symbol: `applyCurve`, `src/visca/speedCurves.ts`, and its existing `ControlStateMachine.getEffectiveSpeed` caller. The stale GitNexus index reports HIGH, eight symbols, direct callers `getEffectiveSpeed` and smoke-test `speed`, with controller-loop process participation. Actual source/caller were inspected by the manager.
- Scope: validated finite bounded power/piecewise/normalized-sigmoid/linear curves; preserve default power exponent 1.5 and existing default control behavior; live operator settings for pan/tilt/zoom. Related issues #3–6 remain the assigned controller slice.
- Required checks remain: finite/sign/endpoints/monotonicity/default preservation, mapping/chord behavior, profile isolation/persistence, stop ordering, existing isolated smoke/sandbox, UI/accessibility/API evidence and independent verification.
- No watchdog relaxation, live hardware execution, deployment, or waiver of the independent failed timing gate is authorized by this decision.

## Additional controller disclosure and manager authorization

The controller owner subsequently disclosed `CameraSelector`, `src/model/cameraSelector.ts`: stale-index HIGH, 25 affected symbols, depth counts 4/6/15. Direct dependents include `controlStateMachine.ts`, its constructor/tick and `smokeTest.ts`; affected processes include controller-loop context/activity and main flows. The operational risk is selection/preview handoff and outgoing stops across configured cameras.

After receiving that disclosure, the manager authorizes the exact bounded change under AJ's explicit delegated decision authority and blanket approval: mapping-driven next/previous/index selection, stop-before-camera handoff, preserved index clamping and wired/unwired preview behavior, tests covering stopped old devices and preserved legacy defaults. This is a manager decision after disclosure, not a claim AJ personally reviewed this additional symbol.

For the remainder of the already assigned issues #3–6 slice, the manager authorizes changes to the declared controller/config/operator-store/API/UI files necessary to meet its existing acceptance contract. New impact findings must be recorded and mitigated with source/caller tracing and tests. This authorization does not cover scope expansion, hardware execution, deletion of user settings, weakened stop/watchdog protections, timing waiver, merge/deploy/release, or bypass of actual host/tool permissions. If a specialist's higher-priority rule cannot accept delegated manager authorization, it must return that exact rule and the missing authority once, rather than cycle through unproductive per-symbol redispatches.

## Bounded timing investigation approved

Two failed 30-minute measurements are retained unchanged. Diagnosis found timer callback gaps but no proven causal attribution; the synthetic idle probe is not the production controller loop. There will be no third blind soak or claimed causal fix.

The manager authorizes one diagnostic instrumentation slice: timestamped outlier attribution and bounded runtime/GC/resource telemetry in the probe only, plus a short diagnostic check. Preserve the acceptance thresholds, raw failed evidence, independent freshness-bounded receiver stop protections, and privacy. If evidence still cannot establish a cause, report that fact rather than continue an unbounded repair loop. A further full soak is not authorized by this instrumentation decision.

## Unchanged boundaries

The deliverable remains two independently verified Electron installers and two draft PRs, with no tracking in the foundation artifact and tracking in the stacked artifact. User approval is not test evidence. No merge, deploy, release publication, destructive cleanup, credentials in logs, or false clean-OS/hardware/Gatekeeper/notarization claims. Preserve the original checkout and PR #36.
