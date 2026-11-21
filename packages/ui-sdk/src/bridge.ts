/**
 * `window.cc`, the app UI's only way out (04 §3): the preload exposes it through
 * `contextBridge`, and main answers it (`apps/desktop/src/main/ipc.ts`). These types are the
 * contract between the app shell and any UI that runs in its window, the default UI or an
 * engine's own (ADR 0008 decision 1).
 */

/** A local API error as the window receives it (04 §4.1 rule 4, 07 §4.4). */
export interface CcError {
  readonly code: string;
  readonly message: string;
  readonly help: readonly string[];
}

/** Where a `commandcenter://` deep link points (main parses and validates it first). */
export type Route =
  | { readonly kind: 'home' }
  | {
      readonly kind: 'items' | 'confirmations' | 'requests' | 'meeting';
      readonly target: string;
    };

/** How the app started: normal, or developer mode with its reasons (ADR 0004 decision 7). */
export type StartMode =
  { readonly kind: 'normal' } | { readonly kind: 'developer'; readonly reasons: readonly string[] };

export interface ShellInfo {
  readonly mode: StartMode;
  readonly version: string;
  /**
   * The extension API version of this `window.cc` (08 §4.3, ADR 0003 decision 1): the UI
   * contract version the shell speaks. A UI built on `@cc/ui-sdk/v<N>` checks it with
   * `apiVersionProblem`.
   */
  readonly apiVersion: number;
}

/** The Rebuild now offer, as main sends it (`apps/desktop/src/main/rebuild-offer.ts`). */
export type RebuildState =
  | { readonly kind: 'none' }
  | { readonly kind: 'offered'; readonly reason: string; readonly deferred: boolean }
  | { readonly kind: 'building' }
  | { readonly kind: 'failed'; readonly reason: string; readonly log: string | null }
  | { readonly kind: 'waiting-for-idle'; readonly busy: readonly string[] }
  | { readonly kind: 'restarting' };

export interface CcBridge {
  /**
   * One local API call as the user. Main passes only the methods marked `ui` in @cc/schemas
   * (ADR 0003 decision 9); any other rejects with E_FORBIDDEN or E_USAGE. Rejects with a
   * `CcError`. `createClient` wraps it in the typed client.
   */
  invoke(method: string, params?: unknown): Promise<unknown>;
  /** The shell's mode, version and `window.cc` API version. */
  shell(): Promise<ShellInfo>;
  /** Deep links opened while the app runs; returns an unsubscribe function. */
  onNavigate(listener: (route: Route) => void): () => void;
  /** Rebuild now (`now`), Later (`later`), or the current offer (`state`) (04 §10 rule 2). */
  rebuild(action: 'state' | 'now' | 'later'): Promise<RebuildState>;
  /** Changes to the offer; returns an unsubscribe function. */
  onRebuildState(listener: (state: RebuildState) => void): () => void;
}

/** Whether a rejection is a local API error (`CcError`). */
export function isCcError(value: unknown): value is CcError {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value;
}
