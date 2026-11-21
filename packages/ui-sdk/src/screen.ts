/**
 * The screen contract (ADR 0008 decision 1): what every screen is given (`Ui`) and what it
 * provides (`Screen`). A screen loads its state through the local API as the user
 * (`window.cc.invoke`, 04 §4.3 rule 1) and renders it to a view; its handlers change the state
 * and ask for a render, or call the API and reload. The view type is the UI library's own:
 * the default UI renders `h` trees, an engine's UI whatever its library renders.
 */
import type { Client } from './client.js';
import type { AppRoute } from './routes.js';

export interface Ui extends Client {
  /** Opens a screen. */
  go(route: AppRoute): void;
  /** Loads the current screen's state again, keeping the route. */
  reload(): Promise<void>;
  /** Renders the current state again, after a handler changed it. */
  render(): void;
  /** A short message under the header: what an action did, or why it failed. */
  flash(message: string, kind?: 'ok' | 'error'): void;
  /**
   * Puts text on the clipboard, such as a command to paste elsewhere; resolves to whether it
   * worked. It needs no permission beyond the click that asks for it.
   */
  copy(text: string): Promise<boolean>;
  /** Milliseconds since the epoch; tests pass a fixed clock. */
  now(): number;
  /**
   * A value the app keeps for this window across reloads and screen changes, such as typed
   * notes and chosen filters; `init` makes it the first time.
   */
  keep<T extends object>(key: string, init: () => T): T;
}

export interface Screen<S, View> {
  load(ui: Ui, route: AppRoute): Promise<S>;
  view(state: S, ui: Ui, route: AppRoute): View;
}
