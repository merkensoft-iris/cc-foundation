/**
 * Meetings for the MCP relay (07 §7): `cc_list` with type meetings, `cc_get` on an M- ref and
 * `cc_meeting_capture`. They follow the `cc-axi meetings list | view | capture` lines of 07 §4.2
 * and the AXI rules of 07 §4.1, but the CLI commands themselves are not built yet, so only the
 * relay runs these handlers (apps/cli/src/mcp/routes.ts); their help lines name MCP tools.
 *
 * Times are shown in the workspace time zone the API returns, as "2026-11-13 15:00".
 */
import { flag, single } from '../args.js';
import { usageError } from '../errors.js';
import { countLine, table, truncate, type Output } from '../render.js';
import { DEFAULT_LIMIT } from '../spec.js';
import {
  defined,
  refValue,
  type Handler,
  type MeetingCaptureResult,
  type MeetingResult,
  type MeetingsListResult,
} from './common.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-11-13 15:00" in `timeZone`. */
export function localTime(utc: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(utc));
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}

/** `--range today|week|<from>..<to>` as the from and to dates `meetings.list` takes. */
function rangeOf(
  range: string | undefined,
  today: string | undefined,
): { from?: string; to?: string; label: string } {
  if (range === undefined || range === 'week') return { label: 'this week' };
  if (range === 'today') {
    if (today === undefined) return { label: 'today' };
    return { from: today, to: today, label: 'today' };
  }
  const match = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(range);
  if (match === null || !DATE.test(match[1] ?? '') || !DATE.test(match[2] ?? '')) {
    throw usageError(`invalid range "${range}"`, [
      'range takes today, week, or YYYY-MM-DD..YYYY-MM-DD',
    ]);
  }
  const [, from = '', to = ''] = match;
  return { from, to, label: `from ${from} to ${to}` };
}

export const meetingsList: Handler = async (parsed, session) => {
  const range = single(parsed, '--range');
  const limit = Number(single(parsed, '--limit') ?? DEFAULT_LIMIT);
  const api = await session.api();
  // "today" is the workspace's date: read it from the home view's clock, not this machine's.
  let today: string | undefined;
  if (range === 'today') {
    const home = await api.call<{ now: string }>('home.get', {});
    today = home.now.slice(0, 10);
  }
  const window = rangeOf(range, today);
  const result = await api.call<MeetingsListResult>(
    'meetings.list',
    defined({ from: window.from, to: window.to, limit }),
  );
  const label =
    range === undefined || range === 'week'
      ? `this week (${result.from} to ${result.to})`
      : window.label;
  const noun = `meetings ${label}`;
  if (result.meetings.length === 0) return { meetings: `0 ${noun}` };
  const rows = result.meetings.map((meeting) => ({
    ref: meeting.ref,
    start: localTime(meeting.start, result.timeZone),
    meeting: meeting.title,
    state: meeting.state,
  }));
  const help = ['Call cc_get with a meeting ref for its agenda'];
  if (result.total > rows.length) {
    help.push(`Call cc_list with type meetings and limit ${result.total} for all ${result.total}`);
  }
  return {
    meetings: table(rows, ['ref', 'start', 'meeting', 'state']),
    count: countLine(rows.length, result.total, noun),
    help,
  };
};

export const meetingsView: Handler = async (parsed, session) => {
  const ref = refValue(parsed.positionals[0] ?? '', 'M');
  const full = flag(parsed, '--full');
  const api = await session.api();
  const result = await api.call<MeetingResult>('meetings.get', { ref });
  const { meeting, timeZone } = result;
  const slugs = new Map(result.workstreams.map((workstream) => [workstream.id, workstream.slug]));
  const view: Output = {
    ref: meeting.ref,
    title: result.title,
    start: localTime(meeting.scheduledStart, timeZone),
    end: localTime(meeting.scheduledEnd, timeZone),
    time_zone: timeZone,
    state: meeting.state,
    agenda: result.agendaTemplateId,
    workstreams: result.workstreams.map((workstream) => workstream.slug).join(','),
  };
  let truncated = false;
  const sections = result.sections.map((section) => {
    const rows = section.rows.map((row) => row.ref).join(',');
    const cut = truncate(rows, full);
    truncated ||= cut.truncated;
    return {
      section: section.sectionId,
      workstream:
        section.workstreamId === undefined ? null : (slugs.get(section.workstreamId) ?? null),
      title: section.title,
      minutes: section.timeboxMinutes,
      status: section.status,
      outputs: section.allowedOutputs.join(','),
      rows: section.rows.length === 0 ? '' : cut.text,
    };
  });
  const output: Output = {
    meeting: view,
    sections:
      sections.length === 0
        ? '0 agenda sections'
        : table(sections, [
            'section',
            'workstream',
            'title',
            'minutes',
            'status',
            'outputs',
            'rows',
          ]),
  };
  if (result.readBack.length > 0) {
    output['read_back'] = table(
      result.readBack.map((line) => ({
        ref: line.ref,
        owner: line.owner,
        deliverable: line.deliverable,
        due: line.due ?? null,
        state: line.state,
      })),
      ['ref', 'owner', 'deliverable', 'due', 'state'],
    );
  }
  if (truncated)
    output['help'] = [`Call cc_get with ref ${meeting.ref} and full: true for every row`];
  return output;
};

