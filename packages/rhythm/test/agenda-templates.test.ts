/**
 * The agenda templates of 02 §5 (P1-08): their data, the timebox columns of 02 §5.1, pack
 * sections in extension slots (02 §5.1, §5.5), the backbone orders the framework invariants fix
 * (E-1, X-3, PO-4), absorption on the real templates (AC-02-02's agenda) and the templates the
 * framework catalogue names.
 */
import { describe, expect, it } from 'vitest';

import { builtTemplates } from '@cc/frameworks';
import {
  AGENDA_TEMPLATES,
  agendaTemplate,
  composeAgenda,
  defaultTimebox,
  PACK_SECTIONS,
  packSection,
  sectionBounds,
  withPackSections,
} from '@cc/rhythm';
import { AgendaSectionTemplate, AgendaTemplate, type AgendaSectionInstance } from '@cc/schemas';

import { failure, seriesById } from './harness.ts';

const minutes = (agenda: readonly AgendaSectionInstance[]) =>
  agenda.reduce((sum, row) => sum + row.timeboxMinutes, 0);
const rows = (agenda: readonly AgendaSectionInstance[]) =>
  agenda.map((row) => [row.sectionId, row.workstreamId ?? null, row.timeboxMinutes]);

const SOLO = { agendaOverrides: [], mode: 'solo' as const };

describe('02 §5 agenda templates', () => {
  it('every template and pack section is valid against the agenda_template@1 schema', () => {
    for (const template of AGENDA_TEMPLATES) {
      expect(AgendaTemplate.safeParse(template).error?.issues ?? []).toEqual([]);
    }
    for (const section of PACK_SECTIONS) {
      expect(AgendaSectionTemplate.safeParse(section).error?.issues ?? []).toEqual([]);
    }
  });

  it('each solo column sums to the meeting length of 02 §5', () => {
    const lengths: Record<string, number> = {
      'agenda.eos-lite.weekly@1': 60,
      'agenda.eos-lite.monthly@1': 90,
      'agenda.eos-lite.quarterly@1': 240,
      'agenda.eos-lite.yearly@1': 240,
      'agenda.eos-lite.daily@1': 10,
      'agenda.4dx.wig-session@1': 30,
      'agenda.personal-os.daily@1': 10,
      'agenda.personal-os.weekly@1': 45,
      'agenda.personal-os.monthly@1': 60,
      'agenda.personal-os.quarterly@1': 90,
      'agenda.portfolio.daily-start@1': 10,
      'agenda.portfolio.daily-shutdown@1': 10,
    };
    for (const template of AGENDA_TEMPLATES) {
      const total = template.sections.reduce((sum, s) => sum + s.timeboxMinutes, 0);
      expect([template.id, total]).toEqual([template.id, lengths[template.id]]);
    }
    expect(Object.keys(lengths).sort()).toEqual(AGENDA_TEMPLATES.map((t) => t.id).sort());
  });

  it('the section bounds follow the rule: half the smallest column, twice the largest', () => {
    expect(sectionBounds([2, 5, 2])).toEqual({ min: 1, max: 10 });
    expect(sectionBounds([30, 30, 22])).toEqual({ min: 11, max: 60 });
    expect(sectionBounds([1])).toEqual({ min: 1, max: 2 });
    const issues = agendaTemplate('agenda.eos-lite.weekly@1').sections.find(
      (s) => s.id === 'issues',
    );
    expect([issues?.minMinutes, issues?.maxMinutes]).toEqual([11, 60]);
    // Explicit bounds win where 02 §5 gives them.
    const content = packSection('content_review');
    expect([content.minMinutes, content.timeboxMinutes, content.maxMinutes]).toEqual([5, 5, 15]);
  });

  it('the yearly review is 240 minutes solo and 480 team in the 02 §5.4 split the owner decided', () => {
    const yearly = agendaTemplate('agenda.eos-lite.yearly@1');
    expect(yearly.sections.map((s) => [s.id, s.timeboxMinutes, s.variants?.team])).toEqual([
      ['retrospective', 60, 120],
      ['planning_v2mom', 75, 150],
      ['planning_goals', 60, 120],
      ['rhythm_health', 30, 60],
      ['conclude', 15, 30],
    ]);
    const team = composeAgenda({
      template: yearly,
      series: {
        workstreamIds: ['ws_ald'],
        durationMinutes: 480,
        agendaOverrides: [],
        mode: 'team',
      },
    });
    expect(minutes(team)).toBe(480);
  });

  it('every agenda template a framework references exists', () => {
    const named = builtTemplates.flatMap((t) =>
      t.backbone.meetings.map((m) => [t.id, m.key, m.agendaTemplateId] as const),
    );
    expect(named.length).toBeGreaterThan(0);
    const defined = new Set(AGENDA_TEMPLATES.map((t) => t.id));
    expect(named.filter(([, , id]) => !defined.has(id))).toEqual([]);
    for (const [, , id] of named) expect(agendaTemplate(id).id).toBe(id);
  });

  it("every referenced template fits its meeting's catalogue durations in each mode", () => {
    for (const framework of builtTemplates) {
      for (const meeting of framework.backbone.meetings) {
        const template = agendaTemplate(meeting.agendaTemplateId);
        const { min, max } = meeting.durationMinutes;
        for (const mode of meeting.modes) {
          for (const durationMinutes of [min, meeting.durationMinutes.default, max]) {
            const agenda = composeAgenda({
              template,
              series: { workstreamIds: ['ws_ald'], durationMinutes, agendaOverrides: [], mode },
            });
            // Fitting only shrinks (02 §4.4 rule 4): never over, exactly the minimum at the minimum.
            const total = minutes(agenda);
            const label = [framework.id, meeting.key, mode, durationMinutes];
            expect([...label, total <= durationMinutes]).toEqual([...label, true]);
            if (durationMinutes === min) expect([...label, total]).toEqual([...label, min]);
          }
        }
      }
    }
  });

  it('an agenda template ID 02 §5 does not define fails E_NOT_FOUND naming 02 §5', () => {
    const error = failure(() => agendaTemplate('agenda.personal-os.yearly@1'));
    expect([error.code, error.rule]).toEqual(['E_NOT_FOUND', '02 §5']);
  });
});

