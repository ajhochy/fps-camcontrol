# T11 — Controller binding: toggle/cancel tracking

**Labels:** `feature`, `tracking`, `input` · **Size:** S · **Depends on:** T4 · **Plan:** `docs/ai/current-plan.md`

## Goal
Give the operator a gamepad way to cancel/resume tracking on the controlled camera without touching the web UI. (Stick override already suspends tracking — T4.)

## Context
Existing chords: `LB + A/B/X/Y` save presets, `LB + RB` recenter, `RB` auto-transition, d-pad speed/lower-thirds, `back` emergency stop. `config/mappings.yaml` and `MappingSchema` define named inputs; controller profiles live in `controller-profiles/*.yaml`.

## Likely files
- `config/mappings.yaml` (**UI-managed file — check for local edits first**)
- `src/config/configLoader.ts` (`MappingSchema`)
- `src/model/controlStateMachine.ts`
- `controller-profiles/*.yaml` (only if a new logical button is needed)

## Acceptance criteria
1. Choose an input that is unused in every shipped profile (document the choice and why; verify against `xbox.yaml`, `xbox-bluetooth.yaml`, `switch-pro-bluetooth.yaml`, `wii-u-pro.yaml`, `generic.yaml`).
2. Press while tracking the controlled camera ⇒ cancel (with `stop()`); press while suspended ⇒ resume; press with no session ⇒ no-op (no error).
3. The binding is edge-triggered (`risingEdge`) and appears in the activity log with the existing context style.
4. No change to existing chords or `emergencyStop` behavior.
5. Mapping name/default added to `MappingSchema`; existing `mappings.yaml` without the new key still loads.

## Tests / evaluation
Smoke via `virtualController`: toggle/cancel/resume/no-op; existing chord regression assertions still pass. `pnpm build`; `STATUS_PORT=<free> pnpm test:smoke`. Real-pad verification is manual-only (see testing guide).

## Out of scope / data safety
No "start tracking" from the pad (needs a pointer) — cancel/resume only. No new controller profile work. Do not commit local edits to `config/mappings.yaml`.
