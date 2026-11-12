'use strict';
/**
 * One source for the package lists behind dependency rules D1-D7
 * (docs/design/08-repository-and-automation.md §4.2). Used by .dependency-cruiser.cjs,
 * eslint.config.js and the rule tests in scripts/test/.
 */

/**
 * AI SDKs no package in cc-foundation may import (D1): the list of 05 §12 plus maintained
 * additions. `@scope/*` means every package in the scope; `name*` every package whose name
 * starts with `name`; anything else is one package and its subpaths.
 */
const AI_SDK_PACKAGES = [
  // 05 §12
  '@anthropic-ai/*',
  'openai',
  '@google/genai',
  '@google/generative-ai',
  '@mistralai/*',
  'cohere-ai',
  'ollama',
  'langchain*',
  '@langchain/*',
  'ai',
  // maintained additions
  '@ai-sdk/*',
  '@openai/*',
];

/** AI CLIs no package in cc-foundation may start (D1). */
const AI_CLIS = ['claude', 'codex'];

/** Pure packages (D4): no I/O, no clock, no randomness. */
const PURE_PACKAGES = ['domain', 'frameworks', 'rhythm', 'policy'];

/** Internal packages the renderer may import (D3). */
const RENDERER_ALLOWED_PACKAGES = ['ui-sdk', 'schemas'];

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Regex source (no anchors) matching a module specifier of any AI SDK, at its start. */
const aiSdkSpecifier = AI_SDK_PACKAGES.map((entry) => {
  if (entry.endsWith('/*')) return `${escapeRegex(entry.slice(0, -1))}`;
  if (entry.endsWith('*')) return `${escapeRegex(entry.slice(0, -1))}[^/]*(?:/|$)`;
  return `${escapeRegex(entry)}(?:/|$)`;
}).join('|');

/** Regex source matching a bare AI SDK import specifier, for ESLint. */
const AI_SDK_IMPORT_REGEX = `^(?:${aiSdkSpecifier})`;

/**
 * Regex source matching a resolved AI SDK path, for dependency-cruiser: the bare specifier
 * when it does not resolve, or a path inside node_modules when it does.
 */
const AI_SDK_PATH_REGEX = `(?:^|/node_modules/)(?:${aiSdkSpecifier})`;

/**
 * Regex source matching an internal package by workspace path or by @cc/* specifier
 * (an unresolved specifier stays as written).
 */
const internalPackage = (names) =>
  `^(?:packages/(?:${names.join('|')})/|@cc/(?:${names.join('|')})(?:/|$))`;

/** Regex source matching any internal module: a workspace path or an @cc/* specifier. */
const ANY_INTERNAL = '^(?:apps/|packages/|@cc/)';

/** Regex source matching test code, which D4 and D7 do not restrict. */
const TEST_CODE = '(?:^|/)test/|\\.test\\.ts$';

module.exports = {
  AI_SDK_PACKAGES,
  AI_CLIS,
  PURE_PACKAGES,
  RENDERER_ALLOWED_PACKAGES,
  AI_SDK_IMPORT_REGEX,
  AI_SDK_PATH_REGEX,
  ANY_INTERNAL,
  TEST_CODE,
  internalPackage,
};