describe('02 §5.8 to §5.11 the templates derived for the framework catalogue', () => {
  const shape = (id: string) =>
    agendaTemplate(id).sections.map((s) => [s.id, s.type, s.timeboxMinutes, s.backbone]);

  it('the eos-lite daily is the weekly cut to check-in, to-dos, headlines and conclude', () => {
    expect(shape('agenda.eos-lite.daily@1')).toEqual([
      ['check_in', 'check_in', 1, true],
      ['action_review', 'action_review', 4, true],
      ['headlines', 'headlines', 3, true],
      ['conclude', 'conclude', 2, true],
    ]);
    // Team only: team mode takes the one column.
    const team = composeAgenda({
      template: agendaTemplate('agenda.eos-lite.daily@1'),
      series: { workstreamIds: ['ws_ald'], durationMinutes: 10, agendaOverrides: [], mode: 'team' },
    });
    expect(rows(team)).toEqual([
      ['check_in', null, 1],
      ['action_review', 'ws_ald', 4],
      ['headlines', null, 3],
      ['conclude', null, 2],
    ]);
  });

  it('the personal-os daily is the portfolio daily start, capturing action items and notes only', () => {
    const daily = agendaTemplate('agenda.personal-os.daily@1');
    const start = agendaTemplate('agenda.portfolio.daily-start@1');
    expect(shape(daily.id)).toEqual(shape(start.id));
    expect(daily.sections.map((s) => s.inputs)).toEqual(start.sections.map((s) => s.inputs));
    for (const s of daily.sections) expect(s.allowedOutputs).toEqual(['action_item', 'note']);
  });

  it('the personal-os monthly is the eos-lite monthly without money_ops, in 60 minutes', () => {
    const eos = agendaTemplate('agenda.eos-lite.monthly@1').sections.map((s) => s.type);
    expect(agendaTemplate('agenda.personal-os.monthly@1').sections.map((s) => s.type)).toEqual(
      eos.filter((type) => type !== 'money_ops'),
    );
    expect(shape('agenda.personal-os.monthly@1')).toEqual([
      ['check_in', 'check_in', 5, true],
      ['scorecard', 'scorecard', 15, true],
      ['register_health', 'register_health', 10, true],
      ['risk_review', 'risk_review', 10, false],
      ['issues', 'issues', 15, true],
      ['conclude', 'conclude', 5, true],
    ]);
  });

  it('the personal-os quarterly is the eos-lite quarterly scaled to 90 minutes', () => {
    const eos = agendaTemplate('agenda.eos-lite.quarterly@1').sections;
    const personal = agendaTemplate('agenda.personal-os.quarterly@1').sections;
    expect(personal.map((s) => [s.id, s.type, s.backbone])).toEqual(
      eos.map((s) => [s.id, s.type, s.backbone]),
    );
    expect(personal.map((s) => s.timeboxMinutes)).toEqual([3, 11, 11, 11, 4, 35, 8, 7]);
    // Each section stays within 1.25 minutes of the exact 90/240 share (02 §5.11).
    personal.forEach((s, i) => {
      expect(Math.abs(s.timeboxMinutes - ((eos[i]?.timeboxMinutes ?? 0) * 90) / 240)).toBeLessThan(
        1.3,
      );
    });
  });
});

