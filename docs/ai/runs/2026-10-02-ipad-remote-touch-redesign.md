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
