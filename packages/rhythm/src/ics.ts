/**
 * The `.ics` export (02 §9.1, provider "none"; ADR 0001 decision 3): the zero-connector path for
 * a series with no calendar binding. One VEVENT per instance in the window, with
 * `UID:<instanceId>@command-center`, a `SEQUENCE` that rises only when the instance's time
 * changes, `DTSTAMP` from the injected clock, UTC `DTSTART`/`DTEND` (so no VTIMEZONE), CRLF line
 * ends and lines folded at 75 octets. The user imports the file by hand: there is no
 * reconciliation, so calendar-side moves are not seen, and the export says so.
 *
 * The writer is pure and has no runtime dependency. Exporting moves `planned` instances to
 * `scheduled` (02 §4.2 "calendar event written / .ics exported"); the caller writes the file.
 *
 * Event text follows 02 §9.2 rules 2 and 3 and C-02-08: the summary is "[CC] <series name>", or
 * a neutral "[CC] <Cadence> meeting" when a workstream of the series is sensitive (INV-03-10);
 * the description is the agenda outline (section titles and timeboxes, never workstream names,
 * measures or items) and the deep link `commandcenter://meeting/<instanceId>` (02 §9.2 rule 2,
 * the desktop's route).
 */
import { invariantError, type Caller, type Change, type DomainContext } from '@cc/domain';
import type { DomainEvent, MeetingInstance, MeetingSeries } from '@cc/schemas';

import { composeAgenda } from './agenda.js';
import { markScheduled } from './state.js';
import { agendaTemplate } from './templates.js';
import { addDays, compareInstants, instant, localDate, startOfDay } from './time.js';

/** One VEVENT as the writer takes it. Times are UTC instants ("2026-11-13T09:30:00Z"). */
export interface IcsEvent {
  readonly uid: string;
  readonly sequence: number;
  readonly dtstamp: string;
  readonly start: string;
  readonly end: string;
  readonly summary: string;
  readonly description: string;
  readonly reminderMinutes: readonly number[];
}

const CRLF = '\r\n';
const encoder = new TextEncoder();

/** An instant in the UTC basic form of RFC 5545 §3.3.5: "20261113T093000Z". */
export function icsUtc(text: string): string {
  return instant(text)
    .toString({ smallestUnit: 'second' })
    .replace(/[-:]/g, '')
    .replace(/\.\d+/, '');
}

/** TEXT escaping (RFC 5545 §3.3.11). */
export function icsText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Folds a content line at 75 octets (RFC 5545 §3.1): continuation lines start with one space,
 * and a UTF-8 character is never split.
 */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    const limit = parts.length === 0 ? 75 : 74;
    if (octets + size > limit) {
      parts.push(current);
      current = '';
      octets = 0;
    }
    current += char;
    octets += size;
  }
  parts.push(current);
  return parts.join(`${CRLF} `);
}

/** A whole VCALENDAR of the events, in the order given. */
export function writeIcs(events: readonly IcsEvent[]): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Command Center//cc-foundation//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Command Center',
  ];
  for (const event of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${event.uid}`,
      `SEQUENCE:${String(event.sequence)}`,
      `DTSTAMP:${icsUtc(event.dtstamp)}`,
      `DTSTART:${icsUtc(event.start)}`,
      `DTEND:${icsUtc(event.end)}`,
      `SUMMARY:${icsText(event.summary)}`,
      `DESCRIPTION:${icsText(event.description)}`,
      'TRANSP:OPAQUE',
      'STATUS:CONFIRMED',
    );
    for (const minutes of event.reminderMinutes) {
      lines.push(
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `DESCRIPTION:${icsText(event.summary)}`,
        `TRIGGER:-PT${String(minutes)}M`,
        'END:VALARM',
      );
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join(CRLF) + CRLF;
}

/**
 * An instance's `SEQUENCE`: how many times its time changed after it was materialised, read from
 * its events oldest first (02 §9.1 "SEQUENCE incremented on change"). A state change, a pre-read
 * or a carry-in leaves it as it is, so a re-export raises it for the moved instances only.
 */
export function icsSequence(events: readonly DomainEvent[]): number {
  return events.slice(1).filter((event) => {
    const after = (event.after ?? {}) as Record<string, unknown>;
    return 'scheduledStart' in after || 'scheduledEnd' in after;
  }).length;
}

const CADENCE_TITLE: Record<MeetingSeries['cadence'], string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  biweekly: 'Biweekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
};

/** The event summary (02 §9.2 rule 2): neutral for a series with a sensitive workstream. */
export function icsSummary(series: MeetingSeries, sensitive: boolean): string {
  return sensitive ? `[CC] ${CADENCE_TITLE[series.cadence]} meeting` : `[CC] ${series.name}`;
}

/** The agenda outline and deep link (02 §9.2 rules 2 and 3). */
export function icsDescription(
  series: MeetingSeries,
  instance: MeetingInstance,
  absorbed: readonly { readonly instance: MeetingInstance; readonly series: MeetingSeries }[],
): string {
  const template = agendaTemplate(series.agendaTemplateId);
  const absorbedTemplates = absorbed.map((meeting) => ({
    instanceId: meeting.instance.id,
    template: agendaTemplate(meeting.series.agendaTemplateId),
    series: meeting.series,
    absorbedMinutes:
      series.absorbs.find((a) => a.cadence === meeting.series.cadence)?.absorbedMinutes ?? 0,
  }));
  const rows = composeAgenda({ template, series, absorbed: absorbedTemplates });
  const titleOf = (sectionId: string, from: string | undefined) => {
    const owner =
      absorbedTemplates.find((meeting) => meeting.instanceId === from)?.template ?? template;
    return owner.sections.find((section) => section.id === sectionId)?.title ?? sectionId;
  };
  return [
    'Agenda:',
    ...rows.map(
      (row) => `- ${titleOf(row.sectionId, row.absorbedFrom)}, ${String(row.timeboxMinutes)} min`,
    ),
    '',
    `Open in Command Center: commandcenter://meeting/${instance.id}`,
  ].join('\n');
}

