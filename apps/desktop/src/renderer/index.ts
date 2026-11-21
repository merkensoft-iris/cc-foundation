/// <reference lib="dom" />
/**
 * @cc/desktop renderer, the default UI (04 §3): sandboxed, no Node, no network; it reaches the
 * app only through `window.cc` (rule D3). Main serves it as `/ui/index.js` when the engine has
 * no UI of its own (ADR 0008 decision 1). It shows the screens of 09 P1-11 (`app/app.ts`),
 * opening the screen a `commandcenter://` link names; the start mode and the Rebuild now strip
 * are the page shell's (`src/page-shell`). It runs only on a shell that speaks its `window.cc`
 * API version (`app/api-version.ts`).
 */
import { apiVersionProblem } from './app/api-version.js';
import { App } from './app/app.js';
import { routeOfLink } from './app/routes.js';
import type { CcBridge } from './bridge.js';
import { copyText, mount } from './ui/dom.js';
import { h } from './ui/vnode.js';

export const PROCESS = 'renderer';

/** How often a screen with a clock (the meeting runner) is drawn again. */
const TICK_MS = 15_000;

declare global {
  interface Window {
    readonly cc: CcBridge;
  }
}

async function start(): Promise<void> {
  const container = document.getElementById('app');
  if (container === null) return;
  const app = new App({
    call: (method, params) => window.cc.invoke(method, params),
    render: (node) => mount(container, node),
    copy: copyText,
  });
  let navigated = false;
  let incompatible = false;
  window.cc.onNavigate((route) => {
    navigated = true;
    if (!incompatible) void app.go(routeOfLink(route));
  });
  setInterval(() => {
    // Only when nothing is being typed: a render replaces the inputs.
    const typing = document.activeElement?.matches('input, textarea, select') ?? false;
    if (app.ticks && !typing) app.render();
  }, TICK_MS);
  const shell = await window.cc.shell();
  // A UI built for another window.cc API version makes no calls (08 §4.3).
  const problem = apiVersionProblem(shell);
  if (problem !== undefined) {
    incompatible = true;
    mount(
      container,
      h(
        'div',
        { class: 'failure', role: 'alert', test: 'api-version' },
        h('h1', null, 'This app needs a rebuild'),
        h('p', null, problem),
      ),
    );
    return;
  }
  // A deep link that opened the app may already have chosen the screen; otherwise the first
  // screen is onboarding until it is committed (01 §1 item 7), then Home.
  if (!navigated) await app.start();
}

void start();
