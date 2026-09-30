# T9 — Sidecar click-to-lock, association, lost/reacquire

**Labels:** `feature`, `tracking`, `python`, `vision` · **Size:** L · **Depends on:** T8 · **Plan:** `docs/ai/current-plan.md`

## Goal
Turn a click into a locked person and keep that identity across frames, emitting `locking → tracking → lost → idle` with stable geometry.

## Context
Prior art favors detector + ByteTrack-style association over single-object OpenCV trackers (CSRT/KCF drift and lose identity on occlusion). v1 is exclusive single-target lock.

## Likely files
- `tracker-sidecar/tracker.py` (association + lock state machine), `association.py` (Kalman + IoU matching, or a permissively licensed library)
- `tracker-sidecar/tests/`, `requirements.txt`, `THIRD_PARTY_NOTICES.md`

## Acceptance criteria
1. `select{x,y}` picks the detection containing the click (smallest area if nested); if none, the nearest detection whose center is within a configurable radius; otherwise responds with `idle` + `error{code:"no_target"}`.
2. Lock is exclusive: a new person entering or standing near the target never takes over the ID.
3. Tracks through short detection dropouts (Kalman predict) and brief occlusion; emits `tracking` with the last good geometry flagged by `conf`.
4. On loss beyond `reacquireMs`, emits `lost`; attempts reacquire only with an appearance check (e.g. color-histogram similarity against the locked crop, stored **in memory only**) above a threshold; otherwise stays `lost` until timeout ⇒ `idle`.
5. `cancel` clears all lock state and memory of the target appearance immediately.
6. Geometry is smoothed only lightly (the app owns the control filter) and always normalized; `frameTs` is that of the frame it was derived from.
7. Tracker library license (MIT/Apache/BSD) recorded; AGPL/GPL dependencies are not added without a recorded decision.

## Tests / evaluation
Synthetic scenes (rendered moving boxes/people-shaped blobs): correct person locked; no ID swap when paths cross; survives N-frame occlusion; `lost` fires at the right time; `cancel` clears state; click in empty space handled. `python3 -m unittest discover -s tracker-sidecar/tests -v`.

## Out of scope / data safety
No face recognition or persistent embeddings; appearance data lives only in process memory and is wiped on cancel/idle/restart. No generic-object tracking. No disk/log persistence of crops. Synthetic fixtures only.
