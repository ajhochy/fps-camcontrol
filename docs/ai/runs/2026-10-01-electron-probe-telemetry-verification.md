# Independent verification — Electron probe telemetry — 2026-10-01

## Outcome: FAIL — instrumentation acceptance evidence gaps only

The exact contract command succeeds on the retained actual diagnostic, but its assertions can falsely accept evidence violating bounded-memory, privacy, and short-run criteria. This is **not** a finding that the actual retained diagnostic violates those criteria, and not a finding of a shipping-app defect. No source, test, contract, dependency, threshold, or package repair was made. Route the acceptance-test gaps to the manager; do not mark the entire foundation READY.

- Root: `/Users/ajhochhalter/.local/share/opencode/worktree/ec2e0fe3fdd54c2e9ab53bfa4cc75c91e40568ed/fps-electron-two-pr-plan`.
- Branch: `feat/electron-foundation`.
- HEAD: `763122d5ef27097661773ccc16d4f704f950ea81`.
- Contract: `docs/ai/contracts/electron-probe-telemetry-v1.json`, well-formed JSON, six criteria mapped to the existing executable; `waiver: null`, `not_tested: []`.
- Sole verifier-owned repository output: this report.
- Scope: non-shipping instrumentation, retained signed packaged probe evidence, source and documentation review. No new launch, soak, sandbox, build, packaging, dependency changes, native rebuild, Git mutation, external communication, hardware access, live-service restart, or tracking publication.

## Universal core / ownership

Entry command:

```sh
git rev-parse --show-toplevel && git branch --show-current && git rev-parse HEAD && git status --short && git diff --name-only && git diff --stat
```

Output root/branch/HEAD matched the dispatch. The tracked diff comprises `README.md`, `docs/ai/current-plan.md`, `docs/ai/decisions.md`, `package.json`, `pnpm-lock.yaml`, and `pnpm-workspace.yaml`; these are prior/concurrent owner work, not this slice. The dispatch expressly identifies concurrent packaging ownership. Untracked controller, foundation, licensing and packaging paths likewise remain outside this verification. No unexpected verifier edits were made, and no whole-tree ownership or compatibility claim is inferred from this dirty worktree.

All three probe runtime paths were already untracked, so ordinary `git diff` cannot isolate this instrumentation delta. Executed `git diff --no-index --numstat /dev/null <path>` produced utility **100/0**, main **59/0**, runner **100/0**, with expected difference exit 1. These are whole-file sizes, including the prior probe, not instrumentation additions. The owner records previous sizes 41/47/57 and net growth **+59/+12/+43**. Those historical sizes have no immutable Git baseline here; they are explicitly attributed to the owner's record, not independently reconstructed.

Read the six context documents and applicable packaged-runtime, security, performance and documentation verification references. No UI/API/product smoke applies to this instrumentation-only assessment. GitNexus MCP is unavailable in this session: `detect_changes` was not run; impact remains **UNKNOWN**, not low risk. The owner's stale-index findings are not substituted for fresh MCP evidence.

## Captured executable evidence

All commands below ran in the exact root above.

### Contract, syntax, whitespace and retained hashes

```sh
git branch --show-current && git rev-parse HEAD && node scripts/test-electron-probe-telemetry.cjs dist/electron-probe/diagnostic-evidence-1790873006114.json && node --check electron/probe/utility.cjs && node --check electron/probe/main.cjs && node --check scripts/run-electron-probe.cjs && node --check scripts/test-electron-probe-telemetry.cjs && git diff --check && shasum -a 256 dist/electron-probe/idle-evidence-1790827780092.json dist/electron-probe/idle-evidence-1790868869293.json dist/electron-probe/last-run.json "dist/electron-probe/FPS CamControl Probe-0.1.0-arm64.dmg" && stat -f '%z bytes' "dist/electron-probe/FPS CamControl Probe-0.1.0-arm64.dmg"
```

Exit 0. Output included `electron-probe-telemetry-v1 PASS: instrumentation only, not timing acceptance`; syntax and whitespace stages were silent and successful.

