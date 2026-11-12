/**
 * The pre-read (02 §6.2, §4.7; P1-08): the snapshot and its Markdown view, their hashes, the
 * update-needed list, the backup standing line, rebuilding until start and immutability after
 * (C-02-03), and the live diff.
 */
import { describe, expect, it } from 'vitest';

import {
  agendaTemplate,
  applyPreread,
  BACKUP_STANDING_LINE,
  buildPreread,
  canonicalJson,
  diffInputs,
  isDuePreread,
  packSection,
  startMeeting,
  type PrereadInput,
} from '@cc/rhythm';
import type { MeetingInstance } from '@cc/schemas';

import { checkChanges, failure } from './harness.ts';
import {
  agent,
  instanceOf,
  item,
  meetingData,
  meetingHarness,
  rhythmCaller,
  seriesById,
  sha256,
  user,
  type DataOverrides,
} from './meetings-harness.ts';

const weeklySeries = seriesById('ser_ceo_weekly');
const marketing = [{ slot: 'after:headlines', section: packSection('content_review') }];

function input(
  instance: MeetingInstance,
  overrides: DataOverrides = {},
  extra: Partial<PrereadInput> = {},
): PrereadInput {
  return {
    series: seriesById(instance.seriesId),
    instance,
    template: agendaTemplate(seriesById(instance.seriesId).agendaTemplateId),
    packSections: marketing,
    data: meetingData(overrides),
    now: '2026-11-12T09:30:00Z',
    sha256,
    ...extra,
  };
}

const held = instanceOf('ser_ceo_weekly', '2026-11-06T15:00', {
  state: 'completed',
  actualStart: '2026-11-06T09:30:00Z',
  actualEnd: '2026-11-06T10:30:00Z',
});

describe('02 §6.2 the pre-read snapshot', () => {
  it('composes the agenda with pack sections and fills every section from its inputs', () => {
    const instance = instanceOf('ser_ceo_weekly', '2026-11-13T15:00');
    const built = buildPreread(input(instance));
    expect(
      built.agenda.map((row) => [row.sectionId, row.workstreamId ?? null, row.timeboxMinutes]),
    ).toEqual([
      ['check_in', null, 2],
      ['scorecard', 'ws_ald', 4],
      ['goals_review', 'ws_ald', 3],
      ['action_review', 'ws_ald', 7],
      ['scorecard', 'ws_qlm', 4],
      ['goals_review', 'ws_qlm', 3],
      ['action_review', 'ws_qlm', 7],
      ['headlines', null, 3],
      ['content_review', null, 5],
      ['issues', null, 17],
      ['conclude', null, 5],
    ]);
    const dryActions = built.agenda[3];
    expect(dryActions?.inputResults).toEqual([
      { queryId: 'due', count: 1, itemRefs: ['A-0142'], flags: [] },
      { queryId: 'claimed', count: 0, itemRefs: [], flags: ['no_previous_instance'] },
    ]);
    expect(built.agenda.every((row) => row.status === 'pending')).toBe(true);
  });

  it('is canonical JSON plus Markdown, hashed with SHA-256, with no AI summary', () => {
    const built = buildPreread(input(instanceOf('ser_ceo_weekly', '2026-11-13T15:00')));
    expect(built.json).toBe(canonicalJson(JSON.parse(built.json)));
    expect(built.snapshotSha256).toBe(sha256(built.json));
    expect(built.renderedSha256).toBe(sha256(built.markdown));
    expect(built.snapshot.format).toBe('cc.preread@1');
    expect(built.markdown.split('\n').slice(0, 3)).toEqual([
      '# Pre-read: Weekly CEO review',
      '',
      `${built.snapshot.instance.ref} · 2026-11-13 15:00-16:00 (Asia/Kolkata) · built 2026-11-12T09:30:00Z`,
    ]);
    expect(built.markdown).toContain('## 4. Action review · Alderwick · 7 min');
    expect(built.markdown).toContain(
      '| A-0142 | Send revised proposal with phased pricing to the consulting lead | Alderwick |',
    );
    expect(built.markdown).not.toMatch(/AI-drafted|summary/i);
  });

  it('the same data hashes the same; a later build differs only in its build time', () => {
    const instance = instanceOf('ser_ceo_weekly', '2026-11-13T15:00');
    const a = buildPreread(input(instance));
    const b = buildPreread(input(instance));
    const c = buildPreread(input(instance, {}, { now: '2026-11-12T12:00:00Z' }));
    expect([b.snapshotSha256, b.renderedSha256, b.inputsHash]).toEqual([
      a.snapshotSha256,
      a.renderedSha256,
      a.inputsHash,
    ]);
    expect(c.inputsHash).toBe(a.inputsHash);
    expect(c.snapshotSha256).not.toBe(a.snapshotSha256);
  });

  it('02 §4.7: items with no update since the previous instance form the "Update needed" list', () => {
    const instance = instanceOf('ser_ceo_weekly', '2026-11-13T15:00');
    const built = buildPreread(
      input(instance, {
        actionItems: [item('A-0142', { updatedAt: '2026-11-05T00:00:00Z' })],
        instances: [held, instance],
      }),
    );
    expect(built.snapshot.updateNeeded.map((row) => row.ref)).toEqual(['A-0142']);
    expect(built.markdown).toContain('## Update needed\n\n- A-0142 Send revised proposal');
  });

  it('Q8: while the backup is not configured, the merged weekly review shows the standing line under headlines', () => {
    const instance = instanceOf('ser_ceo_weekly', '2026-11-13T15:00');
    const built = buildPreread(input(instance, {}, { backupState: 'not_configured' }));
    const lines = built.snapshot.sections.map((s) => [s.sectionId, s.standingLines]);
    expect(lines.filter(([, standing]) => (standing as string[]).length > 0)).toEqual([
      ['headlines', [BACKUP_STANDING_LINE]],
    ]);
    expect(built.markdown).toContain(`> ${BACKUP_STANDING_LINE}`);
    const configured = buildPreread(input(instance, {}, { backupState: 'healthy' }));
    expect(configured.markdown).not.toContain(BACKUP_STANDING_LINE);
    const wig = instanceOf('ser_goal_wig', '2026-11-16T13:15');
    const other = buildPreread(input(wig, {}, { backupState: 'not_configured', packSections: [] }));
    expect(other.markdown).not.toContain(BACKUP_STANDING_LINE);
  });

  it('an absorbing instance resolves the absorbed sections over the absorbed series', () => {
    const weekly = instanceOf('ser_ceo_weekly', '2026-11-27T15:00', { state: 'absorbed' });
    const monthly = instanceOf('ser_ceo_monthly', '2026-11-27T15:00', {
      absorbedInstanceIds: [weekly.id],
      scheduledEnd: '2026-11-27T11:30:00Z',
    });
    const built = buildPreread({
      ...input(monthly),
      absorbed: [
        {
          instance: weekly,
          series: weeklySeries,
          template: agendaTemplate(weeklySeries.agendaTemplateId),
          packSections: marketing,
        },
      ],
    });
    const absorbed = built.agenda.filter((row) => row.absorbedFrom === weekly.id);
    expect(absorbed.reduce((sum, row) => sum + row.timeboxMinutes, 0)).toBe(30);
    expect(
      absorbed.find((row) => row.sectionId === 'action_review' && row.workstreamId === 'ws_qlm')
        ?.inputResults[0]?.itemRefs,
    ).toEqual(['A-0144']);
    expect(built.markdown).toContain('· absorbed ·');
  });
});

