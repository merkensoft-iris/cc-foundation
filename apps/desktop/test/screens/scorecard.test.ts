/**
 * The Scorecard (09 P1-11): manual measure values, and the Goals tab where goals are editable
 * any time and every change is logged (owner decision Q2, AC-03-10).
 */
import type { DomainEvent, Goal } from '@cc/schemas';
import { describe, expect, it } from 'vitest';

import { goalChanges, type GoalForm } from '../../src/renderer/screens/scorecard.js';
import { byTest, textOf } from '../../src/renderer/ui/vnode.js';
import { click, startApp, type } from './harness.js';

const goal = {
  id: 'goal_1',
  ref: 'G-0004',
  kind: 'priority',
  title: 'Sign ten retainer clients',
  period: { start: '2026-10-01', end: '2026-12-31', label: '2026-Q4' },
  target: { from: 0, to: 10, unit: 'clients', by: '2026-12-31' },
  status: 'active',
  health: 'on_track',
  version: 3,
} as unknown as Goal;

const created: DomainEvent = {
  id: 'evt_1',
  at: '2026-10-01T04:00:00Z',
  type: 'goal.created',
  actor: { kind: 'user' },
  entity: { kind: 'goal', id: 'goal_1', ref: 'G-0004' },
} as DomainEvent;

describe('the Goals tab (owner decision Q2)', () => {
  it("AC-03-10 changing a goal's title and target outside any meeting saves one goals.update with the changed fields, and the goal's history lists the change before and after", async () => {
    let current = goal;
    const events: DomainEvent[] = [created];
    const answers = {
      'goals.list': () => ({
        goals: [
          {
            ref: 'G-0004',
            title: current.title,
            kind: 'priority',
            status: 'active',
            health: 'on_track',
          },
        ],
        total: 1,
      }),
      'goals.get': () => ({ goal: current }),
      'goals.history': () => ({ events, total: events.length }),
      'goals.update': (params: Record<string, unknown>) => {
        const before = { title: current.title, target: current.target };
        current = {
          ...current,
          title: params['title'] as string,
          target: params['target'] as Goal['target'],
          version: 4,
        } as Goal;
        events.push({
          id: 'evt_2',
          at: '2026-11-13T09:30:00Z',
          type: 'goal.updated',
          actor: { kind: 'user' },
          entity: { kind: 'goal', id: 'goal_1', ref: 'G-0004' },
          before,
          after: { title: current.title, target: current.target },
        } as DomainEvent);
        return { status: 'ok', goal: current };
      },
    };
    const app = await startApp(answers, { screen: 'scorecard', tab: 'goals' });
    expect(textOf(app.tree())).toMatch(/Goals can be edited any time/);
    const open = byTest(app.tree(), 'goal-G-0004').children[0] as never as {
      children: { props: { onClick: () => void } }[];
    };
    open.children[0]?.props.onClick();
    await app.settle();

    const form = byTest(app.tree(), 'goal-form');
    type(byTest(form, 'goal-title'), 'Sign twelve retainer clients');
    type(byTest(form, 'target-to'), '12');
    await click(app, byTest(form, 'save-goal'));

    expect(app.callsOf('goals.update')).toEqual([
      {
        ref: 'G-0004',
        version: 3,
        title: 'Sign twelve retainer clients',
        target: { from: 0, to: 12, unit: 'clients', by: '2026-12-31' },
      },
    ]);
    const history = byTest(app.tree(), 'goal-history');
    expect(textOf(byTest(history, 'goal-event-goal.updated'))).toMatch(/goal.updated by user/);
    expect(textOf(byTest(history, 'change-title'))).toBe(
      'title: Sign ten retainer clients → Sign twelve retainer clients',
    );
    expect(textOf(byTest(history, 'change-target'))).toContain('"to":10');
    expect(textOf(byTest(history, 'change-target'))).toContain('"to":12');
    // The form shows the saved goal.
    expect(byTest(app.tree(), 'goal-title').props.value).toBe('Sign twelve retainer clients');
  });

  it('sends only what changed, and refuses an incomplete target', () => {
    const form: GoalForm = {
      title: goal.title,
      doneMeans: '',
      targetFrom: '0',
      targetTo: '10',
      targetUnit: 'clients',
      targetBy: '2026-12-31',
      health: 'on_track',
      healthNote: '',
    };
    expect(goalChanges(goal, form)).toEqual({ ref: 'G-0004', version: 3 });
    expect(goalChanges(goal, { ...form, targetUnit: '' })).toBe(
      'A target needs from, to, a unit and a by date.',
    );
    expect(
      goalChanges(goal, { ...form, health: 'off_track', healthNote: 'Two clients paused' }),
    ).toEqual({
      ref: 'G-0004',
      version: 3,
      health: { value: 'off_track', note: 'Two clients paused' },
    });
    expect(goalChanges(goal, { ...form, title: ' ' })).toBe('A goal needs a title.');
  });
});

describe('measures', () => {
  it('records a manual value', async () => {
    const answers = {
      'measures.list': () => ({
        measures: [
          {
            ref: 'K-0003',
            name: 'Qualified leads',
            unit: 'count',
            target: { op: 'gte', value: 5 },
            latest: { periodStart: '2026-11-09', value: 4, normal: null },
          },
        ],
        total: 1,
      }),
      'measures.record': () => ({ status: 'ok' }),
    };
    const app = await startApp(answers, { screen: 'scorecard' });
    const row = byTest(app.tree(), 'measure-K-0003');
    expect(textOf(row)).toMatch(/4 count \(2026-11-09\)/);
    type(byTest(row, 'value-K-0003'), '6');
    await click(app, byTest(row, 'record-K-0003'));
    expect(app.callsOf('measures.record')).toEqual([{ ref: 'K-0003', value: 6 }]);
  });
});
