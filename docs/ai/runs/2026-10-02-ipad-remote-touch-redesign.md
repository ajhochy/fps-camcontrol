---
date: 2026-10-02
repo: fps-camcontrol
branch: feat/ipad-remote-touch-redesign
pr: none yet (stacks on integration/combine-open-prs, PR #60)
issues: []
status: verified-sandbox, manual iPad check pending
tags: [run, fps-camcontrol]
index: "[[fps-camcontrol]]"
---

# iPad remote page: touch redesign for landscape iPad

## Files changed
- `ui/remote/index.html` — seat controls (Take control / Release / hint / wake hint) moved into the top bar next to
  the connection chip; controls bar is a `<footer>` with speed, TRANSITION, STOP; camera menu sheet unchanged
  (Close → Done). Every element ID `remote.js` reads is unchanged.
- `ui/remote/remote.css` — rewritten. Tokens on `:root` (`--arrow`, `--gap`), full-width multiview grid, 64 px glass
  arrow pads, big-pane health line between zoom and D-pad, camera menu as a right-hand drawer in landscape, portrait /
  phone fallback matching `RemoteModel.layoutFor`. Removed the stray `}` and duplicated media queries of the old file.
- `.claude/launch.json` — added a `sandbox` preview entry (`pnpm sandbox`, port 8090).
- `docs/ai/project-state.md` — snapshot entry.

## Checks run
- `CAMCONTROL_NO_CONTROLLER=1 pnpm sandbox:check` → `tsc` + 239/239 checks passed (includes the remote assets served /
  script-order check).
- Browser pane against the sandbox at 1180×820 (iPad landscape) and 820×1180 (portrait): panes, pads, PGM lock,
  track bar, top bar and control bar render; no console errors.

## Notes
- A right-hand control rail was tried first; the user rejected it (squashed the multiview). Replaced with a bottom bar.
- Self-test and the running sandbox cannot coexist (fixed VISCA port 52391) — stop the preview before `sandbox:check`.
- Not yet seen on a real iPad; Safari safe-area and `backdrop-filter` behaviour are the main things to eyeball.

## Second pass — `/impeccable:audit` fixes (same day)
Audit scored 12/20; the main finding was drift from `.impeccable.md` (pills, glass, soft radii, blue accent).
- `remote.css`: OKLCH tokens, amber `--accent` (status-LED) for seat/selection/held arrows/TRANSITION, state surfaces via
  `color-mix`, 3 px radii, pills → bordered panel cells with uppercase labels, solid `--plate` instead of `backdrop-filter`,
  no `#000`/`#fff`, no glow shadows, `:focus-visible`, `prefers-reduced-motion`, TRANSITION dim as a solid muted state,
  PGM header wraps ≤1100 px. Disabled Track / menu buttons stay legible (muted text) instead of 30 % opacity — the user
  had read the faded Track button as missing.
- `index.html`: `#banner` gets `role="status" aria-live="polite"`.
- `remote.js`: small panes are `role="button"`, focusable, Enter/Space select, `aria-label` "Select <rig> (tags)".
- Skipped: a condensed web font (network dependency in an offline booth; system font kept).
- `pnpm sandbox:check` 239/239 after the final edit.

## Third pass — interactive sandbox, joystick, Track speed slider, 16:9 panes (same day)
- Sandbox (`pnpm sandbox`) is demo-ready: `FakeAtemClient` in memory (`CAMCONTROL_FAKE_ATEM=1`), both powered Sony
  cameras approved/connected, remote control on. The fake Sony frame is a 16:9 scene (stage, drifting person, safe-area
  marks, slate) so the panes show real letterboxing. Self-test unchanged (it still checks the no-ATEM refusals).
- Page: PVW | PGM and the rig row are 16:9 (`#main` height from the viewport width, shrinks under the bar's 160 px
  minimum). Bottom bar: TRANSITION over STOP left, speed middle, a proportional joystick for the PREVIEW camera on the
  right (always right, also in portrait / phone). `RemoteModel.stickFrame` + 5 checks in `remoteUiModelTest`.
- Track speed: `tracking.speeds.<device>` (schema), `TrackingManager.setSpeed/speedOf`, `PUT /api/tracking/sources/:id/speed`
  (saves through `commitConfigEdit`, applies live to controller + VISCA driver), `maxSpeed` in `/api/tracking/status`;
  slider row in the camera menu for panes with a tracking source.
- Top bar: fixed-width state cells (no reflow when the text changes), hint sentence removed, 52 px.
- Checks: `pnpm sandbox:check` 239/239, trackingVisca 87, remoteUiModel 88, remoteFrame 36, remoteControl 76.

## Fourth pass — user feedback on the live sandbox (same day)
- On-pane arrow pads and the PGM lock removed (`buildTouchPad`, `arrowButton`, `startPress`, `markPressed` deleted);
  the joystick is the only touch drive and it moves the preview camera only. `RemoteModel.arrowFrame` and the PGM
  helpers stay in the model (tests still cover them) but the page no longer calls them.
- Banner moved into the top bar's free space (right-aligned, `clamp()` font, ellipsis): nothing reflows when it shows.
- Controller status cell removed; a Bluetooth icon button with a status light (grey / green / red) opens a drawer with
  pairing steps and the live pad status (`#padSheet`). The hint sentence is gone; the top bar is 52 px with fixed-width
  state cells.
- Portrait / phone keep the same bar order (TRANSITION/STOP left, speed middle, joystick right).

## Fifth pass — multiview readability (same day)
- PGM / PVW / CTL badges removed (preview is always the controlled camera; the border colour says the role). Small
  panes: `is-pgm` red / `is-pvw` green border.
- Header icons per pane from `RemoteModel.paneIndicators` (4 tests): head glyph + 3 signal bars coloured by the desk's
  link rules (`statusServer linkStatus`), head battery (DJI) and Sony camera battery as a battery glyph + %, <20 % amber,
  <10 % red; camera not connected = red camera + crossed bars. `/api/sony/status` polled every 10 s for the batteries.
- Rig name is a centred label on the pane's bottom line (Blackmagic multiview style); the health foot line is gone.
- Palette desaturated (ok / bad / accent chroma down) — less toy-like.
- Top right: Bluetooth button = controller drawer only; a ☰ button opens the app menu (`#menuSheet`, desk name).
- Zoom + / − column at the far left of the bar (hold; `arrowFrame` triggers merged into the joystick frame). Camera
  with unknown battery shows the glyph alone instead of an empty battery.
