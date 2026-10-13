# Decisions: iPad remote control, who wins and how it is served

**Date:** 2026-10-01
**Status:** Decided (draft PR; real-device test pending)
**Plan:** `docs/ai/plans/2026-10-01-ipad-gamepad-remote.md`

## 1. The desk always wins

A remote (iPad) must claim control explicitly, and any active input on the desk controller takes control back at
once. The desk operator watches program video directly and is the safety fallback, so a stray iPad nudge must not
steal a shot; last-active-wins would allow exactly that. A remote can claim only when remote control is switched on,
no other remote owns, and the desk controller has been still for 1.5 s. One remote owns at a time; a second page can
watch. Every ownership change goes through `ControlStateMachine.switchSource()`, which stops the camera immediately
and seeds the edge state so a button held across the handover does not fire.

Alternatives rejected: last-active-wins (steals shots), a lock the desk must release (the desk is the fallback and
should never wait), remotes stealing from each other (no use case; v1 keeps one owner).

## 2. HTTP in v1, Tailscale Serve for HTTPS

The browser Gamepad API no longer needs a secure context (the W3C spec dropped `[SecureContext]`; WebKit only ever
warned), so the remote works on plain `http://` over the LAN or tailnet. What needs HTTPS is the Screen Wake Lock,
which keeps the iPad from locking mid-service. For that, the operator runs `tailscale serve` (documented in
`docs/ipad-remote.md`); the app stays on plain HTTP behind it and the page picks `wss:` from its own address.

Alternatives rejected: mkcert or self-signed certificates (a root profile has to be installed and trusted on the iPad,
and renewed), a separate reverse proxy (another moving part on a show machine).

## 3. Safety is layered and server-side first

Safari suspends scripts when a page is hidden or the iPad locks, so the page cannot be the guarantee. The server
stops the camera 250 ms after the last frame (the machine's existing stale-input window), releases the seat after 1 s
of silence, drops half-open sockets with a ping/pong, and stops at once on close, idle, release, STOP, disable and
desk override. The page adds a neutral frame and an `idle` message on hide, blur and pad loss, and never resumes
control by itself.