describe('02 §5.1 timebox columns', () => {
  const weekly = agendaTemplate('agenda.eos-lite.weekly@1');

  it('team mode takes the team column', () => {
    const agenda = composeAgenda({
      template: weekly,
      series: { workstreamIds: ['ws_ald'], durationMinutes: 60, agendaOverrides: [], mode: 'team' },
    });
    expect(rows(agenda)).toEqual([
      ['check_in', null, 5],
      ['scorecard', 'ws_ald', 5],
      ['goals_review', 'ws_ald', 5],
      ['action_review', 'ws_ald', 5],
      ['headlines', null, 5],
      ['issues', null, 30],
      ['conclude', null, 5],
    ]);
  });

  it('a solo meeting of one workstream takes the solo column', () => {
    const agenda = composeAgenda({
      template: weekly,
      series: { workstreamIds: ['ws_ald'], durationMinutes: 60, ...SOLO },
    });
    expect(rows(agenda)).toEqual([
      ['check_in', null, 2],
      ['scorecard', 'ws_ald', 5],
      ['goals_review', 'ws_ald', 5],
      ['action_review', 'ws_ald', 10],
      ['headlines', null, 3],
      ['issues', null, 30],
      ['conclude', null, 5],
    ]);
  });

  it('the merged weekly CEO review takes the solo merged column exactly (4 + 4, 3 + 3, 7 + 7, 22)', () => {
    const series = seriesById('ser_ceo_weekly');
    const agenda = composeAgenda({ template: weekly, series });
    expect(rows(agenda)).toEqual([
      ['check_in', null, 2],
      ['scorecard', 'ws_ald', 4],
      ['goals_review', 'ws_ald', 3],
      ['action_review', 'ws_ald', 7],
      ['scorecard', 'ws_qlm', 4],
      ['goals_review', 'ws_qlm', 3],
      ['action_review', 'ws_qlm', 7],
      ['headlines', null, 3],
      ['issues', null, 22],
      ['conclude', null, 5],
    ]);
    expect(minutes(agenda)).toBe(60);
  });

  it('defaultTimebox picks the column by mode and workstream count', () => {
    const scorecard = weekly.sections[1];
    if (scorecard === undefined) throw new Error('no scorecard');
    expect(defaultTimebox(scorecard, 'team', 2)).toBe(5);
    expect(defaultTimebox(scorecard, 'solo', 1)).toBe(5);
    expect(defaultTimebox(scorecard, 'solo', 2)).toBe(4);
    expect(defaultTimebox(scorecard, undefined, 3)).toBe(4);
  });
});

describe('pack sections in extension slots', () => {
  it('02 §5.1: pack.marketing adds content_review after headlines, taken from issues first', () => {
    const weekly = withPackSections(agendaTemplate('agenda.eos-lite.weekly@1'), [
      { slot: 'after:headlines', section: packSection('content_review') },
    ]);
    const merged = composeAgenda({ template: weekly, series: seriesById('ser_ceo_weekly') });
    expect(rows(merged).slice(-4)).toEqual([
      ['headlines', null, 3],
      ['content_review', null, 5],
      ['issues', null, 17],
      ['conclude', null, 5],
    ]);
    expect(minutes(merged)).toBe(60);
    const single = composeAgenda({
      template: weekly,
      series: { workstreamIds: ['ws_ald'], durationMinutes: 60, ...SOLO },
    });
    expect(single.find((row) => row.sectionId === 'issues')?.timeboxMinutes).toBe(25);
  });

  it('02 §5.5: without a pack pipeline_review is absent and its minutes stay in plan_commitments', () => {
    const wig = agendaTemplate('agenda.4dx.wig-session@1');
    const series = seriesById('ser_goal_wig');
    expect(rows(composeAgenda({ template: wig, series }))).toEqual([
      ['action_review', null, 8],
      ['scorecard', null, 6],
      ['plan_commitments', null, 14],
      ['conclude', null, 2],
    ]);
    const withPack = withPackSections(wig, [
      { slot: 'before:plan_commitments', section: packSection('pipeline_review') },
    ]);
    expect(rows(composeAgenda({ template: withPack, series }))).toEqual([
      ['action_review', null, 8],
      ['scorecard', null, 6],
      ['pipeline_review', null, 6],
      ['plan_commitments', null, 8],
      ['conclude', null, 2],
    ]);
  });

  it('a pack section for a slot the template lacks is left out, and is added once', () => {
    const monthly = agendaTemplate('agenda.eos-lite.monthly@1');
    const same = withPackSections(monthly, [
      { slot: 'after:headlines', section: packSection('content_review') },
    ]);
    expect(same.sections.map((s) => s.id)).toEqual(monthly.sections.map((s) => s.id));
    const weekly = agendaTemplate('agenda.eos-lite.weekly@1');
    const twice = withPackSections(weekly, [
      { slot: 'after:headlines', section: packSection('content_review') },
      { slot: 'after:headlines', section: packSection('content_review') },
    ]);
    expect(twice.sections.filter((s) => s.id === 'content_review')).toHaveLength(1);
  });
});

