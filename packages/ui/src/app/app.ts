/**
 * The app frame (09 P1-11): the navigation, the message line and the current screen. It keeps
 * the route, loads the screen's state through the local API and renders it; deep links arrive
 * as routes (`routes.ts`). Rendering goes to a callback, so tests run the whole app headless
 * against a fake `call` and read the view trees.
 */
import type { Params, Result, UiMethod } from '@cc/ui-sdk/v1';

import type { CcError } from '../bridge.js';
import { decisionsScreen } from '../screens/decisions.js';
import { homeScreen } from '../screens/home.js';
import { issuesScreen } from '../screens/issues.js';
import { itemsScreen } from '../screens/items.js';
import { meetingsScreen } from '../screens/meetings.js';
import { onboardingScreen } from '../screens/onboarding.js';
import { scorecardScreen } from '../screens/scorecard.js';
import { settingsScreen } from '../screens/settings.js';
import { h, type VNode } from '../ui/vnode.js';
import { NAV, type AppRoute, type ScreenName } from './routes.js';
import { errorText, isCcError, type Screen, type Ui } from './screen.js';

/**
 * A screen the app frame shows. `ticks` asks for a render now and then while it is open, for a
 * clock on screen (the meeting runner).
 */
export type AppScreen = Screen<unknown> & { readonly ticks?: boolean };

/** The default UI's screens, by route name (09 P1-11). */
export const SCREENS: Readonly<Record<ScreenName, AppScreen>> = {
  home: homeScreen as Screen<unknown>,
  items: itemsScreen as Screen<unknown>,
  decisions: decisionsScreen as Screen<unknown>,
  issues: issuesScreen as Screen<unknown>,
  meetings: meetingsScreen as Screen<unknown> & { readonly ticks: true },
  scorecard: scorecardScreen as Screen<unknown>,
  settings: settingsScreen as Screen<unknown>,
  onboarding: onboardingScreen as Screen<unknown>,
};

export interface AppOptions {
  /**
   * Screens that replace default ones, by route name (ADR 0008 decision 1): an engine's
   * `ui/app.ts` passes them through `createApp`. A route not named here shows the default
   * screen.
   */
  readonly screens?: Partial<Record<ScreenName, AppScreen>>;
  readonly call: (method: string, params?: unknown) => Promise<unknown>;
  readonly render: (node: VNode) => void;
  readonly now?: () => number;
  /** The clipboard; without one, Copy reports that it did not work. */
  readonly copy?: (text: string) => Promise<boolean>;
}

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly state: unknown }
  | { readonly kind: 'failed'; readonly error: CcError | { code: string; message: string } };

export class App {
  readonly #options: AppOptions;
  readonly #screens: Readonly<Record<ScreenName, AppScreen>>;
  readonly #memory = new Map<string, object>();
  #route: AppRoute = { screen: 'home' };
  #loaded: Loaded = { kind: 'loading' };
  #flash: { message: string; kind: 'ok' | 'error' } | undefined;
  #generation = 0;
  readonly ui: Ui;

  constructor(options: AppOptions) {
    this.#options = options;
    this.#screens = { ...SCREENS, ...options.screens };
    this.ui = {
      // The typed client of @cc/ui-sdk/v1 over `window.cc.invoke` (or a test's fake of it).
      call: <M extends UiMethod>(method: M, params: Params<M>) =>
        options.call(method, params) as Promise<Result<M>>,
      go: (route) => {
        void this.go(route);
      },
      reload: () => this.load(),
      render: () => this.render(),
      flash: (message, kind = 'ok') => {
        this.#flash = { message, kind };
        this.render();
      },
      now: () => (options.now ?? Date.now)(),
      copy: (text) => (options.copy === undefined ? Promise.resolve(false) : options.copy(text)),
      keep: <T extends object>(key: string, init: () => T): T => {
        let value = this.#memory.get(key) as T | undefined;
        if (value === undefined) {
          value = init();
          this.#memory.set(key, value);
        }
        return value;
      },
    };
  }

  get route(): AppRoute {
    return this.#route;
  }

  /** Whether the current screen shows a clock that needs a render now and then. */
  get ticks(): boolean {
    return this.#screens[this.#route.screen].ticks === true && this.#loaded.kind === 'ready';
  }

  /**
   * The first screen: onboarding until it is committed (01 §1 item 7, AC-08-11), else Home.
   * When the status cannot be read, Home shows why. A deep link that opened a screen while the
   * status was being read wins: the app was started to show it (04 §3, 02 §9.2 rule 2).
   */
  async start(): Promise<void> {
    const generation = this.#generation;
    let route: AppRoute = { screen: 'home' };
    try {
      const status = await this.ui.call('onboarding.status', {});
      if (status.state !== 'committed') route = { screen: 'onboarding' };
    } catch {
      // Home loads next and shows the failure.
    }
    if (generation !== this.#generation) return;
    await this.go(route);
  }

  /** Opens a screen and loads it. */
  async go(route: AppRoute): Promise<void> {
    this.#route = route;
    this.#flash = undefined;
    this.#loaded = { kind: 'loading' };
    await this.load();
  }

  /** Loads the current screen; a newer load wins over a slower older one. */
  async load(): Promise<void> {
    const generation = ++this.#generation;
    const route = this.#route;
    if (this.#loaded.kind !== 'ready') this.render();
    let next: Loaded;
    try {
      next = { kind: 'ready', state: await this.#screens[route.screen].load(this.ui, route) };
    } catch (error) {
      next = {
        kind: 'failed',
        error: isCcError(error) ? error : { code: 'E_CRASH', message: errorText(error) },
      };
    }
    if (generation !== this.#generation) return;
    this.#loaded = next;
    this.render();
  }

  render(): void {
    this.#options.render(this.view());
  }

  view(): VNode {
    const route = this.#route;
    return h(
      'div',
      { class: 'app' },
      h(
        'nav',
        { class: 'nav', 'aria-label': 'Screens' },
        NAV.map((entry) =>
          h(
            'button',
            {
              type: 'button',
              test: `nav-${entry.screen}`,
              class: entry.screen === route.screen ? 'nav-item current' : 'nav-item',
              ...(entry.screen === route.screen ? { 'aria-current': 'page' } : {}),
              onClick: () => void this.go({ screen: entry.screen }),
            },
            entry.label,
          ),
        ),
      ),
      h(
        'main',
        { class: 'content' },
        this.#flash === undefined
          ? null
          : h(
              'p',
              { class: `flash ${this.#flash.kind}`, role: 'status', test: 'flash' },
              this.#flash.message,
            ),
        this.#body(),
      ),
    );
  }

  #body(): VNode {
    const loaded = this.#loaded;
    if (loaded.kind === 'loading') return h('p', { class: 'muted', test: 'loading' }, 'Loading…');
    if (loaded.kind === 'failed') {
      return h(
        'div',
        { class: 'failure', role: 'alert', test: 'load-error' },
        h('h1', null, 'This screen could not load'),
        h('p', null, `${loaded.error.message} (${loaded.error.code})`),
        h(
          'button',
          { type: 'button', class: 'secondary', onClick: () => void this.load() },
          'Try again',
        ),
      );
    }
    return this.#screens[this.#route.screen].view(loaded.state, this.ui, this.#route);
  }
}
