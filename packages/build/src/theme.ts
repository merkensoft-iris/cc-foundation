/**
 * The engine's theme tokens (08 §4.3 item 2; ADR 0003 decision 4): `theme/tokens.json`, in a
 * DTCG-style nested shape, compiled at build time to CSS custom properties in
 * `cc-theme.css`, which the app serves as `/theme.css` from its own origin.
 *
 * The grammar is closed. Only the token paths below may be set, and each value must match its
 * group's pattern, so a token can never carry `url(`, `;`, `}`, `@import` or anything else
 * that escapes a custom property. Anything else fails the build with the token's path. Tokens
 * are colours, fonts, radius and density only; the layout is fixed (owner decision Q9).
 *
 * TODO(P1-18): the token list and grammar move to `@cc/schemas/engine/v1-tokens`, the entry
 * point engine widgets import (ADR 0003 decision 2); the cc-engine template keeps an interim
 * copy in `extension-api/v1/tokens.ts`, which this matches.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { THEME_CSS } from '@cc/build-runtime';

export { THEME_CSS };

export const TOKENS_FILE = 'theme/tokens.json';

export const TOKEN_PATHS = [
  'color.background',
  'color.surface',
  'color.text',
  'color.textMuted',
  'color.border',
  'color.accent',
  'color.accentText',
  'color.success',
  'color.warning',
  'color.danger',
  'font.body',
  'font.heading',
  'font.mono',
  'radius.small',
  'radius.medium',
  'radius.large',
  'density.scale',
] as const;

export type TokenPath = (typeof TOKEN_PATHS)[number];
type TokenGroup = TokenPath extends `${infer G}.${string}` ? G : never;

const FAMILY = String.raw`(?:"[A-Za-z0-9 _-]{1,64}"|[A-Za-z][A-Za-z0-9 -]{0,63})`;

/** The closed value grammar per group. */
export const TOKEN_VALUE_PATTERNS: Readonly<Record<TokenGroup, RegExp>> = {
  // #rgb, #rrggbb or #rrggbbaa
  color: /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/,
  // Locally installed family names only: the renderer loads no remote content (04 §3).
  font: new RegExp(`^${FAMILY}(?:\\s*,\\s*${FAMILY})*$`),
  // 0, or a length in px or rem
  radius: /^(?:0|\d{1,3}(?:\.\d{1,3})?(?:px|rem))$/,
  density: /^(?:compact|comfortable|spacious)$/,
};

/** `color.textMuted` compiles to `--cc-color-text-muted`. */
export function cssVariableName(path: TokenPath): string {
  const kebab = path.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace('.', '-');
  return `--cc-${kebab}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export type CompiledTheme =
  | { readonly ok: true; readonly css: string; readonly tokens: number }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Compiles a parsed `tokens.json` to CSS, or lists every problem with its token path. */
export function compileTokens(tokens: unknown): CompiledTheme {
  if (!isRecord(tokens)) return { ok: false, problems: [`${TOKENS_FILE} is not a JSON object`] };
  const problems: string[] = [];
  const lines: string[] = [];
  const known = new Set<string>(TOKEN_PATHS);
  for (const [group, entries] of Object.entries(tokens)) {
    if (group === '$schema' || group === '$description') continue;
    if (!isRecord(entries)) {
      problems.push(`${TOKENS_FILE}: ${group} is not a token group`);
      continue;
    }
    for (const [name, token] of Object.entries(entries)) {
      const path = `${group}.${name}`;
      if (!known.has(path)) {
        problems.push(`${TOKENS_FILE}: ${path} is not a theme token (see TOKEN_PATHS)`);
        continue;
      }
      const value = isRecord(token) ? token['$value'] : undefined;
      const extra = isRecord(token)
        ? Object.keys(token).filter((key) => key !== '$value' && key !== '$description')
        : [];
      const pattern = TOKEN_VALUE_PATTERNS[group as TokenGroup];
      if (typeof value !== 'string' || extra.length > 0 || !pattern.test(value)) {
        problems.push(
          `${TOKENS_FILE}: ${path} must be { "$value": "<${group} value>" } matching ${String(pattern)}`,
        );
        continue;
      }
      lines.push(`  ${cssVariableName(path as TokenPath)}: ${value};`);
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  const body = lines.length === 0 ? '' : `:root {\n${lines.join('\n')}\n}\n`;
  return {
    ok: true,
    css: `/* Compiled from ${TOKENS_FILE} by cc-build; do not edit. */\n${body}`,
    tokens: lines.length,
  };
}

/** Reads and compiles the engine's tokens; an engine without the file gets the defaults. */
export function compileEngineTheme(root: string): CompiledTheme {
  const path = join(root, TOKENS_FILE);
  if (!existsSync(path)) return compileTokens({});
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, problems: [`${TOKENS_FILE} is not valid JSON: ${detail}`] };
  }
  return compileTokens(parsed);
}
