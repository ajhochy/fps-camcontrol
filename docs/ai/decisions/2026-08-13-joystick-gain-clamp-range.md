---
type: project
---

# 2026-08-13 — Joystick gain is operator-configurable, clamped to 1..1000

## Context

`pi-bridge/drivers/dji_rs_driver.py` hardcoded `MAX_JOYSTICK = 80` — the joystick
magnitude sent at full stick deflection, and therefore the gimbal's top speed.
`systemd/dji-bridge@.service` documented a `DJI_RS3_MAX_JOYSTICK` override and all
three per-instance env files on the Pi set it to `200`, but nothing ever read the
variable. The operator's configured gain was silently ignored on every gimbal.

## Decision

The driver reads `DJI_RS3_MAX_JOYSTICK` **per instance** and clamps it to `1..1000`,
defaulting to `80`.

- **Per instance, not at import.** Each gimbal runs as its own templated systemd
  unit with its own env file. Freezing the value at module import would work today
  (one process per gimbal) but would silently leak one gimbal's setting into the
  others the moment anything hosts two drivers in one process.
- **Ceiling of 1000.** Bounded by the wire format, not taste: `_joystick_payload`
  encodes `CENTER + value` (CENTER = 1024) as an unsigned 16-bit little-endian
  word. A magnitude above 1024 makes negative full stick wrap past zero and command
  full speed in the *opposite* direction. 1000 keeps a margin under that and matches
  the range the service file already advertised.
- **Floor of 1.** `0` would make the gimbal unmovable while looking configured;
  negatives would invert every axis.
- **Clamp and warn, never fail.** A bad value must not stop a bridge from serving
  mid-service, but it must not be silent either — silent is the bug being fixed.
  Out-of-range and unparseable values log a `WARNING` naming the variable, the
  rejected value, and what was used instead.
- **Effective gain logged at `INFO` on startup**, with its source (env vs built-in
  default), so `journalctl -u dji-bridge@rs3` answers "what speed is this gimbal
  actually running at" without reading code or env files.

## Alternatives considered

- **Reject out-of-range values and exit.** Rejected: a typo in one env file would
  take a camera off-line during a service. Clamping degrades to a safe speed instead.
- **No upper bound.** Rejected: the wrap described above turns a typo into
  full-speed motion in the wrong direction on a live camera.
- **Accept floats.** Rejected: the payload is integral, and `int()` on `"200.5"`
  raising is a legitimate signal that the env file is wrong. It falls back to 80
  with a warning.

## Consequences

- Deploying to the Pi changes real gimbal speed immediately: the env files already
  say `200`, so all three gimbals will move ~2.5x faster than they do today. Deploy
  must be done with the operator watching camera video, starting small.
- `DjiRsDriver._joystick` is now an instance method rather than a `staticmethod`.
- Tuning speed is now an env-file edit plus a service restart, with no code change.
