/**
 * The .ics export (02 §9.1 provider "none", 02 §9.2; ADR 0001 decision 3; P1-09): the UTC writer,
 * folding and escaping, event text (C-02-08, INV-03-10), the export window and the
 * `planned → scheduled` move, and AC-02-08 on the scenario series, read back with ical.js.
 */
import { describe, expect, it } from 'vitest';

import type { DomainContext } from '@cc/domain';
import {
  exportIcs,
  extendHorizon,
  foldLine,
  icsSequence,
  icsText,
  icsUtc,
  ICS_WARNING,
  localDate,
  localDateTime,
  updateSeries,
  writeIcs,
} from '@cc/rhythm';
import type { DomainEvent, MeetingInstance, MeetingSeries } from '@cc/schemas';

import {
  checkChanges,
  harness,
  memoryStore,
  rhythm,
  scenarioPlacement,
  scenarioSeries,
  seriesById,
  user,
  wigSeries,
} from './harness.ts';
import { parseIcs } from './ics-parse.ts';

const IST = 'Asia/Kolkata';
const ALL = ['ws_ald', 'ws_qlm', 'ws_goal'];
const encoder = new TextEncoder();

function seeded(series: readonly MeetingSeries[] = [...scenarioSeries(), wigSeries()]) {
  const h = harness('2026-11-04T04:10:00Z');
  const store = memoryStore(series);
  extendHorizon(store, h.ctx, scenarioPlacement());
  /** An instance's events from every commit, oldest first. */
  const history = (id: string): DomainEvent[] =>
    store.commits
      .flat()
      .filter((c) => c.event.entity.id === id)
      .map((c) => c.event);
  const exportNow = (weeks = 13, ctx: DomainContext = h.ctx) => {
    const result = exportIcs(ctx, rhythm, {
      series: store.listSeries(),
      instances: [...store.instances.values()],
      weeks,
      workspaceTimeZone: IST,
      sequenceOf: (instance) => icsSequence(history(instance.id)),
    });
    if (result.changes.length > 0) store.commit(result.changes);
    return result;
  };
  return { ...h, store, history, exportNow };
}

