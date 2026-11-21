/**
 * The screen contract of `@cc/ui-sdk/v1` (ADR 0008 decision 1) as the default UI uses it: a
 * screen loads its state through the typed local API client as the user
 * (`window.cc.invoke`, 04 §4.3 rule 1) and renders it to an `h` view tree; its handlers change
 * the state and ask for a render, or call the API and reload.
 *
 * The renderer loads no package code at run time (rule D3; until `cc-build` bundles the UI,
 * P1-25), so it imports the contract as types only, and the helpers below are its own.
 */
import type { CcError, Screen as ScreenOf, Ui } from '@cc/ui-sdk/v1';

import type { VNode } from '../ui/vnode.js';

export type { Ui };

/** A default UI screen: it renders `h` trees. */
export type Screen<S> = ScreenOf<S, VNode>;

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

/**
 * What a screen says while one of the app shell's own windows asks the user (04 §4.3 rule 4,
 * C-04-12; 04 §9.1 rules 3 and 5). A Tier H operation is confirmed there, never on a screen;
 * the backup password is typed there and a backup folder is chosen there, so neither passes
 * through the screens.
 */
export const IN_WINDOW = {
  confirm: 'Confirm in the window',
  secret: 'Type the password in the window',
  folder: 'Choose the folder in the window',
} as const;

interface InWindow {
  /** The action whose call waits for the shell's window. */
  waiting?: string | undefined;
}

function inWindowState(ui: Ui): InWindow {
  return ui.keep<InWindow>('in-window', () => ({}));
}

/** Whether `key`'s call is waiting for the shell's window. */
export function waitingInWindow(ui: Ui, key: string): boolean {
  return inWindowState(ui).waiting === key;
}

/**
 * Runs `run`, whose answer comes from one of the app shell's windows. While it waits,
 * `waitingInWindow(ui, key)` is true, so the screen says so (`IN_WINDOW`) instead of drawing a
 * confirmation of its own.
 */
export async function inWindow<T>(ui: Ui, key: string, run: () => Promise<T>): Promise<T> {
  const state = inWindowState(ui);
  state.waiting = key;
  ui.render();
  try {
    return await run();
  } finally {
    if (state.waiting === key) state.waiting = undefined;
    ui.render();
  }
}

/** `act`, for an action whose answer comes from one of the app shell's windows (`inWindow`). */
export function actInWindow(
  ui: Ui,
  key: string,
  run: () => Promise<unknown>,
  done: string,
): Promise<boolean> {
  return inWindow(ui, key, () => act(ui, run, done));
}
