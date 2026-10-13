# Local follow-up scope records — not dispatched

These preserve #35's local out-of-scope inventory. They do not replace defects
in this delivery with new tasks, create remote issues, or expand authorization.

## Tracking v2: multi-target / multi-class / auto-zoom

Problem: v1 intentionally assists one chosen person per configured source.
Acceptance for a separately approved future change: define identity and operator
ownership semantics first; add crossing/occlusion/unsafe reacquisition tests,
motion caps and a supervised physical safety drill. No face recognition implied.

## Remote access and remote input (#54–56)

Problem: local developer control routes are not suitable for LAN exposure.
Acceptance: authenticated identities, per-route authorization, CSRF/WS origin
checks and bounded remote input ownership; real second-device latency/drop test.
Do not expose the existing listener or modify live Tailscale mappings now.

## Update and diagnostics work (#48–49)

Problem: installers have separate identities but no automatic update mechanism.
Acceptance: variant-isolated signed feeds, explicit idle-only installation,
no motion replay, redacted diagnostics and version-to-version persistence tests.
No release publication, update feed or launch-at-login change in this delivery.

## Controller customization (#3–6) and broader open-source work (#52–53)

Explicitly excluded. Preserve current operator behavior. Bundled-component legal
notices are included, but artifact existence does not close these broader issues.