describe('ADR 0001 decision 3 the UTC writer', () => {
  it('writes UTC basic times, escapes TEXT, and folds at 75 octets without splitting a character', () => {
    expect(icsUtc('2026-11-13T09:30:00Z')).toBe('20261113T093000Z');
    expect(icsUtc('2026-11-13T09:30:00.000Z')).toBe('20261113T093000Z');
    expect(icsText('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne');
    const line = `DESCRIPTION:${'é'.repeat(80)}`;
    const folded = foldLine(line).split('\r\n');
    expect(folded.length).toBeGreaterThan(1);
    for (const part of folded) expect(encoder.encode(part).length).toBeLessThanOrEqual(75);
    expect(folded.slice(1).every((part) => part.startsWith(' '))).toBe(true);
    expect(folded.map((part, i) => (i === 0 ? part : part.slice(1))).join('')).toBe(line);
  });

  it('writes a calendar ical.js reads back, with CRLF only and no VTIMEZONE', () => {
    const text = writeIcs([
      {
        uid: 'mtg_x@command-center',
        sequence: 2,
        dtstamp: '2026-11-04T04:10:00Z',
        start: '2026-11-13T09:30:00Z',
        end: '2026-11-13T10:30:00Z',
        summary: '[CC] Weekly, review; one',
        description: 'Agenda:\n- Check-in, 2 min',
        reminderMinutes: [15, 5],
      },
    ]);
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(text).not.toContain('VTIMEZONE');
    expect(text).not.toContain('TZID');
    expect(parseIcs(text)).toEqual([
      {
        uid: 'mtg_x@command-center',
        sequence: 2,
        start: '2026-11-13T09:30:00Z',
        end: '2026-11-13T10:30:00Z',
        summary: '[CC] Weekly, review; one',
        description: 'Agenda:\n- Check-in, 2 min',
        alarms: 2,
      },
    ]);
  });

  it('counts SEQUENCE from time changes only', () => {
    const at = (after: Record<string, unknown>): DomainEvent => ({
      id: 'evt_00000000000000000000000001',
      at: '2026-11-04T04:10:00Z',
      actor: { kind: 'system', component: 'rhythm' },
      type: 'meeting_instance.x',
      entity: { kind: 'meeting_instance', id: 'mtg_x' },
      after,
    });
    const created = at({ scheduledStart: 'a', scheduledEnd: 'b', state: 'planned' });
    expect(icsSequence([created])).toBe(0);
    expect(icsSequence([created, at({ state: 'scheduled' }), at({ preread: {} })])).toBe(0);
    expect(icsSequence([created, at({ scheduledStart: 'c', scheduledEnd: 'd' })])).toBe(1);
    expect(icsSequence([created, at({ scheduledEnd: 'e' }), at({ scheduledStart: 'f' })])).toBe(2);
  });
});

describe('02 §9.1 the export', () => {
  it('exports the window from the start of today, unbound series only, and moves planned instances to scheduled once', () => {
    const bound: MeetingSeries = {
      ...seriesById('ser_goal_wig'),
      calendars: [
        {
          bindingId: 'bnd_gcal' as never,
          calendarId: 'cc',
          role: 'primary',
          titleTemplate: '[CC] {{series.name}}',
          inviteAttendees: false,
        },
      ],
    };
    const series = [...scenarioSeries(), bound];
    const { exportNow, store } = seeded(series);
    const first = exportNow(2);
    checkChanges(first.changes);
    expect(first.warning).toBe(ICS_WARNING);
    expect(first.window).toEqual({ from: '2026-11-03T18:30:00Z', to: '2026-11-17T18:30:00Z' });
    const exported = [...store.instances.values()].filter((i) => first.instances.includes(i.ref));
    expect(exported.every((i) => i.state === 'scheduled')).toBe(true);
    expect(exported.some((i) => i.seriesId === bound.id)).toBe(false);
    expect(new Set(exported.map((i) => localDate(i.scheduledStart, IST)))).toEqual(
      new Set([
        '2026-11-09',
        '2026-11-10',
        '2026-11-11',
        '2026-11-12',
        '2026-11-13',
        '2026-11-16',
        '2026-11-17',
      ]),
    );
    expect(first.changes).toHaveLength(exported.length);
    expect(first.changes.every((c) => c.event.type === 'meeting_instance.scheduled')).toBe(true);
    const again = exportNow(2);
    expect(again.changes).toEqual([]);
    expect(again.instances).toEqual(first.instances);
  });

  it('C-02-08 event text: the series name or a neutral title for a sensitive workstream, an agenda outline and the deep link, no workstream names', () => {
    const { ctx, exportNow, store } = seeded();
    const sensitive: DomainContext = {
      ...ctx,
      registry: {
        ...ctx.registry,
        workstream: (id) => {
          const found = ctx.registry.workstream(id);
          return found === undefined || id !== 'ws_goal'
            ? found
            : { ...found, privacy: 'sensitive' };
        },
      },
    };
    const events = parseIcs(exportNow(13, sensitive).ics);
    const byUid = new Map(events.map((e) => [e.uid, e]));
    const instance = (seriesId: string, date: string) =>
      [...store.instances.values()].find(
        (i) => i.seriesId === seriesId && localDate(i.scheduledStart, IST) === date,
      ) as MeetingInstance;
    const weekly = byUid.get(`${instance('ser_ceo_weekly', '2026-11-13').id}@command-center`);
    expect(weekly?.summary).toBe('[CC] Weekly CEO review');
    expect(weekly?.description.split('\n')).toEqual([
      'Agenda:',
      '- Check-in, 2 min',
      '- Scorecard, 4 min',
      '- Priorities, 3 min',
      '- Action review, 7 min',
      '- Scorecard, 4 min',
      '- Priorities, 3 min',
      '- Action review, 7 min',
      '- Headlines, 3 min',
      '- Issues, 22 min',
      '- Conclude, 5 min',
      '',
      `Open in Command Center: commandcenter://meeting/${instance('ser_ceo_weekly', '2026-11-13').id}`,
    ]);
    const monthly = byUid.get(`${instance('ser_ceo_monthly', '2026-11-27').id}@command-center`);
    const minutes = (monthly?.description ?? '')
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .reduce((sum, line) => sum + Number(/(\d+) min$/.exec(line)?.[1] ?? 0), 0);
    expect(minutes).toBe(120); // the absorbed weekly backbone (30) and the monthly's own (90)
    const friend = byUid.get(`${instance('ser_goal_wig', '2026-11-16').id}@command-center`);
    expect(friend?.summary).toBe('[CC] Weekly meeting');
    const names = ['Alderwick', 'Quillmarsh', 'alderwick', 'quillmarsh', 'goal-area'];
    for (const event of events) {
      for (const name of names) {
        expect(event.summary).not.toContain(name);
        expect(event.description).not.toContain(name);
      }
    }
  });
});

describe('AC-02-08 the .ics export without a calendar binding', () => {
  it('AC-02-08 export-ics --weeks 13 gives one event per instance that ical.js reads back, and a re-export after a time change raises SEQUENCE for the changed events only', () => {
    const { ctx, clock, exportNow, store } = seeded();
    const first = exportNow(13);
    const events = parseIcs(first.ics);
    const expected = [...store.instances.values()].filter((i) => first.instances.includes(i.ref));
    expect(events).toHaveLength(expected.length);
    expect(events.length).toBeGreaterThan(150);
    expect(new Set(events.map((e) => e.uid)).size).toBe(events.length);
    for (const instance of expected) {
      const event = events.find((e) => e.uid === `${instance.id}@command-center`);
      expect(event).toMatchObject({
        start: instance.scheduledStart,
        end: instance.scheduledEnd,
        sequence: 0,
        alarms: 1,
      });
    }
    for (const line of first.ics.split('\r\n')) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    }
    // Absorbed instances are not events of their own; the absorbing monthly carries them.
    const absorbed = [...store.instances.values()].filter((i) => i.state === 'absorbed');
    expect(absorbed.length).toBeGreaterThan(0);
    for (const instance of absorbed) expect(first.instances).not.toContain(instance.ref);

    clock.set('2026-11-18T04:00:00Z');
    const wig = store.listSeries().find((s) => s.id === 'ser_goal_wig') as MeetingSeries;
    const changed = updateSeries(
      ctx,
      user,
      wig,
      { rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=16;BYMINUTE=0' },
      { activeWorkstreamIds: ALL, placement: scenarioPlacement() },
    );
    store.commit(changed.changes);
    extendHorizon(store, ctx, scenarioPlacement());

    const second = exportNow(13);
    const before = new Map(events.map((e) => [e.uid, e]));
    const after = parseIcs(second.ics);
    const moved = after.filter((e) => before.get(e.uid)?.start !== e.start && before.has(e.uid));
    const same = after.filter((e) => before.get(e.uid)?.start === e.start);
    expect(moved.length).toBeGreaterThan(5);
    for (const event of moved) {
      const instance = [...store.instances.values()].find(
        (i) => `${i.id}@command-center` === event.uid,
      ) as MeetingInstance;
      expect(instance.seriesId).toBe('ser_goal_wig');
      expect(localDateTime(instance.scheduledStart, IST).slice(11)).toBe('16:00');
      expect(event.sequence).toBeGreaterThan(before.get(event.uid)?.sequence ?? 0);
    }
    expect(same.length).toBeGreaterThan(100);
    for (const event of same) expect(event.sequence).toBe(before.get(event.uid)?.sequence);
  });
});
