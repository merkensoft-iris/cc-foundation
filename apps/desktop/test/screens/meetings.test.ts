/**
 * Meetings (09 P1-11; 02 §4.7, §5.7, §6): the week view, the runner with timeboxes and capture,
 * the daily start's attention list in fixed order with dismiss-to-tomorrow (owner decision Q6),
 * capture of items and notes in the daily start (Q7), and the read-back.
 */
import type { MeetingInstance } from '@cc/schemas';
import { describe, expect, it } from 'vitest';

import type { MeetingView } from '../../src/renderer/app/api.js';
import { minutesLeft } from '../../src/renderer/screens/meetings.js';
import { allByTest, buttons, byTest, queryByTest, textOf } from '../../src/renderer/ui/vnode.js';
import { click, startApp, type } from './harness.js';

const NOW = Date.parse('2026-11-13T03:30:00Z');

function instance(state: string, extra: Partial<MeetingInstance> = {}): MeetingInstance {
  return {
    id: 'mtg_ds',
    ref: 'M-0040',
    seriesId: 'ser_daily_start',
    scheduledStart: '2026-11-13T03:30:00Z',
    scheduledEnd: '2026-11-13T03:40:00Z',
    state,
    ...extra,
  } as unknown as MeetingInstance;
}

function dailyStart(state: string, extra: Partial<MeetingInstance> = {}): MeetingView {
  return {
    meeting: instance(state, extra),
    title: 'Daily start',
    agendaTemplateId: 'agenda.portfolio.daily-start@1',
    timeZone: 'Asia/Kolkata',
    sections: [
      {
        sectionId: 'attention',
        title: 'Attention',
        type: 'attention',
        timeboxMinutes: 2,
        status: 'pending',
        allowedOutputs: ['action_item', 'note'],
        rows: [
          { ref: 'A-0160', title: 'Alderwick LinkedIn batch', flags: ['escalation_2'] },
          { ref: 'M-0031', title: 'Weekly CEO review at 15:00', flags: ['conflict'] },
          { ref: 'dst:ws_us:2026-11-01', title: 'US daylight-saving change', flags: [] },
        ],
      },
      {
        sectionId: 'top_three',
        title: 'Top three',
        type: 'top_three',
        timeboxMinutes: 8,
        status: 'pending',
        allowedOutputs: ['action_item', 'note'],
        rows: [],
      },
    ],
    readBack: [],
  };
}

describe('the week view', () => {
  it('shows this week day by day, with each meeting at its local time, and moves by week', async () => {
    const answers = {
      'meetings.list': (params: Record<string, unknown>) => ({
        from: (params['from'] as string | undefined) ?? '2026-11-09',
        to: (params['to'] as string | undefined) ?? '2026-11-15',
        timeZone: 'Asia/Kolkata',
        meetings: [
          {
            ref: 'M-0031',
            title: 'Weekly CEO review',
            start: '2026-11-13T09:30:00Z',
            end: '2026-11-13T12:10:00Z',
            state: 'prepared',
            agendaTemplateId: 'agenda.eos-lite.weekly@1',
          },
        ],
        total: 1,
      }),
    };
    const app = await startApp(answers, { screen: 'meetings' });
    expect(allByTest(app.tree(), 'week')[0]?.children).toHaveLength(7);
    expect(textOf(byTest(byTest(app.tree(), 'day-2026-11-13'), 'meeting-M-0031'))).toMatch(
      /15:00 Weekly CEO review prepared/,
    );
    expect(textOf(byTest(app.tree(), 'day-2026-11-12'))).toMatch(/No meetings/);
    await click(app, byTest(app.tree(), 'next-week'));
    expect(app.callsOf('meetings.list').at(-1)).toMatchObject({
      from: '2026-11-16',
      to: '2026-11-22',
    });
  });
});

