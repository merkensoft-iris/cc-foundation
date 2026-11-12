/**
 * S6: the composed weekly rhythm (01 §3 S6, §7.3; 02 §4). P1-07 takes series as explicit specs;
 * composing them from the onboarding answers is this step's (owner decision, key p1-07-spec,
 * 11 Nov 2026). Everything here is deterministic: the same answers give the same series.
 *
 * Per framework instance, every required backbone meeting, and every optional one whose
 * `<key>.enabled` parameter is on, becomes one series:
 *
 * - `weekly`: the `weekly.weekday`, `weekly.time` and `weekly.duration` parameters (Q-T01).
 * - `daily` (personal-os): every workweek day at `daily.time`.
 * - `monthly`: the weekly meeting's weekday and time, in the first or last week of the month
 *   (`monthly.week`, default the last). The eos-lite monthly review absorbs that week's weekly
 *   meeting with 30 absorbed minutes (02 §5.2, §4.3).
 * - `quarterly`: the last month of each quarter, on the weekly meeting's weekday of the week
 *   `quarterly.weekOfQuarter` counts from the month's end (default the last).
 * - `yearly`: the second such weekday of December.
 *
 * Quarterly and yearly sessions are long. Their time is the first of these starts at which the
 * first session fits inside working hours, clear of hard protected blocks and of the other CC
 * meetings that day: the weekly meeting's time, then the start of each soft protected block
 * (time the user set aside, where "CC may suggest a meeting, but I have to confirm it"), then
 * the start of each working-hours range. A start inside a soft block needs the user's
 * confirmation at S6 (02 §4.6 rule 1). This rule reproduces 02 §8.1: quarterly planning and the
 * annual review start at 09:45, inside the soft "Deep block A".
 *
 * Workstreams in one merge group (01 rule M8) whose S5 answer keeps the merge (Q-T02) share
 * one series per meeting, timed by the first of them (02 §4.4). A client engagement or project
 * with a parent (R5) adds its block to its root's weekly series. The daily start and daily
 * shutdown (02 §4.5) run every workweek day at the start of the first working-hours range and
 * ten minutes before its end, over every workstream, unless the user turned them off (S6).
 */
import {
  addDays,
  addMinutes,
  blockIntervals,
  canonicalRule,
  compareInstants,
  firstOccurrenceOnOrAfter,
  localDateTime,
  minutesOfDay,
  timeOfDay,
  wallClockInstantCompatible,
} from '@cc/rhythm';
import type {
  BackboneMeeting,
  FrameworkTemplate,
  MeetingSeries,
  WorkspaceAnswers,
} from '@cc/schemas';

/** The 02 §8.1 portfolio length, and how long before the day's end the shutdown starts. */
export const PORTFOLIO_MINUTES = 10;

/** 02 §5.2: the eos-lite monthly review absorbs the weekly meeting with 30 minutes. */
const ABSORBS: Readonly<Record<string, MeetingSeries['absorbs']>> = {
  'agenda.eos-lite.monthly@1': [{ cadence: 'weekly', absorbedMinutes: 30 }],
};

/** Series names: what a calendar title shows (02 §8.1); no workstream or client names. */
const NAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'eos-lite': {
    weekly: 'Weekly leadership meeting',
    monthly: 'Monthly review',
    quarterly: 'Quarterly planning',
    yearly: 'Annual review',
    daily: 'Daily check-in',
  },
  '4dx': { weekly: 'WIG session' },
  'personal-os': {
    weekly: 'Weekly review',
    daily: 'Daily plan',
    monthly: 'Monthly review',
    quarterly: 'Quarterly reset',
  },
};

/** One framework instance as composition needs it. */
export interface InstanceInput {
  readonly instanceId: string;
  readonly workstreamId: string;
  readonly workstreamKey: string;
  readonly template: FrameworkTemplate;
  readonly mode: 'solo' | 'team';
  /** Defaults filled in (01 §5). */
  readonly parameters: Readonly<Record<string, unknown>>;
  /** M8's group, when the S5 answer keeps the merge. */
  readonly mergeGroup?: string;
  /** R5 children whose block goes into this instance's weekly meeting. */
  readonly childWorkstreamIds: readonly string[];
}

/** A composed series before the rhythm engine checks and stores it. */
export interface ComposedSeries {
  readonly key: string;
  readonly spec: Omit<
    MeetingSeries,
    | 'id'
    | 'dtstart'
    | 'status'
    | 'prereadLeadMinutes'
    | 'reminderMinutes'
    | 'graceMinutes'
    | 'createdAt'
    | 'createdBy'
    | 'updatedAt'
    | 'updatedBy'
    | 'version'
  >;
  /** The backbone meeting it implements; absent for the portfolio series. */
  readonly backbone?: BackboneMeeting;
  /** The workstream keys it covers, for the preview and the S6 confirmations. */
  readonly workstreamKeys: readonly string[];
  /** The instances whose meeting it carries. */
  readonly instanceIds: readonly string[];
}

