/**
 * Carry-forward, escalation and the .ics export on the workspace store (P1-09; 02 §7, §9.1):
 * AC-02-05 through the meetings a user runs (start, read-back, close) with the nightly
 * escalation run between them, C-02-05 on SQLite, the review sightings the close records, and
 * AC-02-08 with each instance's SEQUENCE read from its events.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { extendHorizon, updateSeries } from '@cc/rhythm';
import type { ActionItem, MeetingInstance, MeetingSeries } from '@cc/schemas';
import { openStore, type Store } from '@cc/store';
import { createProfileDir, FakeTimerClock } from '@cc/test-kit';

import { Meetings } from '../src/meetings.js';
import { storeRhythmStore } from '../src/rhythm-store.js';
import {
  harness,
  scenarioPlacement,
  scenarioSeries,
  seriesById,
  wigSeries,
} from '../../rhythm/test/harness.ts';
import { parseIcs } from '../../rhythm/test/ics-parse.ts';
import { seedWorkspace } from './helpers.js';

const opened: (() => void)[] = [];

afterEach(() => {
  for (const close of opened.splice(0)) close();
});

const user = { actor: { kind: 'user' as const } };
const IST = 'Asia/Kolkata';

const localOf = (instant: string) =>
  new Date(instant).toLocaleString('sv-SE', { timeZone: IST }).slice(0, 16).replace(' ', 'T');

/**
 * The reference records and `series` on a fresh store, materialised on 2026-11-04. A-0142 is
 * made an open Alderwick item due 2026-11-13, AC-02-05's item.
 */
function world(now: string, series: readonly MeetingSeries[]) {
  const profile = createProfileDir();
  let tick = 0;
  const db: Store = openStore({
    userDataDir: profile.path,
    now: () => new Date(Date.parse('2026-11-04T04:10:00Z') + tick++ * 1000).toISOString(),
    random: (size) => Uint8Array.from({ length: size }, (_, index) => (tick + index) % 251),
    env: {},
  });
  opened.push(() => {
    db.close();
    profile.cleanup();
  });
  seedWorkspace(db, (item) => {
    const { waitingOn: _waiting, ...rest } = item;
    void _waiting;
    return { ...rest, lifecycle: 'open', due: { date: '2026-11-13', timeZone: IST } };
  });
  db.command({ actor: { kind: 'user' } }, (tx) => {
    for (const record of series) {
      tx.insert('meeting_series', record);
      tx.event({
        type: 'meeting_series.created',
        entity: { kind: 'meeting_series', id: record.id },
      });
    }
  });
  const rhythm = harness('2026-11-04T04:10:00Z');
  extendHorizon(storeRhythmStore(db), rhythm.ctx, scenarioPlacement());
  const clock = new FakeTimerClock(now);
  const meetings = new Meetings(db, { clock });
  const instance = (local: string, seriesId: string): MeetingInstance => {
    const found = db
      .read((tx) => tx.list('meeting_instances'))
      .find((i) => i.seriesId === seriesId && localOf(i.scheduledStart) === local);
    if (found === undefined) throw new Error(`no instance ${seriesId} ${local}`);
    return found;
  };
  const item = (ref: string): ActionItem => {
    const found = db.read((tx) => tx.list('action_items')).find((i) => i.ref === ref);
    if (found === undefined) throw new Error(`no item ${ref}`);
    return found;
  };
  return { db, clock, meetings, instance, item, rhythm };
}

