# Electron probe timing diagnosis — 2026-10-01

## Disposition and ownership

**BLOCKED — unchanged timing gate fails; causal evidence is inconclusive; two-attempt repair/evidence cap exhausted.** This independent slice diagnoses existing data only. It does not authorize another measurement, change acceptance, or declare foundation ready. Manager must independently decide any bounded continuation while preserving the red gate; independent controller work may continue without foundation-readiness claims.

Root: `/Users/ajhochhalter/.local/share/opencode/worktree/ec2e0fe3fdd54c2e9ab53bfa4cc75c91e40568ed/fps-electron-two-pr-plan`; branch `feat/electron-foundation`; HEAD `763122d5ef27097661773ccc16d4f704f950ea81` (confirmed before replay). Previous coding owner `4753b8fe-549d-4d44-a6cd-a0563d63ae18` finished BLOCKED; no probe was launched here. This slice writes only this report. Concurrent controller ownership remains disjoint; its working source, tests, build and sandbox were not modified or executed. Production safety references below use immutable `git show HEAD:...`, not concurrent controller working files. Tracker publication remains host-owned.

Read existing run note `2026-09-30-electron-foundation-probe.md:59–113`, context pack, foundation contract, probe main/utility, runner, packaging/config and assertion code, and preserved dist JSON. GitNexus registry points to canonical checkout at `d3cb437`, not this worktree; exact local source and immutable HEAD reads take precedence. No peer, GitHub mutation, commit, push, branch mutation, release, deletion, process kill, priority adjustment or keychain change; no build, packaging, sandbox, hardware access or third soak. Terminal tooling may retain diagnostic stdout; no full OS logs are copied into this report.

## Reproduce: existing evidence only

Executed in the exact root:

```sh
node scripts/test-electron-foundation.cjs dist/electron-probe/idle-evidence-1790868869293.json
```

Exit 1, `AssertionError [ERR_ASSERTION]: 4 !== 0`, at `scripts/test-electron-foundation.cjs:40:8` (`e.utility.timing.missed150`). Replay host Node is **22.23.0**; measured embedded utility Node is **24.21.0**. The former merely parses retained JSON/asserts and is not the runtime that recorded the misses. Existing assertion order reaches native/renderer checks before timing; the duration/max and later lifecycle assertions are not executed after line 40 fails. Those facts were separately inspected in the JSON, not falsely described as a complete passing assertion run.

Expected contract: zero callback gaps ≥150ms, zero ≥250ms, max <150ms, and actual duration ≥1800000ms. Contract/thresholds/waiver remain unchanged. Both preserved measurements violate it:

| Existing `dist/electron-probe/` evidence | Duration ms / samples | p50 / p95 / p99 ms | Max ms | ≥150 / ≥250 |
|---|---:|---:|---:|---:|
| `idle-evidence-1790827780092.json` | 1800005.480 / 102886 | 17.426 / 18.296 / 19.155 | 9089.161 | 2 / 2 |
| `idle-evidence-1790868869293.json` (caffeinate retry) | 1800005.587 / 105615 | 17.065 / 17.362 / 19.654 | 826.195 | 4 / 1 |

`last-run.json` points to `idle-evidence-1790871021474.json`, the corrected-artifact **10-second smoke**, not either soak. Its zero misses cannot establish the duration requirement or supersede either failure. No additional probe or timing sample was collected for this diagnosis.

## Isolate: lowest observed failing layer

1. `run-electron-probe.cjs` mounts a DMG read-only and launches the actual app with empty HOME, minimal PATH and random cwd. It first tests owned-parent crash cleanup, then idle execution, then invokes the contract against recorded JSON. The runner's polling/timeout uses wall time, but does **not** compute the timing histogram.
2. Main forks utility after ready/renderer load, holds `powerSaveBlocker('prevent-app-suspension')`, and disables renderer background throttling. Main writes output only after the utility result/exit. This is not a renderer `setInterval` test, nor an IPC round-trip histogram.
3. `utility.cjs:5–14` synchronously loads/enumerates HID **before** measurement start. No physical handle/read or product/backend import occurs. ABI 149, Electron 44.5.1 and native addon loaded in the signed packaged utility; these are not system-Node native tests.
4. `utility.cjs:15–30` measures `performance.now()` differences between successive callback entries for `setInterval(..., 1000/60)`. It counts actual gaps ≥150/250ms. Fractional timer delay has no hard 60Hz/deadline guarantee; these are inter-callback gaps, not lateness against absolute scheduled deadlines or measured hardware heartbeats. Modest timer granularity/overhead explains why a nominal 16.667ms timer need not have that exact median, but does **not** explain 826ms/9s outliers.
5. Samples are appended throughout the run and sorted only **after** the final `now` is captured. Sorting, filtering, message delivery, JSON write and parent exit therefore cannot inflate previously measured gaps. The first sample legitimately includes first-timer dispatch delay. The separate 250ms owner-liveness callback shares this utility event loop and performs a synchronous PID check; no evidence identifies it as the long-gap cause.

