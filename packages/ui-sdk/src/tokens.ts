/**
 * The theme tokens (08 §4.3 item 2, ADR 0003 decision 4): the paths an engine's
 * `theme/tokens.json` may set. `cc-build` compiles them to CSS custom properties in
 * `/theme.css` (`@cc/build`, which takes this list from here); a UI reads one with `token()`.
 * Tokens are colours, fonts, radius and density only.
 */

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

/** `color.textMuted` compiles to `--cc-color-text-muted`. */
export function cssVariableName(path: TokenPath): string {
  const kebab = path.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace('.', '-');
  return `--cc-${kebab}`;
}

/**
 * A theme token as a CSS value, for a style or a stylesheet: `token('color.accent')` is
 * `var(--cc-color-accent)`, so the engine's theme applies when the page loads `/theme.css`.
 */
export function token(path: TokenPath): string {
  return `var(${cssVariableName(path)})`;
}
