/**
 * Reading the engine's `cc.config.ts` (08 §4.3 item 1).
 *
 * - `readExtensionApi` reads `extensionApi: <int>` from the source without running it
 *   (ADR 0003, "read from the AST"), for `cc:upgrade` and the build's first check.
 * - `loadEngineConfig` imports the file and returns its default export as JSON, which the
 *   build writes into the app as `cc.config.json`, so main reads JSON only at start. Node's
 *   built-in type stripping loads the TypeScript (Node 22.18 and later; ADR 0003 names it as
 *   the alternative to an esbuild bundle, which this avoids as a dependency).
 *
 * The full cc.config schema (modules, vocabulary, framework parameters, the calendar
 * mapping; ADR 0003 decision 3) is P1-18's extension API skeleton in `@cc/schemas`; until it
 * lands, `validateEngineConfig` checks only the shape and the version.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CONFIG_FILE = 'cc.config.ts';

/** The value of `extensionApi` in a `cc.config.ts` source, or an error. */
export function readExtensionApi(
  source: string,
): { readonly api: number } | { readonly error: string } {
  // A property `extensionApi: <integer>`; comments are removed first so a commented-out
  // line does not count.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const matches = [...code.matchAll(/(?:^|[{,\s])['"]?extensionApi['"]?\s*:\s*([^,}\s]+)/g)];
  if (matches.length === 0) {
    return { error: `${CONFIG_FILE} has no extensionApi; add extensionApi: <N> to its config` };
  }
  if (matches.length > 1) return { error: `${CONFIG_FILE} sets extensionApi more than once` };
  const value = matches[0]?.[1] ?? '';
  if (!/^\d+$/.test(value)) {
    return { error: `${CONFIG_FILE}: extensionApi must be a literal integer (found ${value})` };
  }
  return { api: Number(value) };
}

export function readEngineExtensionApi(
  root: string,
): { readonly api: number } | { readonly error: string } {
  const path = join(root, CONFIG_FILE);
  if (!existsSync(path)) return { error: `no ${CONFIG_FILE} in ${root}` };
  return readExtensionApi(readFileSync(path, 'utf8'));
}

let loads = 0;

/** Imports `cc.config.ts` and returns its default export. */
export async function loadEngineConfig(root: string): Promise<unknown> {
  const url = pathToFileURL(join(root, CONFIG_FILE));
  // A fresh module each time, so a long-lived process (tests, Rebuild now) sees edits.
  url.searchParams.set('cc-config', String((loads += 1)));
  const module = (await import(url.href)) as { default?: unknown };
  return module.default;
}

/**
 * Checks the loaded config. Returns the problems found; empty when it is valid.
 * TODO(P1-18): replace with the zod `strictObject` per API version from `@cc/schemas`.
 */
export function validateEngineConfig(value: unknown, api: number): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [`${CONFIG_FILE} must export default a config object`];
  }
  const record = value as Record<string, unknown>;
  const problems: string[] = [];
  if (record.extensionApi !== api) {
    problems.push(`${CONFIG_FILE}: the exported extensionApi does not match its source`);
  }
  try {
    JSON.stringify(value);
  } catch (error) {
    problems.push(`${CONFIG_FILE}: the config is not plain data (${String(error)})`);
  }
  return problems;
}