describe('recording the pre-read on the instance (02 §4.2, C-02-03)', () => {
  it('sets prepared with the hashes, one event; a rebuild with the same inputs writes nothing', () => {
    const { ctx } = meetingHarness('2026-11-12T09:30:00Z');
    const instance = instanceOf('ser_ceo_weekly', '2026-11-13T15:00');
    const built = buildPreread(input(instance));
    const outcome = applyPreread(ctx, rhythmCaller, weeklySeries, instance, built);
    checkChanges(outcome.changes);
    expect(outcome.changes.map((c) => c.event.type)).toEqual(['meeting_instance.prepared']);
    expect(outcome.record.state).toBe('prepared');
    expect(outcome.record.preread).toEqual({
      builtAt: '2026-11-12T09:30:00Z',
      snapshotSha256: built.snapshotSha256,
      renderedSha256: built.renderedSha256,
      inputsHash: built.inputsHash,
    });
    const again = buildPreread(input(outcome.record, {}, { now: '2026-11-12T10:00:00Z' }));
    expect(applyPreread(ctx, user, weeklySeries, outcome.record, again).status).toBe('no-op');
  });

  it('the user rebuilds it on demand until start when the data changed', () => {
    const { ctx } = meetingHarness('2026-11-12T09:30:00Z');
    const instance = instanceOf('ser_ceo_weekly', '2026-11-13T15:00');
    const prepared = applyPreread(
      ctx,
      rhythmCaller,
      weeklySeries,
      instance,
      buildPreread(input(instance)),
    ).record;
    const changed = buildPreread(
      input(prepared, {
        actionItems: [
          item('A-0142'),
          item('A-0160', { due: { date: '2026-11-13', timeZone: 'Asia/Kolkata' } }),
        ],
      }),
    );
    const rebuilt = applyPreread(ctx, user, weeklySeries, prepared, changed);
    expect(rebuilt.changes.map((c) => c.event.type)).toEqual(['meeting_instance.preread_rebuilt']);
    expect(rebuilt.record.agenda[3]?.inputResults[0]?.itemRefs).toEqual(['A-0142', 'A-0160']);
  });

  it('C-02-03 the pre-read is immutable after the meeting starts', () => {
    const { ctx } = meetingHarness('2026-11-12T09:30:00Z');
    const instance = instanceOf('ser_ceo_weekly', '2026-11-13T15:00');
    const prepared = applyPreread(
      ctx,
      rhythmCaller,
      weeklySeries,
      instance,
      buildPreread(input(instance)),
    ).record;
    const started = startMeeting(ctx, user, prepared).record;
    const built = failure(() => buildPreread(input(started)));
    expect([built.code, built.rule]).toEqual(['E_INVARIANT', 'C-02-03']);
    const fresh = buildPreread(input(prepared));
    const applied = failure(() => applyPreread(ctx, user, weeklySeries, started, fresh));
    expect([applied.code, applied.rule]).toEqual(['E_INVARIANT', 'C-02-03']);
    const done = { ...started, state: 'completed' as const };
    expect(failure(() => buildPreread(input(done))).rule).toBe('C-02-03');
  });

  it('a series with a calendar binding is prepared only once scheduled; agents never build pre-reads', () => {
    const { ctx } = meetingHarness();
    const bound = {
      ...weeklySeries,
      calendars: [
        {
          bindingId: 'bnd_gcal' as never,
          calendarId: 'cc',
          role: 'primary' as const,
          titleTemplate: '[CC] {{series.name}}',
          inviteAttendees: false,
        },
      ],
    };
    const instance = instanceOf('ser_ceo_weekly', '2026-11-13T15:00');
    const refused = failure(() => buildPreread({ ...input(instance), series: bound }));
    expect([refused.code, refused.rule]).toEqual(['E_INVARIANT', '02 §4.2']);
    const scheduled = { ...instance, state: 'scheduled' as const };
    expect(
      applyPreread(
        ctx,
        rhythmCaller,
        bound,
        scheduled,
        buildPreread({ ...input(scheduled), series: bound }),
      ).record.state,
    ).toBe('prepared');
    const byAgent = failure(() =>
      applyPreread(ctx, agent, weeklySeries, instance, buildPreread(input(instance))),
    );
    expect(byAgent.code).toBe('E_FORBIDDEN');
  });

  it('02 §4.7: the first pre-read with an update-needed list notifies once', () => {
    const { ctx } = meetingHarness('2026-11-12T09:30:00Z');
    const instance = instanceOf('ser_ceo_weekly', '2026-11-13T15:00');
    const stale = {
      actionItems: [item('A-0142', { updatedAt: '2026-11-05T00:00:00Z' })],
      instances: [held, instance],
    };
    const firstBuild = applyPreread(
      ctx,
      rhythmCaller,
      weeklySeries,
      instance,
      buildPreread(input(instance, stale)),
    );
    expect(firstBuild.notify).toBe(true);
    const more = {
      ...stale,
      actionItems: [
        ...stale.actionItems,
        item('A-0160', {
          due: { date: '2026-11-13', timeZone: 'Asia/Kolkata' },
          updatedAt: '2026-11-05T00:00:00Z',
        }),
      ],
    };
    const rebuilt = applyPreread(
      ctx,
      user,
      weeklySeries,
      firstBuild.record,
      buildPreread(input(firstBuild.record, more)),
    );
    expect([rebuilt.status, rebuilt.notify]).toEqual(['ok', false]);
  });

  it('02 §4.7: the pre-read is due at start − prereadLeadMinutes, until the meeting would end', () => {
    const instance = instanceOf('ser_ceo_weekly', '2026-11-13T15:00');
    expect(isDuePreread(weeklySeries, instance, '2026-11-12T09:29:59Z')).toBe(false);
    expect(isDuePreread(weeklySeries, instance, '2026-11-12T09:30:00Z')).toBe(true);
    expect(isDuePreread(weeklySeries, instance, '2026-11-13T10:30:00Z')).toBe(false);
    const daily = seriesById('ser_daily_start');
    const morning = instanceOf('ser_daily_start', '2026-11-13T09:00');
    expect(isDuePreread(daily, morning, '2026-11-13T03:00:00Z')).toBe(true);
    expect(isDuePreread(daily, morning, '2026-11-13T02:59:00Z')).toBe(false);
    expect(
      isDuePreread({ ...weeklySeries, status: 'paused' }, instance, '2026-11-12T10:00:00Z'),
    ).toBe(false);
  });
});

describe('02 §6.2 rule 2: live data next to the snapshot', () => {
  it('lists the refs added and removed per input', () => {
    const instance = instanceOf('ser_ceo_weekly', '2026-11-13T15:00');
    const snapshot = buildPreread(input(instance)).agenda;
    const live = buildPreread(
      input(instance, {
        actionItems: [item('A-0160', { due: { date: '2026-11-13', timeZone: 'Asia/Kolkata' } })],
      }),
    ).agenda;
    expect(diffInputs(snapshot, live)).toEqual([
      {
        sectionId: 'action_review',
        workstreamId: 'ws_ald',
        queryId: 'due',
        before: 1,
        after: 1,
        added: ['A-0160'],
        removed: ['A-0142'],
      },
    ]);
    expect(diffInputs(snapshot, snapshot)).toEqual([]);
  });
});
