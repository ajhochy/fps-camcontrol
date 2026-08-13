---
type: project
---

# Project State — fps-camcontrol

## Current focus
Prepare the verified Sony multi-camera dashboard work for a draft PR and manual hardware smoke testing. Automated verification and browser-fixture evaluation passed; the feature is not complete or merged.

## Active branch / PR
`feat/sony-dashboard`; no PR opened yet. Next workflow state is draft PR.

## In progress
- Browser fixture verified two connected camera widgets with disconnected cameras excluded, independent previews/settings, and Device Config connection controls.
- Desktop and 300 px layouts, keyboard/click touch controls, sequential polling capped at 8 fps, hidden-page pause, and transition-only `aria-live` behavior were verified.
- Evaluation artifacts are under `docs/ai/runs/artifacts/sony-dashboard/`.

## Risks / known issues
- Final-gate live physical sidecar evaluation timed out; this did not invalidate the automated/browser verification pass.
- Manual checks remain for two physical cameras simultaneously, FX3 touch focus, and HDMI coexistence.
- Existing DJI controller/preset, interruption, recovery, and soak checks remain outstanding; RS4/RS4 Pro are unvalidated.
- First-service config not yet confirmed on real gear: V-BOT tilt direction, ATEM input IDs, ATEM DSK index.
- Post-hardware polish gaps: no web-UI editor for DJI devices (YAML-only today), DJI-BRIDGE activity-log rendering is default-styled, no Sony PZ stub, roll axis has no controller mapping yet.

## Test status
- Verification gate passed after the last production change: `pnpm build`, smoke 89/89, and `git diff --check` passed.
- Browser-fixture evaluation passed with the responsive, interaction, polling, visibility, accessibility, and multi-widget behaviors listed above.
- Prior DJI target-hardware discovery, telemetry, motion, watchdog stop, and clean-disconnect evaluations remain passed.

## Next step
Open a draft PR, then manually verify two physical cameras simultaneously, FX3 touch focus, and HDMI coexistence before treating the feature as complete.

---
**Run history:** one file per run under `docs/ai/runs/` (surfaced as `ai-runs/`). This snapshot is overwritten in place.
