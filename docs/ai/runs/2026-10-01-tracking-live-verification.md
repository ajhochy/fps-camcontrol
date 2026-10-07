---
date: 2026-10-01
repo: fps-camcontrol
branch: codex/electron-tracking
pr: pending
issues: [34, 35, 51]
status: MANUAL_PENDING
tags: [run, fps-camcontrol]
index: "[[fps-camcontrol]]"
---

# Physical tracking drill — not performed

No physical rig, consenting on-camera subject, or clean macOS environment was
used during this delivery. An operator must watch video, keep gimbals within good
BLE range and have an immediate physical/software stop. Do not run unattended.
Automated virtual tests and model inference do not satisfy any row below.

| Human step | Result | Required observation |
| --- | --- | --- |
| Small-deflection gain and direction check | MANUAL_PENDING | Verify actual gain and pan/tilt signs before tracking |
| Calibration N trials | MANUAL_PENDING | Record delay, spread, measured scale/rate and recommended gains |
| Track at default cap 0.35 | MANUAL_PENDING | Begin lower; no unexpected acceleration or oscillation |
| Stick override and explicit Resume | MANUAL_PENDING | Stop precedes manual motion; neutral never auto-resumes |
| Emergency stop mid-track | MANUAL_PENDING | All motion stops and target is cleared |
| Kill sidecar mid-track | MANUAL_PENDING | Gimbal stops within approximately 0.5–1 s; no replay |
| BLE range loss / gimbal power-off | MANUAL_PENDING | Stop/clear; returning connection never resumes target |
| Stale Sony video | MANUAL_PENDING | Motion stops on stale receipt; no stale prediction refresh |
| Target exits frame | MANUAL_PENDING | Stop, hold, then idle without identity switch |
| 30-minute idle soak | MANUAL_PENDING | Record actual production-loop timing and disconnects |
| 30-minute active-tracking soak | MANUAL_PENDING | Operator watches continuous motion/stops and identity |
| Real sleep/wake and physical HID/TCC | MANUAL_PENDING | No motion replay; permissions and HID work on real Mac |
| Clean compatible Mac, no developer tools | MANUAL_PENDING | Both installed final notarized DMGs open offline |

## Physical calibration results

| Metric | Value |
| --- | --- |
| Operator/date/hardware/gain | NOT_TESTED |
| Trials and median/spread delay | NOT_TESTED |
| Pixel rate / calibrated angular scale | NOT_TESTED |
| Recommended pipelineDelayMs/kp/kd | NOT_TESTED |

Record measurements here only after a human-run drill. Do not attach footage or
screenshots containing identifiable people; use consenting subjects and redact
captures if evidence is necessary. Failed steps block live use, not reporting.
