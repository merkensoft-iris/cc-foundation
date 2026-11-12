/**
 * `window.cc`, the renderer's only way out (04 §3): the preload exposes it through
 * `contextBridge`. These types are the contract between the preload and the renderer; main's
 * side of it is `src/main/ipc.ts`.
 */

/** A local API error as the renderer receives it (04 §4.1 rule 4, 07 §4.4). */
export interface CcError {
  readonly code: string;
  readonly message: string;
  readonly help: readonly string[];
}

/** Where a deep link points (main parses and validates it first). */
export type Route =
  | { readonly kind: 'home' }
  | {
      readonly kind: 'items' | 'confirmations' | 'requests' | 'meeting';
      readonly target: string;
    };

export type StartMode =
  { readonly kind: 'normal' } | { readonly kind: 'developer'; readonly reasons: readonly string[] };

export interface ShellInfo {
  readonly mode: StartMode;
  readonly version: string;
}

/** The Rebuild now offer, as main sends it (`src/main/rebuild-offer.ts`). */
export type RebuildState =
  | { readonly kind: 'none' }
  | { readonly kind: 'offered'; readonly reason: string; readonly deferred: boolean }
  | { readonly kind: 'building' }
  | { readonly kind: 'failed'; readonly reason: string; readonly log: string | null }
  | { readonly kind: 'waiting-for-idle'; readonly busy: readonly string[] }
  | { readonly kind: 'restarting' };

export interface CcBridge {
  /** One local API call as the user. Rejects with a `CcError`. */
  invoke(method: string, params?: unknown): Promise<unknown>;
  /** The shell's mode and version. */
  shell(): Promise<ShellInfo>;
  /** Deep links opened while the app runs; returns an unsubscribe function. */
  onNavigate(listener: (route: Route) => void): () => void;
  /** Rebuild now (`now`), Later (`later`), or the current offer (`state`) (04 §10 rule 2). */
  rebuild(action: 'state' | 'now' | 'later'): Promise<RebuildState>;
  /** Changes to the offer; returns an unsubscribe function. */
  onRebuildState(listener: (state: RebuildState) => void): () => void;
}
