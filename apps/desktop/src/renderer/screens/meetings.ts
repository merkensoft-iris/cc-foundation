/**
 * Meetings (09 P1-11; 02 §4.7, §5.7, §6): the week view, and the runner for one meeting.
 *
 * The runner shows the agenda with each section's timebox and the rows its inputs found in the
 * pre-read, and keeps time on the current section. Sections that allow it capture draft action
 * items and notes; the daily start and shutdown do too (owner decision Q7). The daily start's
 * attention list is shown in its fixed order, which the user cannot change; dismissing an entry
 * snoozes it to tomorrow's daily start, it does not resolve it (owner decision Q6). The meeting
 * ends with the read-back, which only the user confirms (04 §4.3), then the close.
 */
import type {
  MeetingRow,
  MeetingSectionView,
  MeetingsListResult,
  MeetingView,
} from '../app/api.js';
import type { AppRoute } from '../app/routes.js';
import { act, type Screen, type Ui } from '../app/screen.js';
import {
  addDays,
  button,
  chip,
  field,
  link,
  localDate,
  localTime,
  page,
  section,
  select,
  stateChip,
} from '../ui/parts.js';
import { h, type VNode } from '../ui/vnode.js';

/** Where the user is in a running meeting; kept across reloads. */
export interface RunnerClock {
  current: number;
  /** When the current section started (ms). */
  startedAt: number;
}

export interface CaptureForm {
  note: string;
  title: string;
  due: string;
  doneMeans: string;
  /** The workstream slug of an item captured in a section shared by several workstreams. */
  workstream: string;
}

export interface MeetingsState {
  week?: MeetingsListResult;
  run?: {
    readonly view: MeetingView;
    readonly clock: RunnerClock;
    readonly forms: Record<string, CaptureForm>;
    readonly onBehalf: Record<string, string>;
  };
}

const STARTABLE: ReadonlySet<string> = new Set(['planned', 'scheduled', 'prepared']);

export function sectionKey(
  section: Pick<MeetingSectionView, 'sectionId' | 'workstreamId' | 'absorbedFrom'>,
): string {
  return [section.sectionId, section.workstreamId ?? '', section.absorbedFrom ?? ''].join('|');
}

function keyParams(section: MeetingSectionView) {
  return {
    sectionId: section.sectionId,
    ...(section.workstreamId === undefined ? {} : { workstreamId: section.workstreamId }),
    ...(section.absorbedFrom === undefined ? {} : { absorbedFrom: section.absorbedFrom }),
  };
}

function weekView(week: MeetingsListResult, ui: Ui): VNode {
  const days: { date: string; meetings: MeetingRow[] }[] = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addDays(week.from, offset);
    if (date > week.to) break;
    days.push({
      date,
      meetings: week.meetings.filter((m) => localDate(m.start, week.timeZone) === date),
    });
  }
  return page(
    'Meetings',
    h(
      'div',
      { class: 'actions' },
      button('Previous week', () => ui.go({ screen: 'meetings', from: addDays(week.from, -7) }), {
        test: 'previous-week',
      }),
      h('strong', { test: 'week-range' }, `${week.from} to ${week.to}`),
      button('Next week', () => ui.go({ screen: 'meetings', from: addDays(week.from, 7) }), {
        test: 'next-week',
      }),
    ),
    h(
      'div',
      { class: 'week', test: 'week' },
      days.map((day) =>
        h(
          'div',
          { class: 'day', test: `day-${day.date}` },
          h('h3', null, day.date),
          day.meetings.length === 0
            ? h('p', { class: 'empty' }, 'No meetings.')
            : h(
                'ul',
                { class: 'list' },
                day.meetings.map((meeting) =>
                  h(
                    'li',
                    { test: `meeting-${meeting.ref}` },
                    h('span', { class: 'time' }, localTime(meeting.start, week.timeZone).slice(-5)),
                    ' ',
                    link(meeting.title, () => ui.go({ screen: 'meetings', ref: meeting.ref })),
                    ' ',
                    stateChip(meeting.state),
                  ),
                ),
              ),
        ),
      ),
    ),
  );
}

/** Minutes left in the current section's timebox; negative when over. */
export function minutesLeft(clock: RunnerClock, timeboxMinutes: number, now: number): number {
  return timeboxMinutes - Math.floor((now - clock.startedAt) / 60_000);
}

