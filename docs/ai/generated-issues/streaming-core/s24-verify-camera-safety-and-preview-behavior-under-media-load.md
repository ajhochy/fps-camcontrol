# S24 — verify camera safety and preview behavior under media load

**GitHub:** [#87](https://github.com/ajhochy/fps-camcontrol/issues/87)

## Goal

Prove streaming integration preserves camera-control responsiveness and shutdown safety.

## Plan and scope

[Revised program streaming core](https://github.com/ajhochy/fps-camcontrol/blob/integration/combine-open-prs/docs/ai/plans/2026-10-06-program-streaming-core.md); PR #60. Milestone: Streaming M6 — Packaging and qualification.
This issue delivers one step; it does not authorize the entire streaming project.

## Dependencies

[S22 / #85](https://github.com/ajhochy/fps-camcontrol/issues/85)

## Likely files

- `src/testing/ (media-load regression)`
- `docs/ai/runs/ (safety evidence)`

## Acceptance criteria

- [ ] With record+stream+Listen+preview active in Electron, controller/ATEM handling and existing dead-man timing remain within their contracts. Separately run existing CLI/iPad arbitration and preview regressions; Electron LAN remote access is not provided by this plan.
- [ ] Publisher stall, recording failure, page close and capture failure do not block motion-stop handling or create another source owner.
- [ ] Preserve isolated fixtures/ports and configuration; report source SHA, resource measurements, command latency and any physical-only gaps separately.

## Required tests / evaluation

Repository fake-hardware regressions plus targeted media-load faults; execute existing issue/PR gates serially at implementation time. Physical safety confirmation remains [S25 / #88](https://github.com/ajhochy/fps-camcontrol/issues/88)/[S26 / #89](https://github.com/ajhochy/fps-camcontrol/issues/89).

Add focused contract checks before implementation; apply the repository gates appropriate to changed code. Record commands, source SHA and observed outcomes. Separate synthetic, physical, hosted and installed evidence; missing required evidence leaves the issue open.

## Out of scope / data safety

No changes to control-law thresholds or use of production hardware for synthetic load tests.

Preserve unrelated work and operator configs. Use isolated fixtures and disposable credentials; never commit tokens, stream keys, recordings or rig identifiers. Hardware/account use needs operator authorization at execution time. No production install, driver change, merge, release or public broadcast is authorized by issue creation.
