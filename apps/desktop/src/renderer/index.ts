/// <reference lib="dom" />
/**
 * @cc/desktop renderer (04 §3): sandboxed, no Node, no network; it reaches the app only
 * through `window.cc` (rule D3). This is the shell's placeholder page: it shows the start
 * mode, whether the core answers, and the last deep link opened. The screens of 09 P1-11
 * (React, with the engine's slots through `@cc/ui-sdk`) replace it.
 */
import type { CcBridge, CcError, RebuildState, Route, StartMode } from './bridge.js';
import { describeRebuild } from './rebuild-view.js';

export const PROCESS = 'renderer';

declare global {
  interface Window {
    readonly cc: CcBridge;
  }
}

function text(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element !== null) element.textContent = value;
}

function describeRoute(route: Route): string {
  return route.kind === 'home' ? 'Opened: Home' : `Opened: ${route.kind} ${route.target}`;
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

function isCcError(value: unknown): value is CcError {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value;
}

async function start(): Promise<void> {
  window.cc.onNavigate((route) => text('route', describeRoute(route)));
  window.cc.onRebuildState(showRebuild);
  document
    .getElementById('rebuild-now')
    ?.addEventListener('click', () => void window.cc.rebuild('now').then(showRebuild));
  document
    .getElementById('rebuild-later')
    ?.addEventListener('click', () => void window.cc.rebuild('later').then(showRebuild));
  const shell = await window.cc.shell();
  showMode(shell.mode);
  void window.cc.rebuild('state').then(showRebuild);
  try {
    await window.cc.invoke('home.get', {});
    text('core-status', 'Core connected.');
  } catch (error) {
    if (isCcError(error) && error.code !== 'E_APP_NOT_RUNNING' && error.code !== 'E_CRASH') {
      // The core answered, with an error: it is running. Home arrives with the screens (P1-11).
      text('core-status', `Core connected (home.get: ${error.code}).`);
    } else {
      text('core-status', `Core not available: ${isCcError(error) ? error.message : 'unknown'}`);
    }
  }
}

void start();
