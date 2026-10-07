# Streaming S1 MP4 failure diagnosis — 2026-10-07

## Current handoff addendum — 2026-10-07
Historical diagnosis-only scope and NOT FIXED statements below describe this triage run, not the current repair state. Subsequent AJ-authorized focused repair has recorded developer PASS receipts for 20 matrix cases, 44 decoded-stream comparisons and the 60-minute soak; aggregate validation remains FAIL after broad checks hung/ended SIGKILL. See [current S1 handoff](2026-10-07-streaming-s1.md) and [sanitized results](2026-10-07-streaming-checkpoint-results.json). Full S1 is NOT READY; no independent full gate, actual publisher reconnect, channel1 content, or internal queue/network-failure qualification is claimed.

**TEXT ONLY checkpoint: `--recovery-contract` needs local unpublished fixtures; fresh checkout is not self-contained.** The two fixture paths and known hashes are recorded in checkpoint results. No synthetic MP4s, raw logs, diagnostic scripts or artifact trees are being published. Private paths below use `<worktree>`/`<temp>`; original raw evidence stays local. Canonical tee/coupled/Electron-only product design is unchanged by the manager's S1-only independent-remux/Node-relay exception. Related #65–#68 only; #69–#89 pending.

## Historical diagnosis receipt (superseded current-state context)

## Status / identity / scope

**Root cause CONFIRMED. Diagnosis complete, NOT FIXED. BLOCKED — requires manager/AJ authorization for one subsequent focused implementation and independent verification. No gate PASS.**

Root `<worktree>`, branch `feat/streaming-s1-media-proof`, HEAD `aea1f13319246fef4ab0f716f19023f242b765f8`, confirmed before historical execution. Initial dirty status: modified `scripts/checks.cjs`; untracked S1 contract, original run note, `src/broadcast/`, two `src/testing/broadcast*.ts` entrypoints, `tests/broadcast/`. Those files were read, not edited during diagnosis. Only this note and the distinct evidence directory below were added then. Retained `dist/broadcast-evidence` artifacts were not regenerated or overwritten.

AJ authorized diagnosis after two repair attempts, not a third implementation. Loaded failure-triage; read canonical context, existing contract/run note, all relevant builders/supervision/relay/probe/pipeline test and compiled builders. Existing canonical planning context predates S1; the manager-approved S1 scope in the original run note governs this diagnosis. No peer dispatch, app/server, physical capture, Internet publishing, RTMP listener, controller, drivers, operator configuration, commits, push, PR, merge, deployment or worktree cleanup. All FFmpeg inputs synthetic; `CAMCONTROL_NO_CONTROLLER=1`. Only subprocesses created by diagnostic scripts were killed, and all were awaited/cleaned in finally. No remaining owned children.

## Failure / exact existing test

Original commands: `node dist/testing/broadcastPipelineTest.js` and `node scripts/checks.cjs issue`, with controller disabled. Failure at `src/testing/broadcastPipelineTest.ts:78`: copy-remux SIGKILL-interrupted recorder to NEW MP4, before its decode/SHA assertions. Original receipt: recovery PID31151, exit183, `moov atom not found`; first45-second25fpsdelay0 case only; full matrix incomplete,60minute soak not started. Existing suite attaches the crash recorder at start and kills it after2500ms+4000ms sleeps, regardless of persisted initialization/fragments (`:43–62`). Actual historical crash-recorder stderr/PID were not persisted by that suite; do not invent them. Its recovery stderr is retained in `dist/broadcast-evidence/pipeline/evidence.json`.

Previous two implementation repairs (from the original run note):
1. Bounded mux interleave100ms→1s after real FLV DTS-order failure with padded TS.
2. Common `-avoid_negative_ts make_non_negative` after late MP4 initial timestamp clamp made the first25fps GOP2.042667s.

The earlier content-analyzer repairs in Phase1 were separate: retained stderr tails lost early events; EOF blackdetect `black_end` was not a whiteflash. No new implementation repair occurred here.

## Confirmed cause

**The MP4 remux output's default buffering keeps initialized MP4 metadata and complete media fragments out of the filesystem for this low-entropy source; SIGKILL at6.5s leaves only an88-byte header, so the recovery demuxer correctly cannot find a `moov`.** This is an in-scope product/output-durability defect plus an uninstrumented fixed-time kill in the acceptance harness, not a missing runtime capability or merely an impossibly early crash.

Retained original is exactly:

| Offset | Atom | Bytes |
|---:|---|---:|
|0|ftyp|36|
|36|free|8|
|44|free|44|

No `moov`, `mdat`, `moof`, incomplete box, or trailing media exists. SHA256 before/after real recovery is unchanged:
`a0a7a96330b3440e3bc4fddf5250dcd5f3da48e1d3c9c14563b70f0a85f530ed`.

