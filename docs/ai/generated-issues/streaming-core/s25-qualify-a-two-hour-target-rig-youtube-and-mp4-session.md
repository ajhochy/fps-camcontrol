# S25 — qualify a two-hour target-rig YouTube and MP4 session

**GitHub:** [#88](https://github.com/ajhochy/fps-camcontrol/issues/88)

## Goal

Demonstrate the Wirecast replacement on the intended hardware and scheduled-event workflow.

## Plan and scope

[Revised program streaming core](https://github.com/ajhochy/fps-camcontrol/blob/integration/combine-open-prs/docs/ai/plans/2026-10-06-program-streaming-core.md); PR #60. Milestone: Streaming M6 — Packaging and qualification.
This issue delivers one step; it does not authorize the entire streaming project.

## Dependencies

[S23 / #86](https://github.com/ajhochy/fps-camcontrol/issues/86), [S24 / #87](https://github.com/ajhochy/fps-camcontrol/issues/87)

## Likely files

- `docs/ai/runs/ (target-rig receipt)`
- `docs/ (operator calibration/recovery runbook)`

## Acceptance criteria

- [ ] With operator authorization and Wirecast closed, run a disposable unlisted scheduled event for two hours with real program stereo audio, Listen and the calibrated frame delay; compare remote playback and saved MP4.
- [ ] Exercise a controlled network outage: recording stays continuous, resumed publishing is fresh/decodable, statuses match YouTube. Measure RAM, camera responsiveness, drift and headphone latency.
- [ ] End session produces a usable MP4 and confirmed event completion or an explicit failure result. Preserve rig configs and runtime/driver hashes; clean up disposable event/test artifacts as authorized.

## Required tests / evaluation

Physical capture, hosted playback, decoded sync measurements, storage and output continuity receipts; success requires all observed criteria, not just process survival.

Add focused contract checks before implementation; apply the repository gates appropriate to changed code. Record commands, source SHA and observed outcomes. Separate synthetic, physical, hosted and installed evidence; missing required evidence leaves the issue open.

## Out of scope / data safety

No production/public event, driver upgrade, merge or release. Missing operator/rig/account access leaves the task open.

Preserve unrelated work and operator configs. Use isolated fixtures and disposable credentials; never commit tokens, stream keys, recordings or rig identifiers. Hardware/account use needs operator authorization at execution time. No production install, driver change, merge, release or public broadcast is authorized by issue creation.