describe('backbone orders the framework invariants fix', () => {
  const types = (id: string, workstreams = ['ws_ald']) =>
    composeAgenda({
      template: agendaTemplate(id),
      series: { workstreamIds: workstreams as never, durationMinutes: 999, ...SOLO },
    }).map((row) => {
      const section = agendaTemplate(id).sections.find((s) => s.id === row.sectionId);
      return section?.type;
    });

  it('E-1: check_in → scorecard → goals_review → action_review → headlines → issues → conclude', () => {
    expect(types('agenda.eos-lite.weekly@1')).toEqual([
      'check_in',
      'scorecard',
      'goals_review',
      'action_review',
      'headlines',
      'issues',
      'conclude',
    ]);
  });

  it('X-3: action_review → scorecard → plan_commitments → conclude', () => {
    expect(types('agenda.4dx.wig-session@1')).toEqual([
      'action_review',
      'scorecard',
      'plan_commitments',
      'conclude',
    ]);
  });

  it('PO-4: check_in → scorecard → goals_review → action_review → plan_commitments → conclude', () => {
    expect(types('agenda.personal-os.weekly@1')).toEqual([
      'check_in',
      'scorecard',
      'goals_review',
      'action_review',
      'plan_commitments',
      'conclude',
    ]);
  });

  it('E-8: the monthly review includes register health', () => {
    expect(types('agenda.eos-lite.monthly@1')).toContain('register_health');
  });

  it('02 §5.7: the daily start is attention then top three; the shutdown day close then top three', () => {
    expect(types('agenda.portfolio.daily-start@1')).toEqual(['attention', 'top_three']);
    expect(types('agenda.portfolio.daily-shutdown@1')).toEqual(['day_close', 'top_three']);
    for (const id of ['agenda.portfolio.daily-start@1', 'agenda.portfolio.daily-shutdown@1']) {
      for (const section of agendaTemplate(id).sections) {
        expect(section.allowedOutputs).toEqual(['action_item', 'note']);
      }
    }
  });
});

describe('AC-02-02 absorption on the real templates', () => {
  it('AC-02-02 the monthly instance begins with the weekly backbone sections compressed to 30 minutes, then its own 90', () => {
    const weekly = seriesById('ser_ceo_weekly');
    const monthly = seriesById('ser_ceo_monthly');
    const agenda = composeAgenda({
      template: agendaTemplate(monthly.agendaTemplateId),
      series: monthly,
      absorbed: [
        {
          instanceId: 'mtg_weekly_20261127',
          template: agendaTemplate(weekly.agendaTemplateId),
          series: weekly,
          absorbedMinutes: 30,
        },
      ],
    });
    const absorbed = agenda.filter((row) => row.absorbedFrom === 'mtg_weekly_20261127');
    const own = agenda.filter((row) => row.absorbedFrom === undefined);
    expect(agenda.slice(0, absorbed.length)).toEqual(absorbed);
    expect(absorbed.map((row) => [row.sectionId, row.workstreamId ?? null])).toEqual([
      ['check_in', null],
      ['scorecard', 'ws_ald'],
      ['goals_review', 'ws_ald'],
      ['action_review', 'ws_ald'],
      ['scorecard', 'ws_qlm'],
      ['goals_review', 'ws_qlm'],
      ['action_review', 'ws_qlm'],
      ['headlines', null],
      ['issues', null],
      ['conclude', null],
    ]);
    expect(minutes(absorbed)).toBe(30);
    expect(minutes(own)).toBe(90);
    expect(minutes(agenda)).toBe(120);
  });
});
