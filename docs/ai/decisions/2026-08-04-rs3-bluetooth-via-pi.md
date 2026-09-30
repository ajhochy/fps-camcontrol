# Decision: Control the DJI RS3 over Bluetooth via Raspberry Pi

**Date:** 2026-08-04
**Status:** Decided

## Context

The project had selected a PiCAN3/SocketCAN bridge because DJI Bluetooth control
was believed closed and unavailable. A live spike against the existing
[`jdesbonnet/dji_rs3_control`](https://github.com/jdesbonnet/dji_rs3_control)
tool disproved that assumption on a physical DJI RS3.

## Live findings

Test environment: macOS, Python 3.12 virtual environment, `bleak` 3.0.2, DJI
Ronin app closed, device `DJI RS3-06UH13`.

- BLE discovery and connection succeeded.
- Notifications subscribed on `0000fff4-0000-1000-8000-00805f9b34fb`.
- Raw `0d/02` telemetry streamed reliably.
- Passive state subscription timed out waiting for decoded pose.
- Active polling returned decoded `04/66` pose telemetry in degrees.
- Joystick-style commands produced visible, bidirectional pan, tilt, and roll.
- Positive and negative tests at 40 units for 0.5 seconds stopped cleanly via
  neutral frames; each CLI session then disconnected cleanly.

The spike validates RS3 BLE feasibility. It does **not** establish RS4/RS4 Pro
compatibility, Raspberry Pi OS behavior, long-run reliability, or licensing
permission to copy/vendor the reference implementation.

## Decision

Use **Bluetooth Low Energy from the Raspberry Pi** for real RS3 control.

Keep the existing architecture from the app through the WebSocket Pi bridge.
Replace only the bridge's real hardware driver transport: implement a
BLE-backed adapter for the existing `GimbalDriver` contract using active pose
polling and neutral stop frames. The CAN/PiCAN3 implementation becomes a
fallback rather than the primary path.

## Consequences

- PiCAN3, RSA pigtail, CAN wiring, and a DJI Device ID are not required for the
  primary RS3 path.
- The target Pi needs working BLE and Python `bleak` support.
- The DJI Ronin app must not compete for the gimbal connection during control.
- BLE reconnect and the existing 250 ms motion watchdog must be proven on Pi.
- Pin the external project's tested revision and confirm its license before
  reusing source; otherwise implement from its published protocol documentation.
- `docs/pi-implementation.md` remains a CAN fallback guide until a separate BLE
  implementation update is assigned.
