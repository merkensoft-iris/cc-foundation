/**
 * The engine extension API version (ADR 0003 decisions 1 and 2, owner decision D-2,
 * 10 Nov 2026). An engine's `cc.config.ts` declares `extensionApi: <int>`; the foundation
 * builds and starts engines on any version in `EXTENSION_API_SUPPORTED` (N−1 and N, 08 §4.3)
 * and `pnpm cc:upgrade` moves an engine to `EXTENSION_API_CURRENT`.
 *
 * The version is an independent integer, bumped only in a foundation major release and only
 * when an extension point breaks. A bump ships the `v<N>` entry points, turns the old ones
 * into a shim and adds the `<N−1>-to-<N>` codemod to `@cc/build`. API 1 is the first
 * version, so there is no N−1 yet.
 */
export const EXTENSION_API_CURRENT = 1;

/** The versions an engine may declare, oldest first: N−1 (once it exists) and N. */
export const EXTENSION_API_SUPPORTED: readonly number[] = [EXTENSION_API_CURRENT];