/** The states whose instances are still to be held, so they are exported (02 §9.4 "expected"). */
const EXPORTED: readonly MeetingInstance['state'][] = ['planned', 'scheduled', 'prepared'];

export const ICS_WARNING =
  'Command Center does not see changes made in the calendar to imported events: move, skip or change a meeting in Command Center, then export again.';

export interface IcsExport {
  readonly ics: string;
  /** The exported instances, by ref, in event order. */
  readonly instances: readonly string[];
  /** `planned → scheduled` for the exported instances not yet scheduled. */
  readonly changes: readonly Change[];
  readonly window: { readonly from: string; readonly to: string };
  readonly warning: string;
}

/**
 * Exports `weeks` weeks from the start of today (workspace zone) of every series with no
 * calendar binding (`cc-axi meetings export-ics --weeks 13`, 02 §9.1). `sequenceOf` gives each
 * instance's `SEQUENCE` (`icsSequence` over its events; 0 when unknown). The caller is the
 * rhythm engine (`system:rhythm`), which marks the exported instances `scheduled`.
 */
export function exportIcs(
  ctx: DomainContext,
  caller: Caller,
  input: {
    readonly series: readonly MeetingSeries[];
    readonly instances: readonly MeetingInstance[];
    readonly weeks: number;
    readonly workspaceTimeZone: string;
    readonly sequenceOf?: (instance: MeetingInstance) => number;
  },
): IcsExport {
  if (!Number.isInteger(input.weeks) || input.weeks < 1) {
    throw invariantError({
      rule: '02 §9.1',
      message: 'weeks must be a whole number of at least 1',
    });
  }
  const now = ctx.clock.now();
  const today = localDate(now, input.workspaceTimeZone);
  const window = {
    from: startOfDay(today, input.workspaceTimeZone),
    to: startOfDay(addDays(today, input.weeks * 7), input.workspaceTimeZone),
  };
  const seriesById = new Map(input.series.map((s) => [s.id as string, s]));
  const instanceById = new Map(input.instances.map((i) => [i.id as string, i]));
  const chosen = input.instances
    .filter((instance) => {
      const series = seriesById.get(instance.seriesId);
      return (
        series !== undefined &&
        series.calendars.length === 0 &&
        EXPORTED.includes(instance.state) &&
        compareInstants(instance.scheduledStart, window.from) >= 0 &&
        compareInstants(instance.scheduledStart, window.to) < 0
      );
    })
    .sort(
      (a, b) => compareInstants(a.scheduledStart, b.scheduledStart) || a.ref.localeCompare(b.ref),
    );
  const changes: Change[] = [];
  const events = chosen.map((instance): IcsEvent => {
    const series = seriesById.get(instance.seriesId) as MeetingSeries;
    const sensitive = series.workstreamIds.some(
      (id) => ctx.registry.workstream(id)?.privacy === 'sensitive',
    );
    const absorbed = instance.absorbedInstanceIds.flatMap((id) => {
      const other = instanceById.get(id);
      const owner = other === undefined ? undefined : seriesById.get(other.seriesId);
      return other === undefined || owner === undefined ? [] : [{ instance: other, series: owner }];
    });
    if (instance.state === 'planned') changes.push(...markScheduled(ctx, caller, instance).changes);
    return {
      uid: `${instance.id}@command-center`,
      sequence: input.sequenceOf?.(instance) ?? 0,
      dtstamp: now,
      start: instance.scheduledStart,
      end: instance.scheduledEnd,
      summary: icsSummary(series, sensitive),
      description: icsDescription(series, instance, absorbed),
      reminderMinutes: series.reminderMinutes,
    };
  });
  return {
    ics: writeIcs(events),
    instances: chosen.map((instance) => instance.ref),
    changes,
    window,
    warning: ICS_WARNING,
  };
}
