# T5 — `TrackingClient` + sidecar protocol + virtual sidecar

**Labels:** `feature`, `tracking`, `protocol` · **Size:** M · **Depends on:** T1 · **Plan:** `docs/ai/current-plan.md`

## Goal
A WebSocket client for the tracker sidecar (handshake, reconnect/backoff, heartbeat, strict message validation) and a scripted fake sidecar for tests. **This issue freezes the v1 protocol** that T7–T9 implement.

## Context
`src/devices/djiBridgeDevice.ts` and `pi-bridge/dji_bridge.py` already implement this pattern (hello/capabilities, pings, reconnect backoff). Reuse its shape and conventions, not its code. Protocol (from the plan):

- App → sidecar: `hello`, `configure {sources:[{sourceId, frameUrl}]}`, `select {sourceId, x, y}`, `cancel {sourceId}`, `ping`
- Sidecar → app: `hello {version, capabilities:["person"], detector}`, `track {sourceId, state, cx, cy, w, h, conf, frameTs, processedAt}` with `state ∈ locking|tracking|lost|idle`, geometry normalized 0–1 in frame space, `pong`, `error {code, message}`

## Likely files
- `src/tracking/trackingClient.ts` (new)
- `src/tracking/protocol.ts` (new; types + zod validators — `zod` is already a dependency)
- `src/testing/virtualTrackingSidecar.ts` (new)
- `docs/ai/current-plan.md` (paste the final frozen schema into the protocol section)

## Acceptance criteria
1. Client connects lazily only when tracking is enabled; reconnects with capped exponential backoff + jitter; surfaces `connected/disconnected` events.
2. Every inbound message is validated; malformed, oversized, unknown-type, or out-of-range (`cx`,`cy` outside 0–1, NaN) messages are dropped and counted, never forwarded, never crash the client.
3. `track` for an unconfigured `sourceId` is ignored.
4. Heartbeat: missing `pong` for N seconds ⇒ treated as disconnected (manager's stale logic then stops the gimbal).
5. `configure` is re-sent after every reconnect, and any active `select` is **not** silently replayed (operator must re-select after a sidecar restart).
6. Virtual sidecar can: complete handshake, emit a scripted `track` sequence, go silent, drop the connection, and send malformed frames.
7. Protocol schema is versioned (`protocol: 1`) and documented in the plan.

## Tests / evaluation
Smoke: handshake; scripted sequence delivered in order; reconnect after drop; malformed-message table; silence ⇒ disconnect detection. `pnpm build`; `STATUS_PORT=<free> pnpm test:smoke`.

## Out of scope / data safety
No frame bytes ever cross this socket (the sidecar pulls frames itself). Bind/connect to loopback by default; refuse non-loopback `sidecarUrl` unless an explicit override is set. No logging of message payloads beyond type, sourceId, and state.
