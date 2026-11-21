/**
 * The app frame, Home and Decisions (09 P1-11): the navigation, deep links (no
 * Confirmations screen in phase 1, owner decision Q3), load failures and deciding a decision.
 * Settings has its own file, `settings.test.ts`.
 */
import type { Decision } from '@cc/schemas';
import { describe, expect, it } from 'vitest';

import { App } from '../../src/renderer/app/app.js';
import { NAV, routeOfLink } from '../../src/renderer/app/routes.js';
import { byTest, queryByTest, textOf, type VNode } from '../../src/renderer/ui/vnode.js';
import { apiError, click, startApp, type } from './harness.js';

const home = {
  workspace: 'main',
  now: '2026-11-13T15:00:00+05:30',
  today: [{ ref: 'M-0031', time: '15:00', title: 'Weekly CEO review' }],
  attention: {
    overdue: 2,
    atRisk: 1,
    awaitingReview: 1,
    confirmationsPending: 0,
    sessionsNeedingYou: 0,
  },
  items: [
    { ref: 'A-0142', title: 'Send the revised proposal', due: '2026-11-12', state: 'overdue' },
  ],
  counts: { dueSoon: 3, open: 9 },
  backup: {
    state: 'ok' as const,
    lastGood: {
      id: 'bkp_01KA0000000000000000000000',
      at: '2026-11-13T03:00:00.000Z',
      destination: 'Synced folder',
    },
  },
};

describe('the frame and deep links', () => {
  it('has the screens of P1-11 in a fixed order and no Confirmations screen (Q3)', () => {
    expect(NAV.map((entry) => entry.label)).toEqual([
      'Home',
      'Items',
      'Decisions',
      'Issues and risks',
      'Meetings',
      'Scorecard',
      'Settings',
    ]);
  });

  it('opens items and meetings from their links; a confirmation link opens its inline prompt on Home', async () => {
    expect(routeOfLink({ kind: 'items', target: 'A-0142' })).toEqual({
      screen: 'items',
      ref: 'A-0142',
    });
    expect(routeOfLink({ kind: 'meeting', target: 'mtg_1' })).toEqual({
      screen: 'meetings',
      ref: 'mtg_1',
    });
    const route = routeOfLink({ kind: 'confirmations', target: 'cfm_7q2' });
    expect(route).toEqual({ screen: 'home', confirmation: 'cfm_7q2' });
    const app = await startApp({ 'home.get': () => home }, route);
    expect(textOf(byTest(app.tree(), 'confirmation-prompt'))).toMatch(
      /Confirmation cfm_7q2.*decided inline.*Confirmations screen arrives in phase 2/,
    );
  });

  it('a deep link that arrives while the first screen is chosen wins over Home (a cold start from a link)', async () => {
    let answerStatus: (value: unknown) => void = () => undefined;
    let tree: VNode | undefined;
    const app = new App({
      call: async (method) => {
        if (method === 'onboarding.status') {
          return new Promise((resolve) => (answerStatus = resolve));
        }
        if (method === 'meetings.get') throw apiError('E_NOT_FOUND', 'not in this fake');
        return home;
      },
      render: (node) => {
        tree = node;
      },
      now: () => Date.parse('2026-11-13T09:30:00Z'),
    });
    const started = app.start();
    await app.go({ screen: 'meetings', ref: 'M-0010' });
    answerStatus({ state: 'committed' });
    await started;
    expect(app.route).toEqual({ screen: 'meetings', ref: 'M-0010' });
    expect(tree).toBeDefined();
  });

  it('shows why a screen could not load, and loads again', async () => {
    let fail = true;
    const app = await startApp({
      'home.get': () => {
        if (fail) throw apiError('E_APP_NOT_RUNNING', 'the core is not running');
        return home;
      },
    });
    expect(textOf(byTest(app.tree(), 'load-error'))).toMatch(
      /the core is not running \(E_APP_NOT_RUNNING\)/,
    );
    fail = false;
    await app.app.load();
    expect(queryByTest(app.tree(), 'load-error')).toBeUndefined();
  });

  it('navigates from the menu', async () => {
    const app = await startApp({
      'home.get': () => home,
      'decisions.list': () => ({ decisions: [], total: 0 }),
    });
    await click(app, byTest(app.tree(), 'nav-decisions'));
    expect(app.app.route).toEqual({ screen: 'decisions' });
    expect(byTest(app.tree(), 'nav-decisions').props['aria-current']).toBe('page');
  });
});

