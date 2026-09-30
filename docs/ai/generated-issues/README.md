# Generated issues — Click-to-Track Auto-Tracking

Source plan: `docs/ai/current-plan.md` (2026-09-30). Local files only; issues were later filed on GitHub — see the bottom of this file.
Create them later with `gh issue create --title "<title>" --body-file <file>` when ready (search for duplicates first).

| File | ID | Title | Size | Depends on |
|---|---|---|---|---|
| `001-tracking-config-and-device-key.md` | T1 | Tracking config block + device-key resolution | S | — |
| `002-sony-frame-capture-timestamp.md` | T2 | Sony live-view frame capture timestamp | S | — |
| `003-tracking-controller-and-simulator.md` | T3 | `TrackingController` control law + simulator | M | T1 |
| `004-tracking-manager-arbitration-safety.md` | T4 | `TrackingManager`: sessions, arbitration, safety stops | L | T1, T3 |
| `005-tracking-client-and-virtual-sidecar.md` | T5 | `TrackingClient` + protocol + virtual sidecar | M | T1 |
| `006-tracking-api-routes-and-status.md` | T6 | Tracking API routes + AppState status | M | T4, T5 |
| `007-tracker-sidecar-skeleton.md` | T7 | Tracker sidecar skeleton (Python) | M | T5 |
| `008-sidecar-frame-ingest-and-detection.md` | T8 | Sidecar frame ingest + person detection | L | T2, T7 |
| `009-sidecar-click-to-lock-and-association.md` | T9 | Sidecar click-to-lock, association, lost/reacquire | L | T8 |
| `010-operator-ui-track-mode.md` | T10 | Operator UI: Track mode, overlay, cancel | M | T6 |
| `011-controller-binding-toggle-tracking.md` | T11 | Controller binding: toggle/cancel tracking | S | T4 |
| `012-latency-calibration-and-gain-tuning.md` | T12 | Latency calibration + gain tuning tool | M | T4, T9 |
| `013-live-verification-runbook-and-docs.md` | T13 | Live verification runbook, docs, state update | S | all |

## Order and parallel tracks
```
T1 ─┬─ T3 ─┐
    ├─ T5 ─┼─ T4 ─ T6 ─ T10
T2 ─┘      │          └ T11
T7 ─ T8 ─ T9 ─ T12 ─ T13
```
- Track A (TS control): T1 → T3 → T4 · Track B (Python vision): T7 → T8 → T9 · Track C: T2, T5.
- Shared hot files — serialize: `statusServer.ts` (T2, T6, T10), `controlStateMachine.ts` (T4, T11), `smokeTest.ts` (T3–T6, T11), `configLoader.ts` (T1, T11).
- T5 freezes the sidecar protocol; T7–T9 must not start before it lands.
- Human-gated: T12 (real-rig run) and T13 (live drill).

## Filed on GitHub (2026-09-30)

| ID | Issue | Milestone |
|---|---|---|
| T1 | https://github.com/ajhochy/fps-camcontrol/issues/23 | Tracking M1 |
| T2 | https://github.com/ajhochy/fps-camcontrol/issues/24 | Tracking M2 |
| T3 | https://github.com/ajhochy/fps-camcontrol/issues/25 | Tracking M1 |
| T4 | https://github.com/ajhochy/fps-camcontrol/issues/26 | Tracking M1 |
| T5 | https://github.com/ajhochy/fps-camcontrol/issues/27 | Tracking M1 |
| T6 | https://github.com/ajhochy/fps-camcontrol/issues/28 | Tracking M3 |
| T7 | https://github.com/ajhochy/fps-camcontrol/issues/29 | Tracking M2 |
| T8 | https://github.com/ajhochy/fps-camcontrol/issues/30 | Tracking M2 |
| T9 | https://github.com/ajhochy/fps-camcontrol/issues/31 | Tracking M2 |
| T10 | https://github.com/ajhochy/fps-camcontrol/issues/32 | Tracking M3 |
| T11 | https://github.com/ajhochy/fps-camcontrol/issues/33 | Tracking M3 |
| T12 | https://github.com/ajhochy/fps-camcontrol/issues/34 | Tracking M4 |
| T13 | https://github.com/ajhochy/fps-camcontrol/issues/35 | Tracking M4 |
