/**
 * The app frame, Home, Decisions and Settings (09 P1-11): the navigation, deep links (no
 * Confirmations screen in phase 1, owner decision Q3), load failures, deciding a decision, and
 * Settings → Agent access, Notifications and the AI placeholder.
 */
import type { Decision } from '@cc/schemas';
import { describe, expect, it } from 'vitest';

import { NAV, routeOfLink } from '../../src/renderer/app/routes.js';
import { allByTest, byTest, queryByTest, textOf } from '../../src/renderer/ui/vnode.js';
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

describe('Settings', () => {
  const principals = [
    {
      name: 'cli-default',
      kind: 'cli',
      scopes: ['read', 'items:write'],
      workstreamFilter: 'all',
      sensitiveAccess: false,
    },
    {
      name: 'old-agent',
      kind: 'mcp_client',
      scopes: ['read'],
      workstreamFilter: 'all',
      sensitiveAccess: false,
      revokedAt: '2026-11-01T00:00:00Z',
    },
  ];

  it('Agent access grants and revokes scopes, revokes a principal and adds one', async () => {
    const app = await startApp(
      {
        'principals.list': () => ({ principals, total: principals.length }),
        'principals.update': () => ({ principal: principals[0] }),
        'principals.revoke': () => ({ principal: principals[0] }),
        'principals.create': () => ({
          principal: principals[0],
          tokenPath: '/tmp/x/run/tokens/claude-code.token',
        }),
      },
      { screen: 'settings' },
    );
    const grant = byTest(app.tree(), 'scope-cli-default-items:claim');
    grant.props.onCheck?.(true);
    await app.settle();
    expect(app.callsOf('principals.update')).toEqual([
      { name: 'cli-default', scopes: ['read', 'items:write', 'items:claim'] },
    ]);
    // A revoked principal shows its scopes but offers no changes.
    expect(allByTest(app.tree(), 'scope-old-agent-read')).toEqual([]);
    expect(queryByTest(app.tree(), 'revoke-old-agent')).toBeUndefined();

    await click(app, byTest(app.tree(), 'revoke-cli-default'));
    expect(app.callsOf('principals.revoke')).toEqual([{ name: 'cli-default' }]);

    const form = byTest(app.tree(), 'add-principal');
    type(byTest(form, 'principal-name'), 'claude-code');
    byTest(form, 'add-scope-meetings:capture').props.onCheck?.(true);
    await click(app, byTest(form, 'add-principal-submit'));
    expect(app.callsOf('principals.create')).toEqual([
      { name: 'claude-code', kind: 'mcp_client', scopes: ['read', 'meetings:capture'] },
    ]);
    expect(textOf(byTest(app.tree(), 'flash'))).toMatch(
      /claude-code added\. Its token is in .*claude-code\.token/,
    );
  });

  it('lists the pushed notification kinds and shows the AI placeholder without calling anything', async () => {
    const notifications = await startApp({}, { screen: 'settings', tab: 'notifications' });
    expect(allByTest(notifications.tree(), 'pushed-escalation')).toHaveLength(1);
    expect(notifications.calls).toEqual([]);
    const ai = await startApp({}, { screen: 'settings', tab: 'ai' });
    expect(textOf(byTest(ai.tree(), 'ai-placeholder'))).toMatch(/No AI runs/);
    expect(ai.calls).toEqual([]);
  });
});
