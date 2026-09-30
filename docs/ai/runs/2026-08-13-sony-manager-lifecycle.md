date: 2026-08-13
repo: fps-camcontrol
branch: feat/sony-dashboard
pr: #2
issues: sony-manager-lifecycle
status: READY_FOR_VERIFICATION

## Contract
- `docs/ai/contracts/sony-manager-lifecycle.json`
- Phase 0 failing evidence: `pnpm exec ts-node src/testing/sonyManagerTest.ts` failed with `SonyManager must be exported` before implementation.
- Final contract: 12 criteria, exercised by 103 named assertions in `src/testing/sonyManagerTest.ts`. Every check name is prefixed with its criterion id, the suite asserts all 12 ids are covered and that no name repeats, and the printed total is the counted length of that list.

## Files changed
- `src/sony/sonyManager.ts`
- `src/testing/sonyManagerTest.ts`
- `docs/ai/contracts/sony-manager-lifecycle.json`
- `docs/ai/runs/2026-08-13-sony-manager-lifecycle.md`

## Checks run
- `pnpm build` — pass.
- `pnpm exec ts-node src/testing/sonyManagerTest.ts` — pass, 103 checks across 12 criteria; run twice with identical output, and 10 consecutive runs during triage were identical.
- `git diff --check` — pass.

## False green (repair attempt 1)

The first READY claim was not reproducible. Independent validation failed with
`TypeError: Cannot read properties of undefined (reading 'state')` at the discovery
assertion, and the failure was intermittent: 2 of 8 runs failed, 6 passed.

Root cause (test-harness defect): the harness settled background work by awaiting a
fixed number of `setImmediate` ticks. `start()` chains `store.load()` — real
filesystem I/O completing on the libuv thread pool — so two ticks were sometimes not
enough and `getStatus().cameras` was still empty. It was a race, not a product bug.

Two further false-green mechanisms were found in the same suite:

1. The "26 checks passed" total was a hardcoded string, not a count. Nothing tied it
   to the assertions actually executed, and nothing tied assertions to criteria.
2. A stalled `await` drains the event loop and exits Node with code 0 and no output,
   so a hung suite read as a pass. The rewritten suite fails on that path via a
   `process.on('exit')` completion guard that reports the last completed check.

Auditing the implementation against all 12 criteria found approved requirements that
were absent or wrong, not merely untested:

- `stop()` had no shutdown/TERM/KILL deadlines: it issued one shutdown request and
  killed only if that request threw. No graceful wait, no `SIGKILL` fallback.
- Readiness failure killed the child while its own `exit` handler was still armed, so
  a single failure could schedule two restarts.
- Restart backoff had no jitter, no five-attempt-per-five-minute outage window, and no
  budget reset after a healthy run.
- Discovery ran at a flat 60 s. The approved 2/5/10/20/30 s burst was missing, as was
  the fresh burst on reappearance.
- `connect()` computed `approved: automatic || !!camera?.approved || !automatic`, which
  is always true — an automatic reconnect invented approval.
- `forget()` did not cancel scheduled or queued lifecycle work.
- Upstream proxy paths were invented (`/properties`, `/liveview`, `/touch`) instead of
  the paths already proven in `statusServer.ts`.
- No HTTP request carried a timeout, so a hung sidecar hung the manager.
- The managed launch checked existence but not the executable bit.
- Errors carried raw upstream bodies into camera status messages.

## Fixes

- Settling is no longer guessed. `SonyManager.whenIdle()` awaits the manager's own
  tracked background tasks, so the harness awaits real work — filesystem I/O included.
  A virtual clock owns all timers; the suite uses no real timer, process, or socket.
- `stop()` is idempotent and follows the approved ladder: `POST /api/server/shutdown`
  (2 s budget), wait 3 s, `SIGTERM`, wait 2 s, `SIGKILL` — owned children only. An
  adopted external server receives no shutdown request and no signal.
- Restart budget: 1/2/4/8/15 s with ±20% jitter, five attempts per five-minute outage,
  `crashed` after the cap until `retryService()`, and a reset after a healthy run.
- Discovery: one shared, cancellable timer for all pending cameras, bursting at
  2/5/10/20/30 s then 60 s dormant, with reappearance restarting the burst.
- Only an explicit successful `connect()` persists approval; an automatic connect
  against an unapproved camera is refused outright.
- Upstream paths now match the proven sidecar API: `/properties/all`,
  `/properties/{name}`, `/live-view/start`, `/live-view/frame` (binary), and
  `/actions/touch`. Camera IDs are encoded with literal colons preserved.
- Every request carries a timeout: health 1.5 s, connect 30 s, reads 5 s, frames 3 s,
  shutdown 2 s. Failures are curated (`SonyUpstreamError`) and never carry upstream
  bodies, headers, or URLs into status.
- Managed launch requires a loopback URL plus an absolute, regular, executable file;
  child pipes are drained and never retained.

## Evidence that the checks are real

The suite was mutation-tested against the manager. Each mutation was applied alone and
reverted afterwards; all of these were caught by a named assertion:

wrong properties path; missing `SIGKILL` escalation; discovery burst removed; automatic
connect persisting approval; executable-permission check removed; restart jitter
removed; read coalescing removed; raw upstream body leaked into a message; unbounded
restart attempts; wrong graceful-shutdown deadline; colons percent-encoded upstream;
health-probe timeout widened; loopback guard removed; `forget()` leaving the approval
in memory.

Two mutations are equivalent mutants and are recorded rather than papered over:

- Forcing the "healthy for five minutes" branch off is unobservable, because the outage
  window and the healthy-reset window are both five minutes, so the outage rule already
  resets the budget at the same instant. The observable outcome — the budget reopens
  after a long healthy run — is asserted.
- Dropping the `owned` half of the shutdown guard is unobservable, because `child` is
  only ever set by a launch this manager performed. The `owned` flag stays as defence
  in depth, and c3 asserts an adopted server is never spawned, signalled, or shut down.

## Notes
- Public surface: `SonyManager`, `SonyRetryableError`, `SonyUpstreamError`,
  `SonyRuntimeConfig`, `SonyManagerDependencies`, `SonyStatus`, `SonyFrame`.
- Injected boundaries: fetch, spawn, clock, timers, random, abort signals, pairing codes.
- Pairing codes are deliberately empty unless injected by a pinned sidecar contract
  probe. Physical sidecar/camera checks remain verification-gate work.
- `src/index.ts` and `src/ui/statusServer.ts` are untouched: wiring is a later slice.
  Nothing outside `src/sony/` imports the manager yet.
