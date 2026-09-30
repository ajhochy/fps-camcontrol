# T13 — Live verification runbook, docs, and project-state update

**Labels:** `docs`, `tracking`, `verification` · **Size:** S (plus human time) · **Depends on:** T1–T12 · **Plan:** `docs/ai/current-plan.md`

## Goal
Make the feature safely operable: a written runbook, updated project memory, and a recorded human-run safety drill before anyone uses tracking live.

## Likely files
- `docs/tracking.md` (new: setup, config, sidecar launch, operating guidance, limits)
- `docs/ai/testing-guide.md`, `docs/ai/repo-map.md`, `docs/ai/architecture.md`, `docs/ai/project-state.md`
- `docs/ai/runs/<date>-tracking-live-verification.md` (new)
- `README.md` (short pointer)

## Acceptance criteria
1. `docs/tracking.md` covers: prerequisites, sidecar setup/launch, config block, mapping a Sony camera to a gimbal, speed cap guidance, what tracking is good for (single subject, secondary angle) and not, known limits.
2. Testing guide lists every new check command (`tracker-sidecar` unittest, sim, smoke additions) and the manual-only items.
3. Architecture/repo-map reflect the new `tracker-sidecar/`, `src/tracking/`, and the tracking data flow.
4. **Human-run drill recorded** with pass/fail per step, operator watching video, gimbals powered and within good BLE range:
   - small-deflection check of gimbal gain first (existing unverified risk);
   - track at the default cap (0.35);
   - stick override; resume only via explicit action;
   - emergency stop during active tracking;
   - kill the sidecar mid-track ⇒ gimbal stops within ~0.5–1 s;
   - walk the gimbal out of BLE range / power it off ⇒ session ends, no runaway on return;
   - Sony preview goes stale ⇒ stops;
   - target leaves frame ⇒ stops, holds, goes idle;
   - 30-minute idle soak and 30-minute active-tracking soak.
5. `project-state.md` updated via `project-state-updater` (what shipped, what is unverified, LAN-exposed control route risk, follow-ups).
6. Follow-up issues filed locally for the out-of-scope list in the plan.

## Tests / evaluation
Docs review plus the human drill. Automated baseline re-run: `pnpm build`, `STATUS_PORT=<free> pnpm test:smoke`, `python3 -m unittest discover -s tracker-sidecar/tests`, `python3 -m unittest discover -s pi-bridge/tests`, `node scripts/check-page-js.cjs`, `git diff --check`.

## Out of scope / data safety
No new features. Run notes must not embed screenshots or footage showing identifiable people; use test subjects who consent or redacted captures.
