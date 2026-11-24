/**
 * The composition API of `@cc/ui/v1` (ADR 0008 decision 1, 09 P1-26): an engine's `ui/app.ts`
 * uses the default UI as it is, or replaces screens one at a time, and the screens it does not
 * replace stay the default ones. `createApp` runs here on a fake `window.cc` and a minimal fake
 * of the few DOM calls `mount` makes.
 */
import type { CcBridge, Route, ShellInfo } from '@cc/ui-sdk/v1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SCREENS } from '../src/app/app.js';
import { createApp } from '../src/app/create-app.js';
import type { Screen } from '../src/app/screen.js';
import * as v1 from '../src/v1.js';
import { h } from '../src/ui/vnode.js';
import { apiError, startApp } from './harness.js';

/** A replaced Home: what an engine's `ui/screens/home.ts` would hold. */
const brandHome: Screen<{ readonly title: string }> = {
  load: () => Promise.resolve({ title: 'Our week at a glance' }),
  view: (state) => h('h1', { test: 'brand-home' }, state.title),
};

describe('replacing screens one at a time', () => {
  it('shows a replaced screen in place of the default one, in the same frame', async () => {
    const harness = await startApp({}, { screen: 'home' }, undefined, { home: brandHome });
    expect(harness.calls).toEqual([]);
    expect(harness.text()).toContain('Our week at a glance');
    // The navigation is the default UI's.
    expect(harness.text()).toContain('Issues and risks');
  });

  it('keeps the default screen for every route it does not replace', async () => {
    const harness = await startApp(
      { 'decisions.get': () => Promise.reject(apiError('E_NOT_FOUND', 'No decision D-0001')) },
      { screen: 'decisions', ref: 'D-0001' },
      undefined,
      { home: brandHome },
    );
    expect(harness.callsOf('decisions.get')).toEqual([{ ref: 'D-0001' }]);
    expect(harness.text()).toContain('No decision D-0001');
  });

  it('draws a replaced screen that keeps a clock again now and then, as the meeting runner does', async () => {
    const runner = { ...brandHome, ticks: true } as const;
    const harness = await startApp({}, { screen: 'meetings' }, undefined, { meetings: runner });
    expect(harness.app.ticks).toBe(true);
    const plain = await startApp({}, { screen: 'meetings' }, undefined, { meetings: brandHome });
    expect(plain.app.ticks).toBe(false);
    expect(SCREENS.meetings.ticks).toBe(true);
  });
});

/** The parts of a DOM element `mount` touches, kept as a tree the test reads. */
interface FakeNode {
  readonly tag?: string;
  readonly text?: string;
  readonly dataset: Record<string, string>;
  readonly children: FakeNode[];
}

function fakeElement(tag: string): FakeNode & Record<string, unknown> {
  const children: FakeNode[] = [];
  return {
    tag,
    dataset: {},
    children,
    addEventListener: () => undefined,
    setAttribute: () => undefined,
    appendChild: (child: FakeNode) => children.push(child),
  };
}

function findTest(node: FakeNode | undefined, test: string): FakeNode | undefined {
  if (node === undefined) return undefined;
  if (node.dataset['test'] === test) return node;
  for (const child of node.children) {
    const found = findTest(child, test);
    if (found !== undefined) return found;
  }
  return undefined;
}

function textIn(node: FakeNode | undefined): string {
  if (node === undefined) return '';
  return node.text ?? node.children.map(textIn).join('');
}

