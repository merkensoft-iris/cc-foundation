/// <reference lib="dom" />
/**
 * `createApp(overrides)`: the default UI started in the page (ADR 0008 decision 1). It wires
 * the app frame to `window.cc` and draws into `#app`: the first screen, deep links, the clock
 * of the meeting runner and the API version check. The default UI's own entry (`index.ts`) is
 * `createApp().start()`; an engine's `ui/app.ts` calls it with the screens it replaces, so the
 * screens it has not replaced keep updating with `@cc/ui`.
 */
import type { CcBridge } from '../bridge.js';
import { copyText, mount } from '../ui/dom.js';
import { h } from '../ui/vnode.js';
import { apiVersionProblem } from './api-version.js';
import { App, type AppOptions } from './app.js';
import { routeOfLink } from './routes.js';

declare global {
  interface Window {
    readonly cc: CcBridge;
  }
}

/** How often a screen with a clock (the meeting runner) is drawn again. */
const TICK_MS = 15_000;

/** What an engine's `ui/app.ts` changes in the default UI. */
export interface AppOverrides {
  /** Screens that replace default ones, by route name; the others stay the default ones. */
  readonly screens?: AppOptions['screens'];
  /** Where the app draws; `#app` of the page shell by default. */
  readonly container?: Element;
}

export interface DefaultApp {
  /**
   * Starts the app: it opens the screen a `commandcenter://` link names, else the first
   * screen. It makes no call on a shell that speaks another `window.cc` API version.
   */
  start(): Promise<void>;
}

/** The default UI, with the screens `overrides` replaces. */
export function createApp(overrides: AppOverrides = {}): DefaultApp {
  return {
    start: async () => {
      const container = overrides.container ?? document.getElementById('app');
      if (container === null) return;
      const app = new App({
        ...(overrides.screens === undefined ? {} : { screens: overrides.screens }),
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
      // A deep link that opened the app may already have chosen the screen; otherwise the
      // first screen is onboarding until it is committed (01 §1 item 7), then Home.
      if (!navigated) await app.start();
    },
  };
}
