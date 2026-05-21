export function applyCurve(raw: number): number {
  // Quadratic curve: preserves sign, squares the magnitude
  // Gives finer control at low speeds, still reaches full speed
  const sign = raw >= 0 ? 1 : -1;
  return sign * Math.pow(Math.abs(raw), 1.5);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function applyDeadzone(value: number, deadzone = 0.12): number {
  if (Math.abs(value) < deadzone) return 0;
  // rescale so output starts at 0 past deadzone
  const sign = value >= 0 ? 1 : -1;
  return sign * (Math.abs(value) - deadzone) / (1 - deadzone);
}