describe('createApp(overrides)', () => {
  let drawn: FakeNode | undefined;
  let navigate: ((route: Route) => void) | undefined;
  let calls: string[];
  const container = {
    replaceChildren: (node: FakeNode) => {
      drawn = node;
    },
  } as unknown as Element;

  function bridge(shell: ShellInfo): CcBridge {
    return {
      invoke: (method) => {
        calls.push(method);
        if (method === 'onboarding.status') return Promise.resolve({ state: 'committed' });
        return Promise.reject(apiError('E_USAGE', `no fake answer for ${method}`));
      },
      shell: () => Promise.resolve(shell),
      onNavigate: (listener) => {
        navigate = listener;
        return () => undefined;
      },
      rebuild: () => Promise.resolve({ kind: 'none' }),
      onRebuildState: () => () => undefined,
    };
  }

  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };

  beforeEach(() => {
    drawn = undefined;
    navigate = undefined;
    calls = [];
    vi.useFakeTimers({ toFake: ['setInterval'] });
    vi.stubGlobal('document', {
      activeElement: null,
      getElementById: () => null,
      createElement: (tag: string) => fakeElement(tag),
      createTextNode: (text: string) => ({ text, dataset: {}, children: [] }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts the default UI with a replaced Home, and a deep link still opens a default screen', async () => {
    vi.stubGlobal('window', {
      cc: bridge({ mode: { kind: 'normal' }, version: '0.0.0', apiVersion: 1 }),
    });
    await createApp({ screens: { home: brandHome }, container }).start();
    await settle();
    expect(calls).toEqual(['onboarding.status']);
    expect(textIn(findTest(drawn, 'brand-home'))).toBe('Our week at a glance');
    navigate?.({ kind: 'items', target: 'A-0142' });
    await settle();
    expect(calls.slice(1).every((method) => method.startsWith('items.'))).toBe(true);
    expect(calls.length).toBeGreaterThan(1);
    expect(findTest(drawn, 'brand-home')).toBeUndefined();
  });

  it('makes no call on a shell that speaks another window.cc API version', async () => {
    vi.stubGlobal('window', {
      cc: bridge({ mode: { kind: 'normal' }, version: '0.0.0', apiVersion: 2 }),
    });
    await createApp({ screens: { home: brandHome }, container }).start();
    await settle();
    expect(calls).toEqual([]);
    expect(textIn(findTest(drawn, 'api-version'))).toContain('This app needs a rebuild');
  });

  it('draws nothing when the page has no #app and no container is given', async () => {
    vi.stubGlobal('window', {
      cc: bridge({ mode: { kind: 'normal' }, version: '0.0.0', apiVersion: 1 }),
    });
    await createApp().start();
    expect(calls).toEqual([]);
    expect(drawn).toBeUndefined();
  });
});

describe('@cc/ui/v1', () => {
  it('exports the composition API, the default screens and the UI kit, and nothing else', () => {
    // A change to this list is a change to the composition API (ADR 0008 decision 1). The scope
    // lists are there because an ejected screen imports them from here (pnpm cc:eject).
    expect(Object.keys(v1).sort()).toEqual(
      [
        'App',
        'GRANT_ONLY_SCOPES',
        'IN_WINDOW',
        'NAV',
        'SCOPES',
        'SCREENS',
        'act',
        'actInWindow',
        'addDays',
        'allByTest',
        'button',
        'buttons',
        'byTest',
        'checkbox',
        'chip',
        'copyText',
        'createApp',
        'decisionsScreen',
        'errorText',
        'field',
        'h',
        'healthChip',
        'homeScreen',
        'inWindow',
        'inWindowNote',
        'isCcError',
        'issuesScreen',
        'itemsScreen',
        'link',
        'localDate',
        'localTime',
        'meetingsScreen',
        'mount',
        'onboardingScreen',
        'page',
        'queryByTest',
        'routeOfLink',
        'scorecardScreen',
        'section',
        'select',
        'settingsScreen',
        'stateChip',
        'table',
        'tabs',
        'textOf',
        'waitingInWindow',
        'walk',
      ].sort(),
    );
    expect(v1.SCREENS).toEqual({
      home: v1.homeScreen,
      items: v1.itemsScreen,
      decisions: v1.decisionsScreen,
      issues: v1.issuesScreen,
      meetings: v1.meetingsScreen,
      scorecard: v1.scorecardScreen,
      settings: v1.settingsScreen,
      onboarding: v1.onboardingScreen,
    });
  });
});