The original cannot be repaired from these88bytes alone: there are no samples or track configuration to reconstruct. Do not overwrite it, claim it recovered, or manufacture an empty passing media file.

## Reproduction commands / evidence

Durable evidence: `docs/ai/runs/artifacts/s1-mp4-triage-20261007-a/`. Scripts are diagnosis artifacts, not production/test edits. Full argv/PIDs/timing/atom samples and exit statuses are in `receipt.json`, `isolate-receipt.json`, `empty-control-receipt.json`, `audit.json`, `ignore-editlist-receipt.json`; full stderr/progress/probe JSON and copied synthetic MP4s are adjacent. Runtime: `/opt/homebrew/bin/ffmpeg` and sibling ffprobe8.1.2, libavformat62.12.102. Version/configuration and actual muxer capability help retained; `hybrid_fragmented` is supported. Developer runtime only, no redistribution qualification.

Commands executed from the assigned root:

```sh
CAMCONTROL_NO_CONTROLLER=1 node docs/ai/runs/artifacts/s1-mp4-triage-20261007-a/diagnose.cjs
CAMCONTROL_NO_CONTROLLER=1 node docs/ai/runs/artifacts/s1-mp4-triage-20261007-a/isolate.cjs
CAMCONTROL_NO_CONTROLLER=1 EMPTY_ONLY=1 node docs/ai/runs/artifacts/s1-mp4-triage-20261007-a/isolate.cjs
CAMCONTROL_NO_CONTROLLER=1 node docs/ai/runs/artifacts/s1-mp4-triage-20261007-a/audit.cjs
git diff --check
```

All scripts exited0; their receipts deliberately record failing experiments, not acceptance PASS. Full suites were NOT rerun: doing so would overwrite original artifacts. Instead reproduced the exact failing FFmpeg argv, changing only recovery destination to a NEW private-temp path:

```sh
/opt/homebrew/bin/ffmpeg -hide_banner -nostdin -v error \
  -i <worktree>/dist/broadcast-evidence/pipeline/25-1-0-45/interrupted.mp4 \
  -c copy -y <temp>/s1-mp4-triage/original-recovered.mp4
```

Result183, same `moov atom not found`, no recovered output; original SHA unchanged. Private temp directories use `mkdtemp` and are recorded in receipts. Existing synthetic TS source for isolated remux, `dist/broadcast-evidence/pipeline/capability/runtime.ts`, retained unchanged by SHA comparison.

## Falsifiable experiments

Fresh real1280×72025/1fps flash/impulse source used the existing compiled encoder builder, actual H264VideoToolbox (`allow_sw=0`), AAC48kstereo and existing TS relay. MP4 builder unchanged except diagnostic variant injecting output `-flush_packets 1`. Real filesystem reads every100ms; no simulated media, timer-only readiness or padded-file-size inference.

| Experiment | Kill/state | Persisted bytes/atoms | Recovery |
|---|---|---|---|
|Unchanged pipeline, preinit control|101ms|no file/0bytes|no media exists|
|Unchanged pipeline, original kill timing|6596ms|88; ftyp/free/free|183/moov missing|
|Unchanged pipeline, wait for complete fragment, bounded30s|30090ms deadline|still88; no complete persisted fragment|183/moov missing|
|Same pipeline +flush_packets1|4554ms, first complete moof+mdat observed|13888; ftyp/free/free/moov/mdat/moof/mdat|0; probe0; full decode0, empty stderr|

Lowest-layer control removed relay and live encoder: actual retained8s VideoToolbox TS input, remux builder with `pipe:0` replaced by source path, input `-re`, info stderr and `-progress pipe:1` for observation only. Identical input/probe/timestamp/mux flags for baseline/flush variants.

| Isolated remux | Result | Persisted structure | Recovery/decode |
|---|---|---|---|
|Default buffering, SIGKILL≈6.5s|actual SIGKILL|88-byte header only|183/no decode|
|flush_packets1, SIGKILL≈6.5s|actual SIGKILL|22342bytes; moov+initialmdat+two complete moof/mdat pairs|0/0|
|Default buffering, natural EOF|exit0|32666bytes; ftyp/free/mdat/moov, no moof/mvex|0/0|
|flush_packets1, natural EOF|exit0|32666bytes; same regular structure/sample counts|0/0|

Baseline isolated stderr has successful input identification and output stream mapping, no runtime error; progress reaches197video frames and5.505667s output time while `total_size` remains88. Thus input probe did not simply consume the entire6.5s. Flushing alone changes durability without probe/keyframe/timestamp/mux-format changes. Baseline30s still failing falsifies “just wait a few more seconds.” TS4Mbps padding is stripped by copy-remux; actual MP4/AAC entropy is small (isolated final8s MP4≈32KiB), not the nominal2500k/128k encode targets. Exact internal AVIO buffer threshold is not instrumented; output-side buffering diagnosis is confirmed by controlled intervention, not a guessed threshold. Process-crash filesystem visibility is measured, NOT host power-loss/fsync durability.

