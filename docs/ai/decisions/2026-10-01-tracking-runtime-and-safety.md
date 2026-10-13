---
date: 2026-10-01
repo: fps-camcontrol
tags: [decision, fps-camcontrol]
index: "[[fps-camcontrol]]"
---

# Tracking runtime and motion ownership

## Context
The second installer must implement real tracking without altering the frozen
manual artifact or depending on host Python. Physical rig access is unavailable.

## Decision
Bundle pinned standalone CPython3.12.14, ARM64 wheels and checksum-verified
OpenCV Zoo YOLOX-s weights with exact redistribution notices. NumPy's inspected
Accelerate build raises only the tracking minimum to macOS14. Runtime downloads
and host pip are absent. Separate appID/userData and shared kernel hardware leases
allow installation side-by-side, not concurrent production motion ownership.

One backend MotionLedger arbitrates manual, tracking and capped calibration
through normal MotionDevice methods. Calibration owns an800ms/backend-timed0.1
step; the CLI never connects independently to hardware. Shared frame-only and
WS credentials are distinct from the operator session and never go into URLs.

## Alternatives considered
Host Python/pip is incompatible with clean-Mac launch. An unknown/AGPL model or
silent downloader is unacceptable. A separate calibration hardware client could
fight the app's motion owner. Redesigning controllers or opening more PRs is
outside the requested packaging-first scope.

## Consequences
The tracking installer is larger and requires macOS14; manual stays macOS13.
Tracking is disabled by default. Simulations/real model execution establish code
behavior only; human rig calibration, supervised drills/soaks and cleanOS/TCC
are explicitly pending. A calibrated field of view is required for angular-rate
claims; absent that, calibration reports processed pixels/second.
