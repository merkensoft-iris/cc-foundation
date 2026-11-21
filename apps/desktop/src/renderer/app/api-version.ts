/**
 * The `window.cc` API version this UI is built for (08 §4.3, ADR 0008 decision 1): the
 * version of `@cc/ui-sdk/v1`, whose `ApiVersion` type keeps the number honest. A shell that
 * speaks another version gets the reason on screen instead of calls whose shapes the UI does
 * not know. The SDK's `apiVersionProblem` says the same; the renderer keeps its own copy until
 * it is bundled (rule D3, P1-25).
 */
import type { ApiVersion, ShellInfo } from '@cc/ui-sdk/v1';

export const API_VERSION: ApiVersion = 1;

/** Why this UI cannot run on `shell`, or `undefined` when it can. */
export function apiVersionProblem(shell: Pick<ShellInfo, 'apiVersion'>): string | undefined {
  if (shell.apiVersion === API_VERSION) return undefined;
  return `This app's UI was built for window.cc API ${String(API_VERSION)}, but the app shell speaks API ${String(shell.apiVersion)}. Rebuild the app from your engine (pnpm cc:upgrade, then pnpm build).`;
}