export const meetingsCapture: Handler = async (parsed, session) => {
  const ref = refValue(parsed.positionals[0] ?? '', 'M');
  const sectionId = single(parsed, '--section') ?? '';
  const workstream = single(parsed, '--workstream');
  const note = single(parsed, '--note');
  const title = single(parsed, '--action');
  const owner = single(parsed, '--owner');
  const due = single(parsed, '--due');
  const doneMeans = single(parsed, '--done-means');
  if ((note === undefined) === (title === undefined)) {
    throw usageError('give either a note, or an action with its due and done_means', [
      'A note: note "<text>"; a draft item: action "<title>", due YYYY-MM-DD, done_means "<text>", owner optional',
    ]);
  }
  if (title !== undefined && (due === undefined || doneMeans === undefined)) {
    throw usageError('a captured action needs due and done_means', [
      'Every item has one owner, a due date and done-means (03 §5.7); owner defaults to the meeting owner',
    ]);
  }
  if (due !== undefined && !DATE.test(due)) {
    throw usageError(`invalid date "${due}" for due`, ['due takes a date as YYYY-MM-DD']);
  }

  const api = await session.api();
  // The section key: the ID, plus the workstream when a per-workstream section repeats.
  const view = await api.call<MeetingResult>('meetings.get', { ref });
  const slugs = new Map(view.workstreams.map((entry) => [entry.id, entry.slug]));
  const matches = view.sections.filter(
    (section) =>
      section.sectionId === sectionId &&
      (workstream === undefined ||
        section.workstreamId === workstream ||
        (section.workstreamId !== undefined && slugs.get(section.workstreamId) === workstream)),
  );
  if (matches.length === 0) {
    const ids = [...new Set(view.sections.map((section) => section.sectionId))];
    throw usageError(
      `no section ${sectionId}${workstream === undefined ? '' : ` for ${workstream}`} in ${ref}`,
      [`Sections of ${ref}: ${ids.length === 0 ? 'none' : ids.join(', ')}`],
    );
  }
  if (matches.length > 1) {
    const choices = matches
      .map((section) =>
        section.workstreamId === undefined ? undefined : slugs.get(section.workstreamId),
      )
      .filter((slug): slug is string => slug !== undefined);
    throw usageError(`section ${sectionId} of ${ref} repeats per workstream`, [
      `Give workstream as one of: ${choices.join(', ')}`,
    ]);
  }
  const section = matches[0]!;
  const result = await api.call<MeetingCaptureResult>('meetings.capture', {
    ref,
    section: defined({
      sectionId: section.sectionId,
      workstreamId: section.workstreamId,
      absorbedFrom: section.absorbedFrom,
    }),
    output:
      note !== undefined
        ? { kind: 'note', text: note }
        : defined({
            kind: 'action_item' as const,
            title: title!,
            due: due!,
            doneMeans: doneMeans!,
            owner,
            workstream:
              section.workstreamId === undefined ? undefined : slugs.get(section.workstreamId),
          }),
  });
  return {
    status: result.status,
    captured: {
      meeting: result.meeting.ref,
      section: section.sectionId,
      output: note !== undefined ? 'note' : 'draft action item',
      meeting_state: result.meeting.state,
    },
    help: [
      `Call cc_get with ref ${result.meeting.ref} for the read-back; the user confirms it in the app`,
    ],
  };
};
