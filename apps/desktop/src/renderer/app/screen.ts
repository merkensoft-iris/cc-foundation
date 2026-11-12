/**
 * What every screen is given and what it provides. A screen loads its state through the local
 * API as the user (`window.cc.invoke`, 04 §4.3 rule 1) and renders it to a view tree; its
 * handlers change the state and ask for a render, or call the API and reload.
 */
import type { CcError } from '../bridge.js';
import type { VNode } from '../ui/vnode.js';
import type { AppRoute } from './routes.js';

export interface Ui {
  /** One local API call as the user. Rejects with a `CcError`. */
  call<T>(method: string, params?: unknown): Promise<T>;
  /** Opens a screen. */
  go(route: AppRoute): void;
  /** Loads the current screen's state again, keeping the route. */
  reload(): Promise<void>;
  /** Renders the current state again, after a handler changed it. */
  render(): void;
  /** A short message under the header: what an action did, or why it failed. */
  flash(message: string, kind?: 'ok' | 'error'): void;
  /** Milliseconds since the epoch; tests pass a fixed clock. */
  now(): number;
  /**
   * A value the app keeps for this window across reloads and screen changes, such as typed
   * notes and chosen filters; `init` makes it the first time.
   */
  keep<T extends object>(key: string, init: () => T): T;
}

export interface Screen<S> {
  load(ui: Ui, route: AppRoute): Promise<S>;
  view(state: S, ui: Ui, route: AppRoute): VNode;
}

export function isCcError(value: unknown): value is CcError {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value;
}

/** The message a failed call shows: the API's message, or a fallback. */
export function errorText(error: unknown): string {
  if (isCcError(error)) return error.message;
  return error instanceof Error ? error.message : 'Something went wrong';
}

/**
 * Runs an action: calls `run`, flashes `done` when it succeeds or the error when it fails,
 * and reloads the screen either way, so it shows the records as they now are. Resolves to
 * whether it succeeded, so a form can keep what was typed when it did not.
 */
export async function act(ui: Ui, run: () => Promise<unknown>, done: string): Promise<boolean> {
  let ok: boolean;
  try {
    await run();
    ui.flash(done, 'ok');
    ok = true;
  } catch (error) {
    ui.flash(errorText(error), 'error');
    ok = false;
  }
  await ui.reload();
  return ok;
}
