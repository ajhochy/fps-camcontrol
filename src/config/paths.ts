import path from 'path';

/**
 * Mutable operator data. This intentionally resolves on every call so tests
 * and embedded launches can select a home before the relevant consumer runs.
 * Resolving paths never creates the home or any files.
 */
export function getAppHome(): string {
  const configuredHome = process.env.CAMCONTROL_HOME;
  return configuredHome ? path.resolve(configuredHome) : process.cwd();
}

/** Resolve an app-owned mutable file beneath the selected app home. */
export function getUserPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error('getUserPath requires a relative path');
  return path.resolve(getAppHome(), relativePath);
}

/**
 * Resolve a packaged, read-only resource. Resources deliberately do not share
 * CAMCONTROL_HOME: an Electron bundle may live elsewhere from operator data.
 */
export function getResourcePath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error('getResourcePath requires a relative path');
  return path.resolve(process.env.CAMCONTROL_RESOURCES ?? process.cwd(), relativePath);
}