describe('Home', () => {
  it("lists today's meetings, what needs the user and the most urgent items", async () => {
    const app = await startApp({
      'home.get': () => home,
      'items.list': () => ({ items: [], total: 0 }),
    });
    expect(textOf(byTest(app.tree(), 'today'))).toMatch(/15:00 Weekly CEO review M-0031/);
    expect(textOf(byTest(app.tree(), 'attention-overdue'))).toBe('2 Overdue');
    expect(textOf(byTest(app.tree(), 'home-item-A-0142'))).toMatch(/A-0142.*overdue/);
    const review = byTest(app.tree(), 'attention-review');
    const open = review.children.find(
      (child) => typeof child !== 'string' && child.tag === 'button',
    );
    await click(app, open as never);
    expect(app.app.route).toEqual({ screen: 'items', tab: 'review' });
  });
});

describe('Decisions', () => {
  it('opens a proposed decision with the decider picked; deciding waits until it is open', async () => {
    const decision = {
      ref: 'D-0008',
      question: 'Which social scheduler from week 3?',
      status: 'proposed',
      deciderId: 'per_self',
      reversibility: 'two_way',
      options: [{ id: 'o1', text: 'Buffer', proposedBy: { kind: 'agent' } }],
    } as unknown as Decision;
    const deciders = [
      { id: 'per_self', name: 'Self' },
      { id: 'per_client', name: 'Client contact' },
    ];
    const app = await startApp(
      {
        'decisions.get': () => ({ decision, deciders }),
        'decisions.open': () => ({ status: 'ok' }),
      },
      { screen: 'decisions', ref: 'D-0008' },
    );
    expect(textOf(byTest(app.tree(), 'decider'))).toBe('Self');
    expect(queryByTest(app.tree(), 'decide-form')).toBeUndefined();
    const form = byTest(app.tree(), 'open-form');
    type(byTest(form, 'open-decider'), 'per_client');
    await click(app, byTest(byTest(app.tree(), 'open-form'), 'open-decision'));
    expect(app.callsOf('decisions.open')).toEqual([{ ref: 'D-0008', decider: 'per_client' }]);
  });

  it('decides an open decision with its outcome and why', async () => {
    const decision = {
      ref: 'D-0008',
      question: 'Which social scheduler from week 3?',
      status: 'open',
      reversibility: 'two_way',
      options: [
        { id: 'o1', text: 'Buffer', proposedBy: { kind: 'user' } },
        { id: 'o2', text: 'Later', proposedBy: { kind: 'user' } },
      ],
    } as unknown as Decision;
    const app = await startApp(
      { 'decisions.get': () => ({ decision }), 'decisions.decide': () => ({ status: 'ok' }) },
      { screen: 'decisions', ref: 'D-0008' },
    );
    const form = byTest(app.tree(), 'decide-form');
    await click(app, byTest(form, 'decide'));
    expect(app.callsOf('decisions.decide')).toEqual([]);
    const again = byTest(app.tree(), 'decide-form');
    type(byTest(again, 'decide-option'), 'o1');
    type(byTest(again, 'decide-text'), 'Buffer from week 3');
    type(byTest(again, 'decide-why'), 'It posts to every network we use');
    await click(app, byTest(again, 'decide'));
    expect(app.callsOf('decisions.decide')).toEqual([
      {
        ref: 'D-0008',
        text: 'Buffer from week 3',
        why: 'It posts to every network we use',
        optionId: 'o1',
      },
    ]);
  });
});
