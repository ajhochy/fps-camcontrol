/**
 * Presets are keyed by camera id (`cam1..camN`), and a camera id is a rig's position in the active profile.
 * Removing rig N therefore renumbers every later rig, so their presets must move with them or they would
 * silently attach to a different camera. Pure, so it can be tested without starting the app.
 */
export function shiftPresetsAfterRemoval<T>(data: Record<string, T>, removedPosition: number, totalBefore: number): Record<string, T> {
  const out: Record<string, T> = { ...data };
  for (let position = removedPosition; position < totalBefore; position++) {
    const next = data[`cam${position + 1}`];
    if (next === undefined) delete out[`cam${position}`];
    else out[`cam${position}`] = next;
  }
  delete out[`cam${totalBefore}`];
  return out;
}

/** Names of the preset slots that hold a position for one camera (e.g. ['A', 'X']). */
export function presetSlotsSet(entry: Record<string, unknown> | undefined): string[] {
  if (!entry) return [];
  return Object.entries(entry).filter(([, position]) => position !== null && position !== undefined).map(([slot]) => slot).sort();
}