function captureForms(
  run: NonNullable<MeetingsState['run']>,
  section: MeetingSectionView,
  ui: Ui,
): VNode | null {
  const allowsItem = section.allowedOutputs.includes('action_item');
  const allowsNote = section.allowedOutputs.includes('note');
  if (!allowsItem && !allowsNote) return null;
  const key = sectionKey(section);
  const shared = section.workstreamId === undefined && run.view.workstreams.length > 1;
  const form = (run.forms[key] ??= {
    note: '',
    title: '',
    due: '',
    doneMeans: '',
    workstream: run.view.workstreams[0]?.slug ?? '',
  });
  const ref = run.view.meeting.ref;
  return h(
    'div',
    { class: 'capture', test: `capture-${section.sectionId}` },
    allowsNote
      ? h(
          'div',
          { class: 'actions' },
          field('Note', form.note, (value) => (form.note = value), { test: 'capture-note' }),
          button(
            'Add note',
            () => {
              const text = form.note.trim();
              if (text === '') return;
              void act(
                ui,
                () =>
                  ui.call('meetings.capture', {
                    ref,
                    section: keyParams(section),
                    output: { kind: 'note', text },
                  }),
                'Note captured.',
              ).then((ok) => {
                if (!ok) return;
                form.note = '';
                ui.render();
              });
            },
            { test: 'add-note' },
          ),
        )
      : null,
    allowsItem
      ? h(
          'div',
          { class: 'actions' },
          field('Action item', form.title, (value) => (form.title = value), {
            test: 'capture-title',
            placeholder: 'Verb and deliverable',
          }),
          field('Due', form.due, (value) => (form.due = value), {
            test: 'capture-due',
            type: 'date',
          }),
          field('Done means', form.doneMeans, (value) => (form.doneMeans = value), {
            test: 'capture-done-means',
          }),
          shared
            ? select(
                'Workstream',
                form.workstream,
                run.view.workstreams.map((w) => ({ value: w.slug, label: w.name })),
                (value) => (form.workstream = value),
                'capture-workstream',
              )
            : null,
          button(
            'Capture item',
            () => {
              if (form.title.trim() === '' || form.due === '' || form.doneMeans.trim() === '') {
                ui.flash('An action item needs a title, a due date and what done means.', 'error');
                return;
              }
              const output = {
                kind: 'action_item',
                title: form.title.trim(),
                due: form.due,
                doneMeans: form.doneMeans.trim(),
                ...(shared && form.workstream !== '' ? { workstream: form.workstream } : {}),
              };
              void act(
                ui,
                () => ui.call('meetings.capture', { ref, section: keyParams(section), output }),
                'Item captured as a draft; the read-back accepts it.',
              ).then((ok) => {
                if (!ok) return;
                form.title = '';
                form.due = '';
                form.doneMeans = '';
                ui.render();
              });
            },
            { test: 'capture-item' },
          ),
        )
      : null,
  );
}

function sectionRows(run: NonNullable<MeetingsState['run']>, section: MeetingSectionView, ui: Ui) {
  if (section.rows.length === 0) return h('p', { class: 'empty' }, 'Nothing for this section.');
  const attention = section.type === 'attention';
  const ref = run.view.meeting.ref;
  return h(
    'ol',
    { class: attention ? 'attention-list' : 'rows', test: `rows-${section.sectionId}` },
    section.rows.map((row) =>
      h(
        'li',
        { test: `row-${row.ref}` },
        /^[ADIRGK]-\d+$/.test(row.ref) && row.ref.startsWith('A-')
          ? link(row.ref, () => ui.go({ screen: 'items', ref: row.ref }))
          : h('span', { class: 'ref' }, row.ref.startsWith('dst:') ? 'DST' : row.ref),
        ' ',
        row.title,
        row.flags.map((flag) => [' ', chip(flag.replace(/_/g, ' '), 'warn')]),
        attention
          ? [
              ' ',
              button(
                'Dismiss',
                () =>
                  void act(
                    ui,
                    () => ui.call('meetings.dismiss', { ref, entry: row.ref }),
                    'Dismissed until tomorrow’s daily start.',
                  ),
                {
                  test: `dismiss-${row.ref}`,
                  title: 'Snoozes it to tomorrow; it returns while its cause remains',
                },
              ),
            ]
          : null,
      ),
    ),
  );
}

