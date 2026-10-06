# S15 — apply and persist the proven video-delay recipe

**GitHub:** [#78](https://github.com/ajhochy/fps-camcontrol/issues/78)

## Goal

Connect the measured delay implementation to the qualified profile and production outputs.

## Plan and scope

[Revised program streaming core](https://github.com/ajhochy/fps-camcontrol/blob/integration/combine-open-prs/docs/ai/plans/2026-10-06-program-streaming-core.md); PR #60. Milestone: Streaming M3 — Audio monitoring and sync.
This issue delivers one step; it does not authorize the entire streaming project.

## Dependencies

[S05 / #68](https://github.com/ajhochy/fps-camcontrol/issues/68), [S06 / #69](https://github.com/ajhochy/fps-camcontrol/issues/69), [S07 / #70](https://github.com/ajhochy/fps-camcontrol/issues/70)

## Likely files

- `src/program/ (production filter/command construction)`
- `src/config/configLoader.ts`
- `src/testing/ (sync integration)`

## Acceptance criteria

- [ ] For accepted integers 0–15, apply the [S05 / #68](https://github.com/ajhochy/fps-camcontrol/issues/68) recipe to production video and show the corresponding rational-rate milliseconds; zero introduces no extra configured offset.
- [ ] Delay survives restart/profile reload and is rejected while outputs run, including legacy routes; headphone gain does not alter A/V timing.
- [ ] MP4 and local receive preserve requested repeated-content offsets within one frame before and after publisher reconnect at the supported rig rate.

## Required tests / evaluation

Boundary/fractional-rate arithmetic, persistence/lock cases and decoded flash/impulse comparison using [S05 / #68](https://github.com/ajhochy/fps-camcontrol/issues/68) fixtures.

Add focused contract checks before implementation; apply the repository gates appropriate to changed code. Record commands, source SHA and observed outcomes. Separate synthetic, physical, hosted and installed evidence; missing required evidence leaves the issue open.

## Out of scope / data safety

No live adjustment, extra frame-rate support or custom delay-buffer framework.

Preserve unrelated work and operator configs. Use isolated fixtures and disposable credentials; never commit tokens, stream keys, recordings or rig identifiers. Hardware/account use needs operator authorization at execution time. No production install, driver change, merge, release or public broadcast is authorized by issue creation.