## Important secondary finding: successful decode is not complete recovery

Do not implement only flushing and call the recovered content proven. Current default MP4 demux/edit-list handling loses initial-GOP samples on these interrupted hybrid files:

- Fresh25fps file has50video/95AAC samples in initial `moov` sample tables plus50video/94AAC in complete fragment `trun`s:100video/189AAC persisted. Default recovery produces51video/95AAC; first video packet is flagged discard in the interrupted input. All decode exit codes still0.
- Isolated29.97 file has60initialvideo+60+60fragmentvideo=180persisted, and100+94+94=288AAC. Default recovery produces121video/189AAC.
- Diagnostic `-ignore_editlist 1` before `-i` recovers100/189 and180/288 with clean decode, BUT loses video-origin offsets:0.021s/0.121s becomes0.000s. Do not adopt that blindly; configured relative A/V must remain intact.
- Diagnostic **`-advanced_editlist 0` before `-i`** recovers all100/189 and180/288 samples, clean decode, while retaining video start0.021s/0.121s and audio start0.000s. `ignore-editlist-receipt.json` records both options, argv/counts/decode results. These are sample counts and timestamp-offset evidence, not a substitute for flash/impulse content validation over the full delay/rate matrix.
- Adding `empty_moov` alone to existing hybrid flags is NOT a proven fix: both controls exit255 before SIGKILL with `Malformed AAC bitstream ... use ... aac_adtstoasc`, plus nonzero-DTS/delay_moov warning. Those tiny files' subsequent decode0 must NOT be mistaken for successful capture. No format redesign is justified by this control.

Hybrid_fragmented itself works on this runtime: output buffering control retains real fragmented media after SIGKILL; normal EOF returns regular MP4 in both baseline/flush variants. No encoder change, different container or removal of crash-recovery requirement is needed to resolve the observed missing-moov failure.

## Minimal proposed repair / likely files / checks

For manager approval and the next focused coder, not applied here:

1. `src/broadcast/ffmpegArgs.ts:19–22`: explicit output `-flush_packets 1` for MP4 copy-remux, retaining `+frag_keyframe+hybrid_fragmented` and existing timestamp flags. Add a tiny argument regression in `tests/broadcast/ffmpegArgs.spec.ts`. No new dependency/abstraction needed.
2. `src/testing/broadcastPipelineTest.ts:43–81`: instrument actual crash recorder PID/exit/stderr and byte/atom growth; assert initialization plus complete media before intentional crash with a bounded deadline. A deadline without fragments FAILS, not skip/pass. Keep early-crash case distinct. Assert regular MP4 structure on normal EOF, SHA unchanged on both failed/successful recovery, NEW target only.
3. Same recovery invocation at`:78`: qualify input `-advanced_editlist 0` for interrupted hybrid recovery, not `ignore_editlist1`; require decoded sample counts for ALL completed persisted fragments including first GOP, no internal cadence hole, first keyframe, clean decode and actual flash/impulse offset. Diagnostic evidence supports this minimal option but full content/matrix qualification remains required. If production recovery later moves to a shared helper, apply once there; current source has only this recovery caller.
4. Re-run the exact existing short pipeline after focused implementation and independent verification; preserve these failed artifacts. No acceptance reduction: full20-case matrix, measured recovery content, independent output-failure/reconnect, stereo channel content, real queue bounds and60minute soak remain outstanding per original note. Build/two focused tests/runtime proof previously worked; not re-certified by this diagnosis.

**Honest state boundary (only new product clarification if needed):** before any initialized complete media exists, classify recording as starting/uninitialized; crash yields “no recoverable media,” preserve original and report that explicitly. After initialized complete persisted media exists, crash recovery MUST produce NEW decodable MP4 retaining completed content/relative A/V. In-progress trailing fragment may be lost; completed fragments may not be silently dropped. Contractc6 does not explicitly demand recovery from zero media, so no contract weakening is justified. The current6.5s failure was NOT merely a legitimate preinitialization crash: same source/probe/runtime persisted complete fragments before that time when explicitly flushed. Manager decides whether an explicit operator-facing readiness/state definition needs recording in later product scope; this run makes no product decision.

## Preservation / handoff

Only added this note and `docs/ai/runs/artifacts/s1-mp4-triage-20261007-a/` (diagnostic scripts, receipts/logs and copied real synthetic media). Existing S1 product/test/contract/run files unchanged; ignored dist evidence retained, original recovery input SHA unchanged; source TS SHA unchanged; finally receipts show no owned PIDs. `git diff --check` clean. No hour soak, acceptance gate, physical validation or readiness claim. Manager owns next implementation authorization; diagnosis complete, NOT FIXED.