function readBack(run: NonNullable<MeetingsState['run']>, ui: Ui): VNode {
  const { view } = run;
  const meeting = view.meeting;
  const confirmed = meeting.readBackConfirmedAt !== undefined;
  return section(
    'Read-back',
    view.readBack.length === 0
      ? h('p', { class: 'empty' }, 'Nothing was captured to read back.')
      : h(
          'ul',
          { class: 'list', test: 'read-back' },
          view.readBack.map((line) =>
            h(
              'li',
              { test: `read-back-${line.ref}` },
              `${line.ref} ${line.deliverable} · ${line.owner}${line.due === undefined ? '' : ` · due ${line.due}`}`,
              line.doneMeans === undefined
                ? null
                : h('span', { class: 'muted' }, ` · done means: ${line.doneMeans}`),
              ' ',
              stateChip(line.state),
              !line.ownerPresent && line.state === 'draft' && !confirmed
                ? field(
                    `Accept for the absent owner (note)`,
                    run.onBehalf[line.ref] ?? '',
                    (value) => (run.onBehalf[line.ref] = value),
                    { test: `on-behalf-${line.ref}` },
                  )
                : null,
            ),
          ),
        ),
    meeting.state === 'in_progress' && !confirmed
      ? button(
          'Read back done',
          () => {
            const acceptances = Object.entries(run.onBehalf)
              .filter(([, note]) => note.trim() !== '')
              .map(([itemRef, note]) => ({ ref: itemRef, note: note.trim() }));
            void act(
              ui,
              () =>
                ui.call('meetings.confirm', {
                  ref: meeting.ref,
                  ...(acceptances.length === 0 ? {} : { acceptances }),
                }),
              'Read-back confirmed: the drafts read back are accepted.',
            );
          },
          { test: 'read-back-done', primary: true },
        )
      : null,
    meeting.state === 'in_progress' && confirmed
      ? button(
          'Close meeting',
          () =>
            void act(ui, () => ui.call('meetings.close', { ref: meeting.ref }), 'Meeting closed.'),
          { test: 'close-meeting', primary: true },
        )
      : null,
  );
}

function runnerView(run: NonNullable<MeetingsState['run']>, ui: Ui): VNode {
  const { view, clock } = run;
  const meeting = view.meeting;
  const running = meeting.state === 'in_progress';
  const label = (s: MeetingSectionView) =>
    s.workstreamId === undefined
      ? s.title
      : `${s.title}: ${view.workstreams.find((w) => w.id === s.workstreamId)?.name ?? s.workstreamId}`;
  const total = view.sections.reduce((sum, s) => sum + s.timeboxMinutes, 0);
  return page(
    `${view.title} ${meeting.ref}`,
    h(
      'p',
      null,
      link('This week', () => ui.go({ screen: 'meetings' })),
    ),
    h(
      'p',
      { test: 'meeting-header' },
      localTime(meeting.scheduledStart, view.timeZone),
      ' · ',
      `${String(total)} min`,
      ' ',
      stateChip(meeting.state),
    ),
    STARTABLE.has(meeting.state)
      ? button(
          'Start meeting',
          () => {
            clock.current = 0;
            clock.startedAt = ui.now();
            void act(ui, () => ui.call('meetings.start', { ref: meeting.ref }), 'Meeting started.');
          },
          { test: 'start-meeting', primary: true },
        )
      : null,
    h(
      'ol',
      { class: 'agenda', test: 'agenda' },
      view.sections.map((s, index) => {
        const current = running && index === clock.current;
        const left = minutesLeft(clock, s.timeboxMinutes, ui.now());
        return h(
          'li',
          {
            class: current ? 'agenda-section current' : 'agenda-section',
            test: `section-${s.sectionId}${s.workstreamId === undefined ? '' : `-${s.workstreamId}`}`,
            ...(current ? { 'aria-current': 'step' } : {}),
          },
          h(
            'h3',
            null,
            label(s),
            ' ',
            h('span', { class: 'timebox', test: 'timebox' }, `${String(s.timeboxMinutes)} min`),
            current
              ? h(
                  'span',
                  { class: left < 0 ? 'timer over' : 'timer', test: 'timer' },
                  left < 0 ? ` ${String(-left)} min over` : ` ${String(left)} min left`,
                )
              : null,
          ),
          current || !running ? sectionRows(run, s, ui) : null,
          current ? captureForms(run, s, ui) : null,
          current && index < view.sections.length - 1
            ? button(
                'Next section',
                () => {
                  clock.current = index + 1;
                  clock.startedAt = ui.now();
                  ui.render();
                },
                { test: 'next-section' },
              )
            : null,
        );
      }),
    ),
    running || meeting.state === 'completed' ? readBack(run, ui) : null,
  );
}

export const meetingsScreen: Screen<MeetingsState> & { readonly ticks: true } = {
  ticks: true,
  async load(ui, route: AppRoute) {
    if (route.screen !== 'meetings') throw new Error('not the meetings screen');
    if (route.ref === undefined) {
      const week = await ui.call<MeetingsListResult>('meetings.list', {
        ...(route.from === undefined ? {} : { from: route.from, to: addDays(route.from, 6) }),
        limit: 200,
      });
      return { week };
    }
    const view = await ui.call<MeetingView>('meetings.get', { ref: route.ref });
    const kept = ui.keep(`meeting:${view.meeting.ref}`, () => ({
      clock: { current: 0, startedAt: ui.now() } as RunnerClock,
      forms: {} as Record<string, CaptureForm>,
      onBehalf: {} as Record<string, string>,
    }));
    return { run: { view, ...kept } };
  },
  view(state, ui) {
    if (state.run !== undefined) return runnerView(state.run, ui);
    if (state.week !== undefined) return weekView(state.week, ui);
    return page('Meetings', h('p', null, 'No meetings.'));
  },
};