Thus the failure is already visible in the otherwise idle utility callback/monotonic-clock boundary. Native initialization, physical HID reads, product controller load, renderer timing and post-measurement serialization are not required to reproduce the *retained* failure. There is no proof that subtraction/counting is erroneous. The useful diagnostic limitation is that samples/order/outlier timestamps were **not persisted**: JSON named “raw evidence” contains aggregates and lifecycle metadata, not raw tick chronology. Counts/max cannot be independently recomputed or aligned to OS events from these JSONs. No samples were deleted by this slice.

## Local OS evidence and causal limits

Run IDs derive from runner `Date.now()` before mount/crash/idle, not utility measurement start. Read-only `date -r` and `stat -f` bounded PDT (UTC−07:00) windows:

| Run | Run ID wall time | JSON modification | Parent / utility PID |
|---|---|---|---|
| Historic | Sep 30 21:09:40 | Sep 30 21:39:56 | 86082 / 86093 |
| Retry | Oct 1 08:34:29 | Oct 1 09:04:47 | 74607 / 74629 |

Executed `/usr/bin/log show --style compact --info` over Sep 30 **21:09:30–21:40:10** and Oct 1 **08:34:20–09:05:00**, filtering measured PIDs and powerd sleep/wake/assertions, then narrowly filtering powerd probe/caffeinate names and runningboardd/kernel utility PIDs/sleep transitions. No environment dump, images, credential data or device identifiers were requested. Relevant retained nonsecret records:

- Historic: powerd summarizes parent `NoIdleSleepAssertion "Electron"` at **21:22:46.431**, age **12:57**, and **21:37:46.441**, age **27:57**; release **21:39:54.696**, age **30:05**.
- Retry: powerd summarizes parent Electron assertion and caffeinate `PreventUserIdleSystemSleep` at **08:37:47.014** and **08:52:47.015**. Parent release **09:04:41.661**, age **30:08**; caffeinate client death **09:04:49.716**, age **30:20**. This corroborates keep-awake throughout the measured window rather than merely the claimed command.
- Narrow predicates returned no matching kernel sleep/wake transition or runningboardd record identifying utility suspension. Broader bounded powerd results contain assertion activity from other host apps (including audio/browser activity), so “idle probe” does not mean a quiescent/isolated host. Assertion activity is **not CPU-load measurement** and cannot be blamed for an outlier without correlation. `Sleep revert state` and notification display-wake messages are not proof the machine slept.

Missing assertion/log records are not proof of absence of all power transitions, App Nap, preemption or pressure. Main keep-awake/renderer throttling settings do not establish utility-thread QoS or hard real-time scheduling. In particular, **App Nap is not proven**, idle-sleep prevention did not eliminate misses, and GC pauses, timer/runtime behavior, OS scheduling/preemption, transient host contention and clock behavior remain distinguishable hypotheses, not diagnoses. No CPU/GC trace or timestamped outliers survive in the evidence.

**Classification: evidence inconclusive concerning precise root cause; a demonstrated packaged-utility scheduling/measurement-boundary gap, not an established product defect, false-positive test-harness defect, or proven environment failure.** Ordinary macOS/Node timers offer no hard real-time bound; this is an architectural assurance gap, but two runs do not prove every possible implementation inherently fails. Proven immediate reason for the red gate: measured callback gaps exceed its unchanged safety budgets. Deeper cause remains **unproven**.

## Issue #39 versus the stronger local gate

Authenticated read-only `gh issue view 39 --json number,title,body,state,comments,url` returned OPEN, no comments: <https://github.com/ajhochy/fps-camcontrol/issues/39>. It asks to prove packaged Electron/HID real-controller reads, a 60Hz loop holding timing/no App Nap drift, **30-minute idle + active timing histograms**, and a time-boxed spike run note rather than merged throwaway code. It does **not** explicitly specify zero ≥150ms/250ms misses or max <150ms. Current plan lines 79/116 likewise describe measurement and recording missed budgets; the executable foundation contract adds the stronger zero-miss feasibility gate (lines 40/41/44). Its historical author/authorization is not established here; its explicit text is stronger than issue #39.

That distinction is not a waiver: issue #39 is **not fully accepted** merely because an idle histogram exists. Real controller reads, active/product-loop timing and no-App-Nap proof are absent; enumeration opens zero handles. The local stronger gate genuinely fails and remains red. A finite passing soak would establish only its observed window, never an all-future hard scheduling guarantee. Manager owns disposition, not this diagnostic slice.

