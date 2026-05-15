export interface EdgeState {
  prevButtons: Record<string, boolean>;
  prevTriggers: Record<string, number>;
}

export function createEdgeState(): EdgeState {
  return { prevButtons: {}, prevTriggers: {} };
}

export function risingEdge(
  name: string,
  current: boolean,
  state: EdgeState
): boolean {
  const prev = state.prevButtons[name] ?? false;
  state.prevButtons[name] = current;
  return current && !prev;
}

export function fallingEdge(
  name: string,
  current: boolean,
  state: EdgeState
): boolean {
  const prev = state.prevButtons[name] ?? false;
  state.prevButtons[name] = current;
  return !current && prev;
}

export function triggerRisingEdge(
  name: string,
  current: number,
  threshold: number,
  state: EdgeState
): boolean {
  const prev = state.prevTriggers[name] ?? 0;
  state.prevTriggers[name] = current;
  return current >= threshold && prev < threshold;
}