export interface ComposeInput {
  readonly workspace: WorkspaceAnswers;
  readonly selfPersonId: string;
  readonly instances: readonly InstanceInput[];
  /** Every workstream the portfolio series cover (02 §4.5), with its key. */
  readonly portfolio: readonly { readonly id: string; readonly key: string }[];
  readonly dailyStart: boolean;
  readonly dailyShutdown: boolean;
  /** The local date the rhythm starts (a Monday). */
  readonly startsOn: string;
  /** T1's `shorten` fix: every meeting at its backbone minimum (01 §6.4). */
  readonly shorten?: boolean;
  /** T1's `biweekly` fix: personal-os weekly reviews every other week. */
  readonly biweekly?: boolean;
}

const hhmm = (value: unknown, fallback: string): string =>
  typeof value === 'string' && /^\d{2}:\d{2}$/.test(value) ? value : fallback;

function at(time: string): string {
  const [hour, minute] = time.split(':').map(Number);
  return `BYHOUR=${String(hour)};BYMINUTE=${String(minute)}`;
}

function durationOf(meeting: BackboneMeeting, mode: 'solo' | 'team', shorten: boolean): number {
  if (shorten) return meeting.durationMinutes.min;
  return meeting.durationMinutes.defaultByMode?.[mode] ?? meeting.durationMinutes.default;
}

function enabled(meeting: BackboneMeeting, instance: InstanceInput): boolean {
  if (!meeting.modes.includes(instance.mode)) return false;
  if (meeting.required) return true;
  return instance.parameters[`${meeting.key}.enabled`] === true;
}

/** The weekday, time and duration of an instance's weekly meeting (Q-T01). */
function weeklyOf(instance: InstanceInput, meeting: BackboneMeeting | undefined, shorten: boolean) {
  const weekday =
    typeof instance.parameters['weekly.weekday'] === 'string'
      ? (instance.parameters['weekly.weekday'] as string)
      : 'FR';
  const time = hhmm(instance.parameters['weekly.time'], '15:00');
  const asked = instance.parameters['weekly.duration'];
  const duration =
    meeting === undefined
      ? 60
      : shorten
        ? meeting.durationMinutes.min
        : typeof asked === 'number'
          ? asked
          : durationOf(meeting, instance.mode, false);
  return { weekday, time, duration };
}

interface Busy {
  readonly start: string;
  readonly end: string;
}

/**
 * The start of a long session (quarterly, yearly) on its first date: see the file comment.
 * `busy` holds the other CC meetings that day.
 */
function longSessionTime(
  workspace: WorkspaceAnswers,
  rrule: string,
  startsOn: string,
  preferred: string,
  duration: number,
  busy: (date: string) => readonly Busy[],
): string {
  const zone = workspace.timeZone;
  const first = firstOccurrenceOnOrAfter(
    canonicalRule(`${rrule};BYHOUR=12;BYMINUTE=0`),
    zone,
    startsOn,
  );
  if (first === undefined) return preferred;
  const date = first.slice(0, 10);
  const dayStart = wallClockInstantCompatible(`${date}T00:00`, zone);
  const dayEnd = wallClockInstantCompatible(`${addDays(date, 1)}T00:00`, zone);
  const blocks = blockIntervals(workspace.protectedBlocks, dayStart, dayEnd);
  const softStarts = blocks
    .filter((block) => block.policy === 'soft')
    .map((block) => block.start)
    .sort(compareInstants)
    .map((start) => timeOfDayIn(start, zone));
  const candidates = [
    preferred,
    ...softStarts,
    ...workspace.workingHours.map((range) => range.start),
  ];
  for (const time of candidates) {
    const start = wallClockInstantCompatible(`${date}T${time}`, zone);
    const end = addMinutes(start, duration);
    const inHours = workspace.workingHours.some(
      (range) =>
        minutesOfDay(range.start) <= minutesOfDay(time) &&
        minutesOfDay(time) + duration <= minutesOfDay(range.end),
    );
    if (!inHours) continue;
    const clash = (other: Busy) =>
      compareInstants(start, other.end) < 0 && compareInstants(other.start, end) < 0;
    if (blocks.some((block) => block.policy === 'hard' && clash(block))) continue;
    if (busy(date).some(clash)) continue;
    return time;
  }
  return preferred;
}

