/// <reference lib="dom" />
/**
 * The page shell's script, served by main as `cc-app://app/shell/index.js` and loaded by the
 * page (`src/main/renderer-page.ts`) before the UI, whichever UI runs: the default UI or the
 * engine's own (ADR 0008 decision 1). It draws the labels main owns in the page:
 *
 * - the developer-mode banner, on every window and never dismissable (ADR 0004 decision 7);
 *   the window title and the tray carry the same label (`src/main/start-mode.ts`);
 * - the Rebuild now strip with its Rebuild now and Later buttons (04 §10 rule 2).
 *
 * It reaches the app only through `window.cc`, as the UI does (rule D3), and imports nothing
 * at run time.
 */
import type { CcBridge, RebuildState, StartMode } from '@cc/ui-sdk/v1';

import { describeRebuild } from './rebuild-view.js';

declare global {
  interface Window {
    readonly cc: CcBridge;
  }
}

function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function show(id: string, visible: boolean): void {
  const element = byId(id);
  if (element !== null) element.hidden = !visible;
}

/** Developer mode is labelled on every window and cannot be dismissed (ADR 0004 decision 7). */
function showMode(mode: StartMode): void {
  const banner = byId('mode-banner');
  if (banner === null) return;
  if (mode.kind === 'developer') {
    banner.textContent = `Developer mode: ${mode.reasons[0] ?? 'cannot verify tree'}`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

function showRebuild(state: RebuildState): void {
  const view = describeRebuild(state);
  show('rebuild-offer', view !== null);
  if (view === null) return;
  const text = byId('rebuild-text');
  if (text !== null) text.textContent = view.text;
  show('rebuild-now', view.now);
  show('rebuild-later', view.later);
}

function start(): void {
  window.cc.onRebuildState(showRebuild);
  byId('rebuild-now')?.addEventListener(
    'click',
    () => void window.cc.rebuild('now').then(showRebuild),
  );
  byId('rebuild-later')?.addEventListener(
    'click',
    () => void window.cc.rebuild('later').then(showRebuild),
  );
  void window.cc.shell().then((shell) => showMode(shell.mode));
  void window.cc.rebuild('state').then(showRebuild);
}

start();