| File | Independently observed SHA256 |
|---|---|
| `idle-evidence-1790827780092.json` | `2ad626d50c3d1368dcc36534611e4113535c629a20e10ecf5b1ecd6bac587253` |
| `idle-evidence-1790868869293.json` | `0a77d10a1b38686ea1c6df198c18fbcac7add42f91b2fc0bba1e6e527d3558be` |
| `last-run.json` | `3ed5c1c2a71e12548f32201d8348e8916ab75bc27f21e0f9a3068ae2465b531f` |
| `FPS CamControl Probe-0.1.0-arm64.dmg` | `565bbb5296bc407c42944bdda8fa59df5d4e8509464e1f6ca3ce7df29fc5f766` |

Every digest matches the owner's recorded digest. DMG size: **128752461 bytes**. This verifies byte-identical preserved failures and the recorded derived artifact, not immutable shipping certification.

### Existing packaged runtime/security

```sh
codesign --verify --deep --strict --verbose=2 "dist/electron-probe/mac-arm64/FPS CamControl Probe.app"
codesign --verify --strict --verbose=2 "dist/electron-probe/mac-arm64/FPS CamControl Probe.app/Contents/Resources/app.asar.unpacked/node_modules/node-hid/build/Release/HID.node"
/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "dist/electron-probe/mac-arm64/FPS CamControl Probe.app/Contents/Info.plist"
```

Both signature checks exited 0: `valid on disk`, `satisfies its Designated Requirement`; deep verification enumerated and validated nested helpers/frameworks. Minimum OS output: **13.0**. No launch, mount, signing or notarization occurred during this gate.

Read-only `@electron/asar.extractFile` comparison using `assert.deepEqual` confirmed packaged `main.cjs` and `utility.cjs` byte-identical to the inspected owned source. The retained target is the actual packaged arm64 Electron utility process, not browser-target E2E. Recorded Electron **44.5.1**, embedded Node **24.21.0**, ABI **149**, HID load/enumeration true, opened handles **0**. Renderer sandbox/context isolation true, Node integration false, `require`/`process` undefined. These nested renderer facts are present in actual evidence, although the telemetry test only binds some of them.

### Raw failed timing replays (expected nonzero)

```sh
node scripts/test-electron-foundation.cjs dist/electron-probe/idle-evidence-1790827780092.json
node scripts/test-electron-foundation.cjs dist/electron-probe/idle-evidence-1790868869293.json
```

Each exited 1 at `scripts/test-electron-foundation.cjs:40:8`: original **`2 !== 0`**, retry **`4 !== 0`**. The telemetry executable independently requires those exit codes and that assertion location. The inspected checker still requires zero misses at 150/250ms, a 1800000ms minimum duration and max below 150ms. The short diagnostic does not invoke that gate or replace `last-run.json`. No threshold, duration, criterion or waiver was changed by this verifier. Historic maxima approximately **9089ms / 826ms** remain unresolved; root cause unknown.

### Existing-test sensitivity audit — decisive acceptance gaps

This exact command executes the **existing** test in the same JavaScript realm, intercepting only reads of the supplied diagnostic to supply in-memory altered evidence. Collector source, test source, preserved raw files, subprocess foundation checker and persisted evidence stay unchanged. An unmodified control establishes that the adapter is not breaking assertions.