## Actual production safety implications (immutable HEAD baseline)

- `src/app/controllerLoop.ts` dispatches `machine.tick()` using a 16ms Node interval. `src/model/controlStateMachine.ts` refreshes unchanged gimbal motion after **150ms** (`GIMBAL_HEARTBEAT_MS`), caps changed motion to ≥50ms spacing, checks stale controller input at **250ms**, and bypasses pacing for stop. The 150ms value is a *motion refresh target checked on ticks*, not a separate hard-deadline timer. Baseline DJI socket connectivity ping is instead **1000ms** with a **3000ms** pong timeout (`src/devices/djiBridgeDevice.ts`); these pings do not refresh motion safety.
- `pi-bridge/dji_bridge.py` defaults to **250ms** safety timeout. Each `moveVelocity` arms/rearms the Pi-side async task; expiration calls `driver.stop()` then emits `app_timeout`. This is a remote software watchdog, not a proven hardware-firmware deadman. Its wake and BLE stop completion depend on Pi scheduling/link health; 250ms is not a measured hard physical stopping bound. VISCA cameras are not shown to have this independent DJI stop protection.
- One utility tick gap ≥150ms does not equal one real missed motion heartbeat: actual send spacing depends on phase since the last send, tick quantization and transport latency. Conversely, even a <150ms callback gap can consume the roughly **100ms nominal margin** between 150ms refresh and 250ms watchdog when it straddles a refresh deadline. The ≥250ms gaps would risk a Pi timeout during sustained motion if present on the production path, potentially causing stop/stutter. The probe did not exercise that path or motors, so no actual safety-stop event is claimed.
- A stalled Mac cannot promptly process stick release, stale-input stop or emergency stop on that same event loop. Independent receiver timeout is the essential fail-safe; never lengthen the deadman, replay stale queued motion, or create an unconditional keepalive that renews old nonzero input. Resumption must use genuinely fresh authorized input and the applicable explicit-resume policy, not old motion replay.

## Cheapest falsifiable target; no repair authorized/performed

There is **no proven causal code fix** justified by retained aggregates. The smallest diagnostic-gap target is `electron/probe/utility.cjs:15–30`: if a separately bounded continuation is independently authorized, retain a bounded record of outlier callback times with wall/monotonic anchor, actual interval/deadline semantics, and event-loop/CPU/GC attribution so an OS scheduling/power event or in-process stall can be falsified/correlated. This is a target description, **not** a request for another soak or new issue/task. Adding observability would not itself fix timing. No threshold changes, sample exclusions, random host-load tweaks, priority tricks or guessed App Nap/GC patch are supported.

If the requirement is uninterrupted bounded physical motion despite Mac stalls, the minimum correct *architectural candidate* is to keep expiry/stop enforcement at the independent actuator-side receiver, with freshness-bounded motion authority; a genuine hard bound additionally requires an independently enforceable actuator/firmware watchdog. A separate native thread/helper on the same Mac is not proof against whole-host suspension. If future attribution proves only an in-process blocking call, remove/isolate that specific blocking call rather than inventing a new controller architecture. These are conditional candidates, not proven repairs or instructions to touch concurrent controller files. Shortening refresh can add margin but cannot bridge an 826ms stall while preserving a 250ms fail-safe.

## Evidence/artifact continuity and diff handoff

Both failed soaks refer to preceding DMG SHA256 **cca4d31776de8f4d90750acf0513276e26d9ccabff41dc7a81ca2202a8de22be**. Current rebuilt DMG SHA256 **4d96331ad932f67d2c685dd4c678e49dd48a9a68e305bf93348b2dc55968fd88**, **128743311 bytes**, has corrected macOS minimum **13.0** and only the short smoke; that unrelated min-OS correction is not evidence of a timing repair. Identity/size/signing/minimum facts are preserved prior-owner evidence, not new validation executed here. Measured host: arm64 macOS **26.5.2**; packaged runtime Electron **44.5.1**, Node **24.21.0**, ABI **149**. Prior signed native load, sandboxed renderer, mounted-DMG hermetic launch, crash/normal cleanup, 268 smoke and 104 sandbox checks remain recorded successes, not re-executed here. Notarization, physical HID/motors and genuine clean-OS acceptance remain unverified.

Diagnosis-only diff: new untracked `docs/ai/runs/2026-10-01-electron-probe-timing-diagnosis.md`. Existing product/probe/package/lock/contract/current-plan/run-note modifications predate this slice and are not its edits. Validate this document with `git diff --no-index --check /dev/null <report>` and report its names/numstat using `git diff --no-index` (exit 1 means a new-file diff, not test failure); ordinary tracked `git diff` omits untracked documents. No staging needed. Final status remains **BLOCKED**, with causal uncertainty explicit and no foundation/installer readiness claim.
