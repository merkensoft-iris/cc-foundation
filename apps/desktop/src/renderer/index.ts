/// <reference lib="dom" />
/**
 * @cc/desktop renderer (04 §3): sandboxed, no Node, no network; it reaches the app only
 * through `window.cc` (rule D3). It shows the start mode, the Rebuild now strip, and the
 * screens of 09 P1-11 (`app/app.ts`), opening the screen a `commandcenter://` link names.
 */
import { App } from './app/app.js';
import { routeOfLink } from './app/routes.js';
import type { CcBridge, RebuildState, StartMode } from './bridge.js';
import { describeRebuild } from './rebuild-view.js';
import { mount } from './ui/dom.js';

export const PROCESS = 'renderer';

/** How often a screen with a clock (the meeting runner) is drawn again. */
const TICK_MS = 15_000;

declare global {
  interface Window {
    readonly cc: CcBridge;
  }
}

function text(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element !== null) element.textContent = value;
}

/** Developer mode is labelled on every window and cannot be dismissed (ADR 0004 decision 7). */
function showMode(mode: StartMode): void {
  const banner = document.getElementById('mode-banner');
  if (banner === null) return;
  if (mode.kind === 'developer') {
    banner.textContent = `Developer mode: ${mode.reasons[0] ?? 'cannot verify tree'}`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

function show(id: string, visible: boolean): void {
  const element = document.getElementById(id);
  if (element !== null) element.hidden = !visible;
}

function showRebuild(state: RebuildState): void {
  const view = describeRebuild(state);
  show('rebuild-offer', view !== null);
  if (view === null) return;
  text('rebuild-text', view.text);
  show('rebuild-now', view.now);
  show('rebuild-later', view.later);
}

async function start(): Promise<void> {
  const container = document.getElementById('app');
  if (container === null) return;
  const app = new App({
    call: (method, params) => window.cc.invoke(method, params),
    render: (node) => mount(container, node),
  });
  let navigated = false;
  window.cc.onNavigate((route) => {
    navigated = true;
    void app.go(routeOfLink(route));
  });
  window.cc.onRebuildState(showRebuild);
  document
    .getElementById('rebuild-now')
    ?.addEventListener('click', () => void window.cc.rebuild('now').then(showRebuild));
  document
    .getElementById('rebuild-later')
    ?.addEventListener('click', () => void window.cc.rebuild('later').then(showRebuild));
  setInterval(() => {
    // Only when nothing is being typed: a render replaces the inputs.
    const typing = document.activeElement?.matches('input, textarea, select') ?? false;
    if (app.ticks && !typing) app.render();
  }, TICK_MS);
  const shell = await window.cc.shell();
  showMode(shell.mode);
  void window.cc.rebuild('state').then(showRebuild);
  // A deep link that opened the app may already have chosen the screen.
  if (!navigated) await app.go({ screen: 'home' });
}

void start();
