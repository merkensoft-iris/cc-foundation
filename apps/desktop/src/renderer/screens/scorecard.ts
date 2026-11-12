/**
 * Scorecard (09 P1-11; 03 §5.3, §5.4): the measures with their latest values, recorded by hand
 * here, and the Goals tab.
 *
 * Goals are editable any time on the Goals tab, not only in a meeting (owner decision Q2): each
 * save is one `goal.update` call, which logs one `goal.updated` event with the changed fields
 * before and after, and the tab shows every goal's history (AC-03-10).
 */
import type { DomainEvent, Goal, GoalRow, HistoryResult, MeasureRow } from '../app/api.js';
import type { AppRoute } from '../app/routes.js';
import { act, type Screen, type Ui } from '../app/screen.js';
import {
  button,
  field,
  healthChip,
  link,
  page,
  section,
  select,
  table,
  tabs,
} from '../ui/parts.js';
import { h, type VNode } from '../ui/vnode.js';

export interface GoalForm {
  title: string;
  doneMeans: string;
  targetFrom: string;
  targetTo: string;
  targetUnit: string;
  targetBy: string;
  health: string;
  healthNote: string;
}

export interface ScorecardState {
  tab: 'measures' | 'goals';
  measures?: readonly MeasureRow[];
  goals?: readonly GoalRow[];
  goal?: { goal: Goal; history: readonly DomainEvent[]; form: GoalForm };
  readonly values: Record<string, string>;
}

const TABS = [
  { id: 'measures', label: 'Measures' },
  { id: 'goals', label: 'Goals' },
] as const;

function formOf(goal: Goal): GoalForm {
  return {
    title: goal.title,
    doneMeans: goal.doneMeans ?? '',
    targetFrom: goal.target === undefined ? '' : String(goal.target.from),
    targetTo: goal.target === undefined ? '' : String(goal.target.to),
    targetUnit: goal.target?.unit ?? '',
    targetBy: goal.target?.by ?? '',
    health: goal.health,
    healthNote: goal.healthNote ?? '',
  };
}

/** The `goals.update` params for what the form changed, or a message when it is incomplete. */
export function goalChanges(goal: Goal, form: GoalForm): Record<string, unknown> | string {
  const params: Record<string, unknown> = { ref: goal.ref, version: goal.version };
  if (form.title.trim() !== goal.title) {
    if (form.title.trim() === '') return 'A goal needs a title.';
    params['title'] = form.title.trim();
  }
  if (form.doneMeans.trim() !== (goal.doneMeans ?? '') && form.doneMeans.trim() !== '') {
    params['doneMeans'] = form.doneMeans.trim();
  }
  const targetParts = [form.targetFrom, form.targetTo, form.targetUnit, form.targetBy];
  if (targetParts.some((part) => part.trim() !== '')) {
    const from = Number(form.targetFrom);
    const to = Number(form.targetTo);
    if (
      form.targetFrom.trim() === '' ||
      form.targetTo.trim() === '' ||
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      form.targetUnit.trim() === '' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(form.targetBy)
    ) {
      return 'A target needs from, to, a unit and a by date.';
    }
    const target = { from, to, unit: form.targetUnit.trim(), by: form.targetBy };
    if (JSON.stringify(target) !== JSON.stringify(goal.target)) params['target'] = target;
  }
  if (form.health !== goal.health || form.healthNote.trim() !== (goal.healthNote ?? '')) {
    params['health'] = {
      value: form.health,
      ...(form.healthNote.trim() === '' ? {} : { note: form.healthNote.trim() }),
    };
  }
  return params;
}

