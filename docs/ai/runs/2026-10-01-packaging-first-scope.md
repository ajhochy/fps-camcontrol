# Packaging-first scope correction — 2026-10-01

AJ clarified: **“also why are we messing w/ controller? arent we just packaging the existing app in electron?”** The manager acknowledged the original broad “other issues” scope had pulled unrelated controller customization onto the delivery path.

## Current implementation priority

1. Package the existing non-tracking backend/UI as a standalone ARM64 Electron app. Preserve controller mappings, selection, response curves, camera protocols and existing operator behavior.
2. Fix only defects necessary for packaged resources, safe startup/shutdown, persistent configuration, no-tools first launch, desktop isolation and signing/notarization.
3. Add tracking on the verified packaging foundation as the second PR/artifact. Tracking is not yet implemented in this baseline.

Controller issues #3–6 are outside this packaging slice and must not be implemented, claimed fixed, or used as blockers for packaging. Their existing draft test/contract/notes are preserved but excluded from shipping acceptance and the completed-issues list. No user data or unrelated work is deleted.

## Evidence disposition

The native Electron probe and its failed timing measurements remain recorded. A synthetic idle zero-miss condition was imposed by the manager beyond issue #39's explicit measurement requirement. It is not proof that the production controller loop is defective and is not a prerequisite for building the packaging slice. This is a scope correction, not a passing timing result: preserve the failed assertions/raw data, do not alter thresholds, do not weaken production refresh/receiver-deadman protections, and do not claim production performance or issue #39 fully verified. Instrumentation is non-shipping evidence.

Final handoff still requires independent verification of the actual packaged app and honest distinction between hermetic developer-host checks and genuine clean-OS, hardware, Gatekeeper, and notarization evidence. Two final apps/two draft PRs are not delivered by the probe.
