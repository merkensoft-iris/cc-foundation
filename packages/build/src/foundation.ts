/**
 * What this foundation is: its version (every `@cc/*` package has the same one, 08 §3) and
 * the extension API versions it builds (ADR 0003 decision 1).
 */
import { readFileSync } from 'node:fs';

import { EXTENSION_API_CURRENT, EXTENSION_API_SUPPORTED } from '@cc/schemas';

import { compileEngineTheme, type CompiledTheme } from './theme.js';

export interface Foundation {
  /** The foundation version: the version of every `@cc/*` package. */
  readonly version: string;
  /** Extension API N. */
  readonly api: number;
  /** The versions an engine may declare: N−1 (once it exists) and N. */
  readonly supported: readonly number[];
  /**
   * Compiles the engine's `theme/tokens.json` under this foundation's token grammar. A
   * foundation without one (the test fixtures at other API versions) packs no theme.
   */
  readonly theme?: (root: string) => CompiledTheme;
}

/** This package's version, read from its package.json (the same in `src/` and `dist/`). */
export function foundationVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as {
    version: string;
  };
  return manifest.version;
}

export function currentFoundation(): Foundation {
  return {
    version: foundationVersion(),
    api: EXTENSION_API_CURRENT,
    supported: EXTENSION_API_SUPPORTED,
    theme: compileEngineTheme,
  };
}

export type ApiVerdict =
  | { readonly kind: 'current' }
  | { readonly kind: 'deprecated'; readonly message: string }
  | { readonly kind: 'unsupported'; readonly message: string };

/**
 * Judges an engine's `extensionApi` against the foundation, with messages that say what to
 * do (ADR 0003 decision 1).
 */
export function judgeExtensionApi(api: number, foundation: Foundation): ApiVerdict {
  const oldest = Math.min(...foundation.supported);
  if (api === foundation.api) return { kind: 'current' };
  if (foundation.supported.includes(api)) {
    return {
      kind: 'deprecated',
      message:
        `cc.config.ts: extension API ${api} is deprecated in foundation ${foundation.version} ` +
        `and removed at the next API version; run pnpm cc:upgrade`,
    };
  }
  if (api > foundation.api) {
    return {
      kind: 'unsupported',
      message:
        `cc.config.ts: extension API ${api} is newer than foundation ${foundation.version} ` +
        `supports (${foundation.api}); set extensionApi to ${foundation.api}, or install the ` +
        `foundation release that introduced API ${api}`,
    };
  }
  return {
    kind: 'unsupported',
    message:
      `cc.config.ts: extension API ${api} is no longer supported by foundation ` +
      `${foundation.version} (supported: ${foundation.supported.join(', ')}); upgrade one ` +
      `foundation major at a time and run pnpm cc:upgrade after each, oldest supported ` +
      `API ${oldest}`,
  };
}
