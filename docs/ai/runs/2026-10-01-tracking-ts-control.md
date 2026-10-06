---
type: run
status: unverified
---

# Tracking control, sessions and transport (#25–27)

- Branch: codex/electron-tracking from immutable manual foundation133ae8d9620665b1e87b799a765a619ccae06ebc. Manual committed-source installer and receipt were completed before branch switch; signer owns isolated notarization.
- Scope: new TypeScript tracking protocol/controller/client/manager/shared motion ledger, simulator/virtual helper and focused tests only. Root owns shared app/config/routes/control integration; Python owner implements the frozen wire. No live hardware or production config.
- Acceptance-contract: issue25/26/27 exact criterion texts captured from committed handoff snapshot;6+10+7 executable tests created first. `node --test -r ts-node/register/transpile-only tests/tracking/controller.spec.cjs tests/tracking/manager.spec.cjs` exits1,16 expected missing-implementation assertions. Protocol command separately exits1,7 expected missing-implementation assertions. No waived criteria.
- Contract refinements: shared physical-device command pacing, strict per-select UUID and increasing seq, genuine frame timestamp freshness500ms, stop uncapped, disconnect/rebind invalidate target, explicit Resume only for operator override, delayed observation simulation150/300/500ms. Physical rig gain/safety/real sleep and30minute human soaks remain outside this synthetic gate.
- Checks: RED captured; implementation and GREEN evidence pending. No release or Git mutations by this agent.

## Owned implementation and green evidence

- New files: src/tracking/{protocol,types,trackingController,motionLedger,trackingManager,trackingClient}.ts; src/testing/{trackingSim,virtualTrackingSidecar,trackingIntegrationTest}.ts; tests/tracking/{helpers,controller,manager,protocol}.spec.cjs (helpers.cjs); issue25/26/27 contracts. Root shared integration remains independently owned.
- `pnpm build` exit0. `node --test -r ts-node/register/transpile-only tests/tracking/controller.spec.cjs tests/tracking/manager.spec.cjs tests/tracking/protocol.spec.cjs`28/28 pass, covering23 original criteria plus shared50ms handoff, source250ms select gate, idempotent stop, no stale replay/failed-select success, and synchronous stop reentry. Manual/transport behavior is exercised on owned ephemeral ports only.
- `node -r ts-node/register/transpile-only src/testing/trackingIntegrationTest.ts` and compiled `node dist/testing/trackingIntegrationTest.js` exit0: actual bundledPython3.12 mock, strict authenticated handshake, complete backend-origin allowlist, real TS manager and VirtualDjiBridge command stream, manual override/resume and actual PythonSIGKILL -> uncapped stop/session invalidation/no replay. Fresh temporary HOME/minimalPATH/randomcwd; no frames are saved and no tokens printed. Satisfies Python issue29-c5 integration point.
- Pure controller uses filteredPD, image-right pan/image-up tilt, independent invert, hysteretic exactzero, age-dependent gain and400–700ms stale decay. Manager independently enforces stricter500ms genuine-frame deadline. Config default kp1.2/kd.12 chosen after unchanged synthetic criteria:150ms→5050ms settle,300ms→6850ms,500ms→18650ms; overshoot0 and postcrossingreversals0 for all; finalerrors .03385/.034575/.037025. Simulator models8fps,20Hz,1e-3 quantization,150ms first-order plant,30degrees/s velocity over60degree horizontalFOV. These are model assumptions, not measured real-rig gain.
- Initial kp.8 was safe but500ms settled28350ms and failed the stronger final10seconds-inside-deadzone test. Tuned gain rather than relaxing the metric. Root adopted1.2 schema default. Typecheck caught own RawData union and virtual verifyClient callback types; corrected, then build exit0.
- Manager exposes curated TrackingError400/404/409/429, stable source/session maps, active-camera binding, shared physical-device pacing, and no-resume boundaries. Source absence is a safe unavailable status; an explicit command against that absent binding returns409 instead of a false HTTP success.
- Required remaining gate: root composed app/safety/UI checks, final full repository gate and packaged inference/lifecycle. Physical motion/gain/real sleep and human30minute drills are not represented as passes.