function timeOfDayIn(instant: string, zone: string): string {
  return localDateTime(instant, zone).slice(11, 16);
}

function nameOf(template: FrameworkTemplate, key: string, mode: 'solo' | 'team', merged: boolean) {
  if (template.id === 'eos-lite' && key === 'weekly' && mode === 'solo' && merged) {
    return 'Weekly CEO review';
  }
  return NAMES[template.id]?.[key] ?? `${template.name} ${key}`;
}

/** Composes every series of the workspace (01 §3 S6). */
export function composeRhythm(input: ComposeInput): ComposedSeries[] {
  const { workspace } = input;
  const shorten = input.shorten === true;
  const workweek = workspace.workweek.join(',');
  const out: ComposedSeries[] = [];

  if (input.dailyStart || input.dailyShutdown) {
    const [hours] = workspace.workingHours;
    const dayStart = hours?.start ?? '09:00';
    const dayEnd = timeOfDay(minutesOfDay(hours?.end ?? '17:30') - PORTFOLIO_MINUTES);
    const portfolio = (key: string, name: string, time: string): ComposedSeries => ({
      key,
      spec: {
        name,
        cadence: 'daily',
        rrule: `FREQ=WEEKLY;BYDAY=${workweek};${at(time)}`,
        timeZone: workspace.timeZone,
        durationMinutes: PORTFOLIO_MINUTES,
        workstreamIds: input.portfolio.map((w) => w.id) as MeetingSeries['workstreamIds'],
        frameworkInstanceIds: [],
        backboneMeetingKey: key,
        agendaTemplateId: `agenda.${key}@1`,
        agendaOverrides: [],
        attendeeIds: [input.selfPersonId] as MeetingSeries['attendeeIds'],
        chairId: input.selfPersonId as MeetingSeries['chairId'],
        mode: 'solo',
        absorbs: [],
        calendars: [],
      },
      workstreamKeys: input.portfolio.map((w) => w.key),
      instanceIds: [],
    });
    if (input.dailyStart) out.push(portfolio('portfolio.daily-start', 'Daily start', dayStart));
    if (input.dailyShutdown) {
      out.push(portfolio('portfolio.daily-shutdown', 'Daily shutdown', dayEnd));
    }
  }

  // Groups: merged instances share one series per meeting; every other instance is its own.
  const groups: InstanceInput[][] = [];
  for (const instance of input.instances) {
    const group =
      instance.mergeGroup === undefined
        ? undefined
        : groups.find(
            (candidate) =>
              candidate[0]?.mergeGroup === instance.mergeGroup &&
              candidate[0]?.template.id === instance.template.id &&
              candidate[0]?.mode === instance.mode,
          );
    if (group === undefined) groups.push([instance]);
    else group.push(instance);
  }

  // Long sessions are timed after every other series is known, so they can avoid them.
  const pendingLong: { group: InstanceInput[]; meeting: BackboneMeeting; rrule: string }[] = [];
  for (const group of groups) {
    const [lead] = group as [InstanceInput];
    const merged = group.length > 1;
    const meetings = lead.template.backbone.meetings.filter((m) => enabled(m, lead));
    const weeklyMeeting = meetings.find((m) => m.key === 'weekly');
    const weekly = weeklyOf(lead, weeklyMeeting, shorten);
    for (const meeting of meetings) {
      const base = {
        workstreamIds: [
          ...group.map((i) => i.workstreamId),
          ...(meeting.key === 'weekly' ? group.flatMap((i) => i.childWorkstreamIds) : []),
        ] as MeetingSeries['workstreamIds'],
        frameworkInstanceIds: group.map(
          (i) => i.instanceId,
        ) as MeetingSeries['frameworkInstanceIds'],
        workstreamKeys: group.map((i) => i.workstreamKey),
        instanceIds: group.map((i) => i.instanceId),
      };
      let rrule: string;
      let cadence: MeetingSeries['cadence'] = meeting.cadence;
      let duration = durationOf(meeting, lead.mode, shorten);
      switch (meeting.key) {
        case 'weekly': {
          const biweekly = input.biweekly === true && lead.template.id === 'personal-os';
          cadence = biweekly ? 'biweekly' : 'weekly';
          rrule = `FREQ=WEEKLY;${biweekly ? 'INTERVAL=2;' : ''}BYDAY=${weekly.weekday};${at(weekly.time)}`;
          duration = weekly.duration;
          break;
        }
        case 'daily':
          rrule = `FREQ=WEEKLY;BYDAY=${workweek};${at(hhmm(lead.parameters['daily.time'], '09:00'))}`;
          break;
        case 'monthly': {
          const week = lead.parameters['monthly.week'] === 'first' ? '1' : '-1';
          rrule = `FREQ=MONTHLY;BYDAY=${week}${weekly.weekday};${at(weekly.time)}`;
          break;
        }
        case 'quarterly': {
          const offset = lead.parameters['quarterly.weekOfQuarter'];
          const week = typeof offset === 'number' ? String(offset) : '-1';
          pendingLong.push({
            group,
            meeting,
            rrule: `FREQ=YEARLY;BYMONTH=3,6,9,12;BYDAY=${week}${weekly.weekday}`,
          });
          continue;
        }
        case 'yearly':
          pendingLong.push({
            group,
            meeting,
            rrule: `FREQ=YEARLY;BYMONTH=12;BYDAY=2${weekly.weekday}`,
          });
          continue;
        default:
          continue;
      }
      out.push({
        key: `${lead.workstreamKey}.${meeting.key}`,
        spec: {
          name: nameOf(lead.template, meeting.key, lead.mode, merged),
          cadence,
          rrule,
          timeZone: workspace.timeZone,
          durationMinutes: duration,
          workstreamIds: base.workstreamIds,
          frameworkInstanceIds: base.frameworkInstanceIds,
          backboneMeetingKey: meeting.key,
          agendaTemplateId: meeting.agendaTemplateId,
          agendaOverrides: [],
          attendeeIds: [input.selfPersonId] as MeetingSeries['attendeeIds'],
          chairId: input.selfPersonId as MeetingSeries['chairId'],
          mode: lead.mode,
          absorbs: ABSORBS[meeting.agendaTemplateId] ?? [],
          calendars: [],
        },
        backbone: meeting,
        workstreamKeys: base.workstreamKeys,
        instanceIds: base.instanceIds,
      });
    }
  }

  const known = [...out];
  for (const { group, meeting, rrule } of pendingLong) {
    const [lead] = group as [InstanceInput];
    const merged = group.length > 1;
    const weeklyMeeting = lead.template.backbone.meetings.find((m) => m.key === 'weekly');
    const weekly = weeklyOf(lead, weeklyMeeting, shorten);
    const duration = durationOf(meeting, lead.mode, shorten);
    const busy = (date: string): Busy[] =>
      known.flatMap((series) => {
        const occurrence = firstOccurrenceOnOrAfter(
          canonicalRule(series.spec.rrule),
          series.spec.timeZone,
          date,
        );
        if (occurrence === undefined || occurrence.slice(0, 10) !== date) return [];
        const start = wallClockInstantCompatible(occurrence, series.spec.timeZone);
        return [{ start, end: addMinutes(start, series.spec.durationMinutes) }];
      });
    const time = longSessionTime(workspace, rrule, input.startsOn, weekly.time, duration, busy);
    const composed: ComposedSeries = {
      key: `${lead.workstreamKey}.${meeting.key}`,
      spec: {
        name: nameOf(lead.template, meeting.key, lead.mode, merged),
        cadence: meeting.cadence,
        rrule: `${rrule};${at(time)}`,
        timeZone: workspace.timeZone,
        durationMinutes: duration,
        workstreamIds: group.map((i) => i.workstreamId) as MeetingSeries['workstreamIds'],
        frameworkInstanceIds: group.map(
          (i) => i.instanceId,
        ) as MeetingSeries['frameworkInstanceIds'],
        backboneMeetingKey: meeting.key,
        agendaTemplateId: meeting.agendaTemplateId,
        agendaOverrides: [],
        attendeeIds: [input.selfPersonId] as MeetingSeries['attendeeIds'],
        chairId: input.selfPersonId as MeetingSeries['chairId'],
        mode: lead.mode,
        absorbs: ABSORBS[meeting.agendaTemplateId] ?? [],
        calendars: [],
      },
      backbone: meeting,
      workstreamKeys: group.map((i) => i.workstreamKey),
      instanceIds: group.map((i) => i.instanceId),
    };
    out.push(composed);
    known.push(composed);
  }

  // Two series with one name (two unmerged instances) are told apart by workstream key.
  const counts = new Map<string, number>();
  for (const series of out) counts.set(series.spec.name, (counts.get(series.spec.name) ?? 0) + 1);
  return out.map((series) =>
    (counts.get(series.spec.name) ?? 0) > 1
      ? {
          ...series,
          spec: {
            ...series.spec,
            name: `${series.spec.name} (${series.workstreamKeys.join(', ')})`,
          },
        }
      : series,
  );
}
