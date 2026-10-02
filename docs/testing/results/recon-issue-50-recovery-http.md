# Tracking final-DMG recovery HTTP recon — 2026-10-01

The exact final notarized DMG (SHA256
5c021b66d2433df630677c4cab95fc3019e5617e134afc5dd094f967e4c81652)
completed installed UI click, genuine inference, explicit-stop and every owned
lifecycle assertion in both runs20-42-03-562Z and20-43-23-224Z. Both overall
results remain FAIL because a newly strict all-phase console-empty assertion
rejected two503 responses after explicit backend restart.

The second run recorded routes/phase without changing that assertion:

- Phase: `restart-after-backend-crash`.
- HTTP503 and matching browser resource-error messages on
  `/api/sony/cameras/AA:BB/properties` and
  `/api/sony/cameras/AA:BB/live-view/start`.
- Page JavaScript errors and failed network requests: both empty.

Existing source: SonyManager's per-camera operation lane rejects concurrent
operations with SonyRetryableError; statusServer serializes this as503,
`Retry-After`, and `Sony camera is busy; retry shortly`. The browser retries
properties and calls startSonyPreview again from its5-second Sony refresh.
This is intentional reconnect backpressure, not permission to ignore errors.

The subsequent assertion must inspect actual response body/header, exact local
fixture route and explicit recovery phase; only this identified503 can be
classified expected. It must retain all raw messages, reject any other HTTP,
console, page or transport error, and require the real decoded preview to
recover (not loading/stale) after restart before the next injected fault.
Negative fixtures reject wrong phase, status, route, host, missing Retry-After
and different error body. No shipping source or artifact bytes changed.

Run20-45-20 confirmed actual Retry-After1 and the exact busy error body, plus
successful preview recovery. It also captured an in-flight preview GET returning
net::ERR_CONNECTION_REFUSED immediately after the owned backend was SIGKILLed.
The subsequent test records the exact terminated backend origin and permits
only known GET polls with specific transport error codes in that deliberate
exit window; foreign origins/ports, healthy phases, POST/actions and ERR_FAILED
are rejected. Console classification must pair with the observed failed request.

Final exact-byte run20-47-24-065Z passed: one identified Sony busy retry and one
deliberately injected disconnect, no JS/unexpectedHTTP/console/transport errors,
and every decoded, non-stale preview recovered. All raw observations and failed
runs are retained. Independent reviewer approved both narrowly scoped classifiers.
