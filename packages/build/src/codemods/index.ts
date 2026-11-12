/**
 * The codemods `pnpm cc:upgrade` chains (ADR 0003 decision 6): one per extension API step,
 * `<n>-to-<n+1>.ts`, added in the foundation major that bumps the API, with a fixture test
 * against an engine at API n. Extension API 1 is the first version, so there are none yet.
 */
import type { Codemod } from '../codemod.js';

export const CODEMODS: readonly Codemod[] = [];
