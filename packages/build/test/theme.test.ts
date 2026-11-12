/**
 * The engine's theme tokens compiled into the app (08 §4.3 item 2; ADR 0003 decision 4): a
 * closed grammar, so no token can escape its CSS custom property.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runBuild } from '../src/build.js';
import { compileTokens, cssVariableName, THEME_CSS } from '../src/theme.js';
import { createEngine, write, type EngineFixture } from './engine-fixture.js';

const passingTypecheck = () => Promise.resolve({ ok: true, output: '', ms: 0 });

describe('theme tokens (ADR 0003 decision 4)', () => {
  it('compiles the nested tokens to --cc-* custom properties', () => {
    const compiled = compileTokens({
      $schema: '../extension-api/v1/tokens.schema.json',
      color: {
        accent: { $value: '#0b6e4f', $description: 'Buttons and links' },
        textMuted: { $value: '#666' },
      },
      font: { body: { $value: '"Inter", system-ui, sans-serif' } },
      radius: { medium: { $value: '8px' } },
      density: { scale: { $value: 'comfortable' } },
    });
    expect(compiled).toEqual({
      ok: true,
      tokens: 5,
      css: [
        '/* Compiled from theme/tokens.json by cc-build; do not edit. */',
        ':root {',
        '  --cc-color-accent: #0b6e4f;',
        '  --cc-color-text-muted: #666;',
        '  --cc-font-body: "Inter", system-ui, sans-serif;',
        '  --cc-radius-medium: 8px;',
        '  --cc-density-scale: comfortable;',
        '}',
        '',
      ].join('\n'),
    });
    expect(cssVariableName('color.accentText')).toBe('--cc-color-accent-text');
  });

  it.each([
    ['a value that escapes the property', { color: { accent: { $value: 'red; } body { x: y' } } }],
    ['a remote resource', { font: { body: { $value: 'url(https://example.invalid/f.woff)' } } }],
    ['an @import', { font: { body: { $value: '@import "x"' } } }],
    ['a length unit outside the grammar', { radius: { small: { $value: '10vw' } } }],
    ['a token the foundation does not declare', { color: { primary: { $value: '#000' } } }],
    ['a layout token (the layout is fixed, Q9)', { spacing: { gutter: { $value: '8px' } } }],
    ['a bare value instead of { $value }', { color: { accent: '#0b6e4f' } }],
    ['an extra key', { color: { accent: { $value: '#000', $type: 'color' } } }],
  ])('refuses %s', (_name, tokens) => {
    const compiled = compileTokens(tokens);
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) expect(compiled.problems[0]).toMatch(/^theme\/tokens\.json: /);
  });

  describe('in cc-build build', () => {
    let engine: EngineFixture;
    beforeEach(() => (engine = createEngine()));
    afterEach(() => engine.cleanup());

    it('writes cc-theme.css into the app, and a bad token fails the build and the check', async () => {
      const ok = await runBuild({ root: engine.root, package: false, typecheck: passingTypecheck });
      expect(ok.exitCode, ok.lines.join('\n')).toBe(0);
      expect(readFileSync(join(engine.root, 'dist', '.stage', THEME_CSS), 'utf8')).toContain(
        '--cc-color-accent: #0b6e4f;',
      );

      rmSync(join(engine.root, 'dist'), { recursive: true });
      write(engine.root, 'theme/tokens.json', '{ "color": { "accent": { "$value": "url(x)" } } }');
      for (const checkOnly of [false, true]) {
        const bad = await runBuild({ root: engine.root, checkOnly, typecheck: passingTypecheck });
        expect(bad.exitCode).toBe(1);
        expect(bad.lines.join('\n')).toContain('theme/tokens.json: color.accent must be');
      }
      expect(existsSync(join(engine.root, 'dist'))).toBe(false);
    });

    it('an engine without theme/tokens.json gets the foundation defaults', async () => {
      rmSync(join(engine.root, 'theme'), { recursive: true });
      const ok = await runBuild({ root: engine.root, package: false, typecheck: passingTypecheck });
      expect(ok.exitCode, ok.lines.join('\n')).toBe(0);
      expect(readFileSync(join(engine.root, 'dist', '.stage', THEME_CSS), 'utf8')).toBe(
        '/* Compiled from theme/tokens.json by cc-build; do not edit. */\n',
      );
    });
  });
});