```sh
node -e 'const fs=require("node:fs"),vm=require("node:vm"),path=require("node:path"); const file=path.resolve("scripts/test-electron-probe-telemetry.cjs"),evidence=path.resolve("dist/electron-probe/diagnostic-evidence-1790873006114.json"),req=require("node:module").createRequire(file),source=fs.readFileSync(file,"utf8"); const execute=vm.runInThisContext("(function(require,process,Buffer,__dirname,console){"+source+"\n})",{filename:file});for(const [name,change] of [["unmodified retained diagnostic",d=>{}],["histogram exceeds cap",d=>d.utility.timing.samples=240001],["diagnostic exceeds 60s",d=>d.utility.timing.durationMs=60500],["privacy token injected",d=>d.utility.telemetry.token="SENTINEL_SECRET"]]) {const d=JSON.parse(fs.readFileSync(evidence));change(d);const fakeFs={...fs,readFileSync:(p,...args)=>path.resolve(String(p))===evidence?Buffer.from(JSON.stringify(d)):fs.readFileSync(p,...args)};const localRequire=x=>x==="node:fs"?fakeFs:req(x);localRequire.resolve=req.resolve;let result="accepted";try{execute(localRequire,{argv:[process.execPath,file,evidence],execPath:process.execPath},Buffer,path.dirname(file),{log:()=>{}});}catch(e){result="rejected: "+e.message;}console.log(name+": "+result);}console.log("Existing-test sensitivity audit complete; no persisted evidence or source changed");'
```

Exit 0, output:

```text
unmodified retained diagnostic: accepted
histogram exceeds cap: accepted
diagnostic exceeds 60s: accepted
privacy token injected: accepted
Existing-test sensitivity audit complete; no persisted evidence or source changed
```

An initial `runInNewContext` audit was discarded as invalid evidence: cross-realm prototypes caused `deepEqual` to fail before diagnostic validation. The same-realm rerun above removes that harness artifact and demonstrates all three false acceptances with a valid control. This was a verifier-harness correction, not a product repair.

## Contract-to-assertion reconciliation

| Criterion | Actual binding evidence / gap | Assessment |
|---|---|---|
| c1: >=150/250ms outliers and clocks | Exact synthetic boundary values, missed250 booleans, prior monotonic time, wall timestamp and clock difference asserted; 128 rows and explicit drops asserted | Supported; catches changed thresholds and loss of clock correlation |
| c2: CPU/GC/ELU/version/protocol semantics | Runtime projection and versions deep-equal; null fallback; finite clocks/GC/CPU/RSS; actual seven GC entries; source uses process CPU deltas and interval ELU | Supported for observed recording, no causal attribution or performance win |
| c3: bounded retained samples/output/memory and privacy | 128 retained rows/drop counters and <128KiB synthetic telemetry tested; persisted complete JSON <=256KiB tested. No test drives the utility's 240000 histogram exhaustion/error path; 240001 sample evidence and injected token are accepted | **FAIL: test-harness/acceptance-coverage gap** |
| c4: safe complete/partial writes and crash | Actual persisted partial checkpoint and complete telemetry, lifecycle exit fields asserted. Atomic writer is source-reviewed (size guard, private temp write, rename); executable test checks only the presence of `renameSync`/`partial`, not the writer's cap rejection or failed-write behavior | Partial evidence; cap/failure assertions missing; no fsync claim |
| c5: unchanged red foundation acceptance | Both original raw failures replay exit 1 at the zero-miss assertion; all recorded digests match; static checker still has original duration/threshold requirements | Supported; original timing gate remains RED |
| c6: one short packaged diagnostic, not new timing acceptance | Actual duration 55004.794458ms; retained crash/normal evidence; no new run. Existing test allows any duration <61000ms and demonstrably accepts 60500ms | Actual recorded run supported, **future-pass bound gap** |

Root cause of false acceptance: the existing evidence validator never checks histogram sample count or an allowlisted persisted telemetry schema, and its duration assertion uses 61000 rather than the stated 60-second bound. This does not prove that the runtime currently emits excess samples or private telemetry. Manager should route strengthened binding/negative tests for c3/c4/c6 to the owner; verifier did not author replacement tests or edit the contract. No new soak is needed to demonstrate these coverage gaps. No environment repair is required.

## Source/security/measurement review

The real collector retains the first 128 outliers and GC rows, counts dropped rows, validates clock/GC inputs, normalizes unavailable runtime metrics to null, and rejects regressed monotonic timestamps. Runtime CPU is process-wide microsecond interval delta; ELU is interval active/idle utilization, not host scheduling or per-thread causality. GC wall time is an anchor-derived estimate on the performance timeline, not a directly observed wall clock, and delivery can lag.