describe('the runner', () => {
  it('starts a meeting, shows each section with its timebox and keeps time on the current one', async () => {
    let view = dailyStart('prepared');
    const answers = {
      'meetings.get': () => view,
      'meetings.start': () => {
        view = dailyStart('in_progress');
        return { meeting: view.meeting };
      },
    };
    const app = await startApp(answers, { screen: 'meetings', ref: 'M-0040' }, NOW);
    expect(allByTest(app.tree(), 'timebox').map(textOf)).toEqual(['2 min', '8 min']);
    await click(app, byTest(app.tree(), 'start-meeting'));
    expect(app.callsOf('meetings.start')).toEqual([{ ref: 'M-0040' }]);
    const current = byTest(app.tree(), 'section-attention');
    expect(current.props['aria-current']).toBe('step');
    expect(textOf(byTest(current, 'timer'))).toBe(' 2 min left');
    await click(app, byTest(app.tree(), 'next-section'));
    expect(byTest(app.tree(), 'section-top_three').props['aria-current']).toBe('step');
  });

  it('counts down a timebox and shows overruns', () => {
    const clock = { current: 0, startedAt: NOW };
    expect(minutesLeft(clock, 8, NOW + 3 * 60_000)).toBe(5);
    expect(minutesLeft(clock, 2, NOW + 5 * 60_000)).toBe(-3);
  });

  it('Q6 the attention list keeps its fixed order; Dismiss snoozes an entry to tomorrow', async () => {
    let view = dailyStart('in_progress');
    const answers = {
      'meetings.get': () => view,
      'meetings.dismiss': (params: Record<string, unknown>) => {
        const [first, ...rest] = view.sections;
        view = {
          ...view,
          sections: [
            { ...first!, rows: first!.rows.filter((r) => r.ref !== params['entry']) },
            ...rest,
          ],
        };
        return { status: 'ok', until: '2026-11-14' };
      },
    };
    const app = await startApp(answers, { screen: 'meetings', ref: 'M-0040' }, NOW);
    const rows = byTest(app.tree(), 'rows-attention');
    expect(rows.children.map((row) => (row as { props: { test?: string } }).props.test)).toEqual([
      'row-A-0160',
      'row-M-0031',
      'row-dst:ws_us:2026-11-01',
    ]);
    // There is no way to reorder it: no move buttons, only Dismiss.
    expect(buttons(rows, 'Dismiss')).toHaveLength(3);
    expect(buttons(rows, 'Move up')).toHaveLength(0);

    await click(app, byTest(rows, 'dismiss-M-0031'));
    expect(app.callsOf('meetings.dismiss')).toEqual([{ ref: 'M-0040', entry: 'M-0031' }]);
    expect(textOf(byTest(app.tree(), 'flash'))).toBe('Dismissed until tomorrow’s daily start.');
    expect(queryByTest(app.tree(), 'row-M-0031')).toBeUndefined();
  });

  it('Q7 the daily start captures a draft action item and a note', async () => {
    const answers = {
      'meetings.get': () => dailyStart('in_progress'),
      'meetings.capture': () => ({ status: 'ok' }),
    };
    const app = await startApp(answers, { screen: 'meetings', ref: 'M-0040' }, NOW);
    const capture = byTest(app.tree(), 'capture-attention');
    type(byTest(capture, 'capture-note'), 'Move the gym to the evening');
    await click(app, byTest(capture, 'add-note'));

    const again = byTest(app.tree(), 'capture-attention');
    await click(app, byTest(again, 'capture-item'));
    expect(textOf(byTest(app.tree(), 'flash'))).toMatch(/needs a title, a due date/);
    const form = byTest(app.tree(), 'capture-attention');
    type(byTest(form, 'capture-title'), 'Call the venue');
    type(byTest(form, 'capture-due'), '2026-11-14');
    type(byTest(form, 'capture-done-means'), 'The venue is booked');
    await click(app, byTest(form, 'capture-item'));
    expect(app.callsOf('meetings.capture')).toEqual([
      {
        ref: 'M-0040',
        section: { sectionId: 'attention' },
        output: { kind: 'note', text: 'Move the gym to the evening' },
      },
      {
        ref: 'M-0040',
        section: { sectionId: 'attention' },
        output: {
          kind: 'action_item',
          title: 'Call the venue',
          due: '2026-11-14',
          doneMeans: 'The venue is booked',
        },
      },
    ]);
  });

  it('reads back the captured items, confirms the read-back, then closes', async () => {
    let view: MeetingView = {
      ...dailyStart('in_progress'),
      readBack: [
        {
          kind: 'action_item',
          ref: 'A-0210',
          owner: 'self',
          ownerPresent: true,
          deliverable: 'Call the venue',
          due: '2026-11-14',
          doneMeans: 'The venue is booked',
          state: 'draft',
        },
        {
          kind: 'action_item',
          ref: 'A-0211',
          owner: 'Client contact',
          ownerPresent: false,
          deliverable: 'Sign the statement of work',
          state: 'draft',
        },
      ],
    };
    const answers = {
      'meetings.get': () => view,
      'meetings.confirm': () => {
        view = dailyStart('in_progress', { readBackConfirmedAt: '2026-11-13T03:39:00Z' });
        return { status: 'ok', accepted: ['A-0210', 'A-0211'], pending: [] };
      },
      'meetings.close': () => ({ status: 'ok', carried: [] }),
    };
    const app = await startApp(answers, { screen: 'meetings', ref: 'M-0040' }, NOW);
    expect(textOf(byTest(app.tree(), 'read-back-A-0210'))).toMatch(
      /A-0210 Call the venue · self · due 2026-11-14 · done means: The venue is booked/,
    );
    expect(queryByTest(app.tree(), 'close-meeting')).toBeUndefined();
    type(byTest(app.tree(), 'on-behalf-A-0211'), 'Agreed by email');
    await click(app, byTest(app.tree(), 'read-back-done'));
    expect(app.callsOf('meetings.confirm')).toEqual([
      { ref: 'M-0040', acceptances: [{ ref: 'A-0211', note: 'Agreed by email' }] },
    ]);
    await click(app, byTest(app.tree(), 'close-meeting'));
    expect(app.callsOf('meetings.close')).toEqual([{ ref: 'M-0040' }]);
  });
});