describe('AC-02-05 on the workspace store', () => {
  it('AC-02-05 an open item due 2026-11-13 has carryCount 1 after the 2026-11-20 review and 2 after the 2026-11-27 monthly review, whose close creates an E2 issue on the 2026-12-04 weekly agenda', async () => {
    const w = world('2026-11-13T09:30:00Z', [
      seriesById('ser_ceo_weekly'),
      seriesById('ser_ceo_monthly'),
    ]);
    const hold = async (local: string, seriesId: string, start: string, end: string) => {
      await w.clock.advanceTo(start);
      const { ref } = w.instance(local, seriesId);
      w.meetings.start(user, ref);
      w.meetings.confirmReadBack(user, ref);
      await w.clock.advanceTo(end);
      return w.meetings.close(user, ref);
    };
    const nightly = async (from: string, days: number) => {
      for (let day = 0; day < days; day++) {
        await w.clock.advanceTo(new Date(Date.parse(from) + day * 86_400_000));
        w.meetings.escalate();
      }
    };

    const first = await hold(
      '2026-11-13T15:00',
      'ser_ceo_weekly',
      '2026-11-13T09:30:00Z',
      '2026-11-13T10:30:00Z',
    );
    expect(first.carried).not.toContain('A-0142');
    expect(w.item('A-0142').carryCount).toBe(0);
    await nightly('2026-11-13T18:35:00Z', 7);
    expect(w.item('A-0142')).toMatchObject({ escalationLevel: 1, health: 'off_track' });

    const second = await hold(
      '2026-11-20T15:00',
      'ser_ceo_weekly',
      '2026-11-20T09:30:00Z',
      '2026-11-20T10:30:00Z',
    );
    expect(second.carried).toContain('A-0142');
    expect(w.item('A-0142').carryCount).toBe(1);
    await nightly('2026-11-20T18:35:00Z', 7);
    expect(w.item('A-0142').escalationLevel).toBe(1);
    const escalationIssues = () =>
      w.db
        .read((tx) => tx.list('issues'))
        .filter(
          (issue) =>
            issue.raisedFrom.kind === 'escalation' &&
            issue.raisedFrom.actionItemId === w.item('A-0142').id,
        );
    expect(escalationIssues()).toEqual([]);

    // The last Friday: the monthly review absorbs the weekly one (AC-02-02) and closes for both.
    expect(w.instance('2026-11-27T15:00', 'ser_ceo_weekly').state).toBe('absorbed');
    const third = await hold(
      '2026-11-27T15:00',
      'ser_ceo_monthly',
      '2026-11-27T09:30:00Z',
      '2026-11-27T11:30:00Z',
    );
    expect(third.carried).toContain('A-0142');
    expect(w.item('A-0142')).toMatchObject({ carryCount: 2, escalationLevel: 2 });
    const [issue] = escalationIssues();
    expect(issue).toMatchObject({ workstreamId: 'ws_ald', status: 'open' });
    expect(w.item('A-0142').links.issueIds).toContain(issue?.id);
    const monthly = w.instance('2026-11-27T15:00', 'ser_ceo_monthly');
    const raised = w.db.read((tx) => tx.history('issue', issue?.id ?? ''));
    expect(raised.map((e) => [e.type, e.correlationId])).toEqual([['issue.raised', monthly.id]]);
    await nightly('2026-11-27T18:35:00Z', 7);
    expect(escalationIssues()).toHaveLength(1);

    w.meetings.prepare(
      { actor: { kind: 'system', component: 'rhythm' } },
      w.instance('2026-12-04T15:00', 'ser_ceo_weekly').ref,
    );
    const next = w.instance('2026-12-04T15:00', 'ser_ceo_weekly');
    const listed = next.agenda
      .filter((row) => row.sectionId === 'issues')
      .flatMap((row) => row.inputResults.flatMap((r) => r.itemRefs));
    expect(listed).toContain(issue?.ref);
  });

  it('C-02-05 the close carries each item once for its instance, records the review sightings, and a closed meeting cannot close again', async () => {
    const w = world('2026-11-20T09:30:00Z', [seriesById('ser_ceo_weekly')]);
    const { ref, id } = w.instance('2026-11-20T15:00', 'ser_ceo_weekly');
    w.meetings.start(user, ref);
    w.meetings.confirmReadBack(user, ref);
    await w.clock.advanceTo('2026-11-20T10:30:00Z');
    const closed = w.meetings.close(user, ref);
    // A-0144 (due 11-18) and A-0160 (due 11-19) are overdue at the 11-20 review too.
    expect(closed.carried).toEqual(['A-0142', 'A-0144', 'A-0160']);
    const history = w.db.read((tx) => tx.history('action_item', w.item('A-0142').id));
    expect(history.map((e) => e.type)).toEqual([
      'action_item.created',
      'action_item.carried',
      'action_item.health_set',
      'action_item.escalated',
      'action_item.reviewed',
    ]);
    expect(history.find((e) => e.type === 'action_item.carried')?.after).toMatchObject({
      carryCount: 1,
      meetingId: id,
    });
    expect(history.at(-1)?.after).toEqual({ health: 'off_track', meetingId: id });
    // Every in-scope item being worked on is sighted; other workstreams are not.
    const sighted = closed.escalation?.reviewed.map((s) => s.ref).sort();
    expect(sighted).toEqual(['A-0142', 'A-0144', 'A-0160']);

    const again = (() => {
      try {
        w.meetings.close(user, ref);
      } catch (error) {
        return error as { code: string };
      }
      throw new Error('expected a rejection');
    })();
    expect(again.code).toBe('E_INVARIANT');
    expect(w.item('A-0142').carryCount).toBe(1);
  });
});

describe('AC-02-08 on the workspace store', () => {
  it('AC-02-08 export-ics --weeks 13 gives one event per instance, and a re-export after a time change raises SEQUENCE for the changed events only', async () => {
    const w = world('2026-11-04T04:10:00Z', [...scenarioSeries(), wigSeries()]);
    const first = w.meetings.exportIcs(13);
    const before = new Map(parseIcs(first.ics).map((e) => [e.uid, e]));
    expect(before.size).toBe(first.instances.length);
    const exported = w.db
      .read((tx) => tx.list('meeting_instances'))
      .filter((i) => first.instances.includes(i.ref));
    expect(exported.every((i) => i.state === 'scheduled')).toBe(true);
    for (const instance of exported) {
      expect(before.get(`${instance.id}@command-center`)).toMatchObject({
        start: instance.scheduledStart,
        end: instance.scheduledEnd,
        sequence: 0,
      });
    }

    await w.clock.advanceTo('2026-11-18T04:00:00Z');
    w.rhythm.clock.set('2026-11-18T04:00:00Z');
    const rhythmStore = storeRhythmStore(w.db);
    const wig = rhythmStore.listSeries().find((s) => s.id === 'ser_goal_wig') as MeetingSeries;
    const changed = updateSeries(
      w.rhythm.ctx,
      user,
      wig,
      { rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=16;BYMINUTE=0' },
      {
        activeWorkstreamIds: ['ws_ald', 'ws_qlm', 'ws_goal'],
        placement: scenarioPlacement(),
      },
    );
    rhythmStore.commit(changed.changes);
    extendHorizon(rhythmStore, w.rhythm.ctx, scenarioPlacement());

    const second = parseIcs(w.meetings.exportIcs(13).ics);
    const moved = second.filter((e) => before.has(e.uid) && before.get(e.uid)?.start !== e.start);
    const same = second.filter((e) => before.get(e.uid)?.start === e.start);
    expect(moved.length).toBeGreaterThan(5);
    for (const event of moved) {
      expect(localOf(event.start).slice(11)).toBe('16:00');
      expect(event.sequence).toBe(1);
    }
    expect(same.length).toBeGreaterThan(100);
    expect(same.every((e) => e.sequence === 0)).toBe(true);
  });
});