function describe(value: unknown): string {
  if (value === undefined) return '(none)';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** One history entry: what changed, from what to what, by whom and when. */
function historyEntry(event: DomainEvent): VNode {
  const before = (event.before ?? {}) as Record<string, unknown>;
  const after = (event.after ?? {}) as Record<string, unknown>;
  const fields =
    event.type === 'goal.updated'
      ? [...new Set([...Object.keys(before), ...Object.keys(after)])]
      : [];
  return h(
    'li',
    { test: `goal-event-${event.type}` },
    h('span', { class: 'time' }, event.at.slice(0, 16).replace('T', ' ')),
    ' ',
    event.type,
    ' by ',
    event.actor.kind,
    fields.length === 0
      ? null
      : h(
          'ul',
          null,
          fields.map((name) =>
            h(
              'li',
              { test: `change-${name}` },
              `${name}: ${describe(before[name])} → ${describe(after[name])}`,
            ),
          ),
        ),
  );
}

function goalView(state: ScorecardState, ui: Ui): VNode {
  const selected = state.goal;
  if (selected === undefined) return h('p', null, 'No goal.');
  const { goal, form, history } = selected;
  return h(
    'div',
    { test: 'goal-detail' },
    h(
      'p',
      null,
      link('All goals', () => ui.go({ screen: 'scorecard', tab: 'goals' })),
    ),
    h('h2', null, `${goal.ref} ${goal.title}`),
    h('p', { class: 'muted' }, `${goal.kind} · ${goal.period.label} · ${goal.status}`),
    h(
      'div',
      { class: 'form', test: 'goal-form' },
      field('Title', form.title, (value) => (form.title = value), { test: 'goal-title' }),
      field('Done means', form.doneMeans, (value) => (form.doneMeans = value), {
        test: 'goal-done-means',
      }),
      h(
        'fieldset',
        null,
        h('legend', null, 'Target'),
        field('From', form.targetFrom, (value) => (form.targetFrom = value), {
          test: 'target-from',
          type: 'number',
        }),
        field('To', form.targetTo, (value) => (form.targetTo = value), {
          test: 'target-to',
          type: 'number',
        }),
        field('Unit', form.targetUnit, (value) => (form.targetUnit = value), {
          test: 'target-unit',
        }),
        field('By', form.targetBy, (value) => (form.targetBy = value), {
          test: 'target-by',
          type: 'date',
        }),
      ),
      select(
        'Health',
        form.health,
        [
          { value: 'on_track', label: 'On track' },
          { value: 'at_risk', label: 'At risk' },
          { value: 'off_track', label: 'Off track' },
        ],
        (value) => (form.health = value),
        'goal-health',
      ),
      field('Health note', form.healthNote, (value) => (form.healthNote = value), {
        test: 'goal-health-note',
      }),
      button(
        'Save goal',
        () => {
          const params = goalChanges(goal, form);
          if (typeof params === 'string') {
            ui.flash(params, 'error');
            return;
          }
          void act(
            ui,
            () => ui.call('goals.update', params),
            `${goal.ref} saved; the change is in its history.`,
          );
        },
        { test: 'save-goal', primary: true },
      ),
    ),
    section(
      'History',
      h('ol', { class: 'history', test: 'goal-history' }, history.map(historyEntry)),
    ),
  );
}

function measuresView(state: ScorecardState, ui: Ui): VNode {
  const measures = state.measures ?? [];
  return table(
    ['Measure', 'Name', 'Target', 'Latest', 'Record'],
    measures.map((measure) => {
      const value = state.values[measure.ref] ?? '';
      return h(
        'tr',
        { test: `measure-${measure.ref}` },
        h('td', null, measure.ref),
        h('td', null, measure.name),
        h('td', null, describe(measure.target)),
        h(
          'td',
          null,
          measure.latest === undefined
            ? '—'
            : `${String(measure.latest.value)} ${measure.unit} (${measure.latest.periodStart})`,
        ),
        h(
          'td',
          null,
          measure.unit === 'boolean'
            ? select(
                'Value',
                value,
                [
                  { value: '', label: '' },
                  { value: 'true', label: 'Yes' },
                  { value: 'false', label: 'No' },
                ],
                (next) => (state.values[measure.ref] = next),
                `value-${measure.ref}`,
              )
            : field('Value', value, (next) => (state.values[measure.ref] = next), {
                test: `value-${measure.ref}`,
                type: 'number',
              }),
          button(
            'Record',
            () => {
              const raw = (state.values[measure.ref] ?? '').trim();
              const parsed = measure.unit === 'boolean' ? raw === 'true' : Number(raw);
              if (raw === '' || (typeof parsed === 'number' && !Number.isFinite(parsed))) {
                ui.flash('Enter a value first.', 'error');
                return;
              }
              state.values[measure.ref] = '';
              void act(
                ui,
                () => ui.call('measures.record', { ref: measure.ref, value: parsed }),
                `${measure.ref} recorded.`,
              );
            },
            { test: `record-${measure.ref}` },
          ),
        ),
      );
    }),
    'No measures yet.',
  );
}

export const scorecardScreen: Screen<ScorecardState> = {
  async load(ui, route: AppRoute) {
    if (route.screen !== 'scorecard') throw new Error('not the scorecard screen');
    const values = ui.keep('measure-values', () => ({}) as Record<string, string>);
    const tab = route.ref !== undefined ? 'goals' : (route.tab ?? 'measures');
    if (route.ref !== undefined) {
      const [{ goal }, history] = await Promise.all([
        ui.call<{ goal: Goal }>('goals.get', { ref: route.ref }),
        ui.call<HistoryResult>('goals.history', { ref: route.ref, limit: 200 }),
      ]);
      return { tab, values, goal: { goal, history: history.events, form: formOf(goal) } };
    }
    if (tab === 'goals') {
      const list = await ui.call<{ goals: GoalRow[] }>('goals.list', {
        period: 'current',
        limit: 200,
      });
      return { tab, values, goals: list.goals };
    }
    const list = await ui.call<{ measures: MeasureRow[] }>('measures.list', { limit: 200 });
    return { tab, values, measures: list.measures };
  },
  view(state, ui) {
    const header = tabs(state.tab, TABS, (tab) => ui.go({ screen: 'scorecard', tab }));
    if (state.goal !== undefined) return page('Scorecard', header, goalView(state, ui));
    if (state.tab === 'goals') {
      return page(
        'Scorecard',
        header,
        h(
          'p',
          { class: 'muted' },
          'Goals can be edited any time; every change is logged in the goal’s history.',
        ),
        table(
          ['Goal', 'Title', 'Kind', 'Status', 'Health'],
          (state.goals ?? []).map((goal) =>
            h(
              'tr',
              { test: `goal-${goal.ref}` },
              h(
                'td',
                null,
                link(goal.ref, () => ui.go({ screen: 'scorecard', tab: 'goals', ref: goal.ref })),
              ),
              h('td', null, goal.title),
              h('td', null, goal.kind),
              h('td', null, goal.status),
              h('td', null, healthChip(goal.health)),
            ),
          ),
          'No goals this period.',
        ),
      );
    }
    return page('Scorecard', header, measuresView(state, ui));
  },
};