Source has a 240000-sample histogram cap with explicit `SAMPLE_CAP_EXHAUSTED` instead of silently excluding samples. Main serializes before enforcing 262144 bytes, writes mode 0600 to a temporary file and promotes via rename; runner similarly caps/promotes final diagnostic evidence. These mechanisms exist, but exhaustion and write-rejection behavior lack the required binding assertions. Atomic promotion is not fsync/power-loss durability: a crash can leave the previous checkpoint or an unpromoted temp file. Initial partial evidence has null runtime; it is not called complete.

Source projects telemetry runtime/version/GC data rather than dumping caller objects. Native diagnostic paths are removed, HID is enumerated but never opened, and error strings are fixed codes. The retained diagnostic has aggregate device count but no HID identifiers/frames, tokens, environment or host path dump. Its fixed `minimalPath: /usr/bin:/bin` is a hermetic-lifecycle fact, not a host dump. No new auth/network/SQL/shell/renderer command boundary was introduced; local duration parsing is finite and bounded. Synthetic NaN/Infinity rejection and private-field removal tests exist; persisted unknown-key privacy rejection does not.

Actual retained measurement: **55004.794458ms**, **3242** samples, max **56.734083ms**, zero >=150/250ms outliers, **seven GC rows**, no row drops; p50 **17.057625**, p95 **17.252708**, p99 **17.999251ms**. Last CPU delta **86us user / 65us system**, RSS **65126400 bytes**. ELU `idle/active/utilization` are all zero: **non-informative/unavailable for attribution on this runtime**, never proof of zero activity or absence of scheduling stalls. No outlier occurred to correlate. This slice claims measurement instrumentation only, not an optimization; no comparable remeasurement or improvement claim is made. Instrumentation overhead has not been quantified.

Recorded crash parent/utility **17927/18181** and normal parent/utility **18189/18196** exited according to the retained runner result. Crash records SIGKILL and partial persistence; normal result records exit 0. These are historical packaged-run observations, not freshly observed process-exit events or guarantees against PID reuse. Source kills only its spawned app and monitors parent loss; no arbitrary process kill was executed by this verifier.

## Documentation, compatibility and remaining gates

Referenced contract, tests, runner, package/sign scripts, approval/diagnosis notes and crash partial evidence paths were checked to exist. The documented contract command was executed. The owner note correctly separates instrumentation from timing/root-cause/whole-foundation readiness, and explains clock, ELU, partial/atomic and privacy limitations. Historical context pack contains stale branch/testing information; it is not used as current acceptance evidence. This report does not update shared project state.

PR-level build, maintained product/controller/backend/UI suites, fresh packaged launches and sandbox were **not run**, as explicitly prohibited by the evidence-only dispatch and because product smoke can boot real services/hardware. Therefore no repo-wide compatibility, user-facing readiness, or PR-ready claim is made. No waiver is inferred. Current shipping scope is packaging the **existing app**; unrelated controller redesign is outside its critical path. The non-shipping zero-miss probe is not a shipping certificate.

Still required in their respective scopes: resolve/measure the timing failure with explicit manager authority; real active controller/HID/control-loop/hardware validation; clean-OS/dependency-free first/second launch and permission behavior; actual Gatekeeper/notarization validation and shipping-artifact-specific packaged lifecycle/security/compatibility gates. Physical motors, Sony/ATEM/Pi, and clean-OS checks remain human/manual as applicable, not silently satisfied by this short diagnostic. Original root cause is unknown and not fixed.

### Consolidated handoff to workflow-orchestrator

**FAIL — instrumentation acceptance test coverage only.** Successful retained evidence is preserved above. Required next action: owner strengthens bounded-histogram/error, output-write failure/privacy schema and diagnostic-bound assertions without waiving criteria or altering original timing thresholds; manager controls disposition. The overall foundation remains RED for the preserved timing gate. GitNexus is unavailable/UNKNOWN, and forbidden full-suite/build/new-runtime evidence is outside this narrow result. No product defect was established or fixed by this verifier; no question, new issue, remote mutation or agent dispatch was made.
