/**
 * S6 to S9 of the onboarding wizard (01 §3, §3.1 rows 47 to 67): the composed rhythm with its
 * checks, the tools and calendars, the AI provider, and the full preview with the commit.
 */
import type { ToolAnswer, ToolCategory } from '@cc/schemas';

import type { Ui } from '../../app/screen.js';
import { button, checkbox, chip, field, section, select, table } from '../../ui/parts.js';
import { h, type VNode } from '../../ui/vnode.js';
import { parameterControl } from './frameworks.js';
import {
  ask,
  chosenTemplate,
  ownInstance,
  tailoringOf,
  type Notice,
  type Preview,
  type WizardState,
} from './model.js';

function notices(list: readonly Notice[], kind: 'error' | 'warn', test: string): VNode | null {
  if (list.length === 0) return null;
  return h(
    'ul',
    { class: `notices ${kind}`, test },
    list.map((notice) =>
      h(
        'li',
        null,
        h('strong', null, notice.code),
        ' ',
        notice.text,
        notice.help.length === 0
          ? null
          : h('span', { class: 'muted' }, ` ${notice.help.join(' ')}`),
      ),
    ),
  );
}

function seriesTable(preview: Preview): VNode {
  return table(
    ['Meeting', 'Repeats', 'First', 'Minutes', 'Workstreams'],
    preview.series.map((s) =>
      h(
        'tr',
        { test: `series-${s.meeting}` },
        h(
          'td',
          null,
          s.name,
          s.absorbs === undefined ? null : h('span', { class: 'muted' }, ` (absorbs ${s.absorbs})`),
        ),
        h('td', null, s.rrule),
        h('td', null, s.dtstart.replace('T', ' ')),
        h('td', null, String(s.durationMinutes)),
        h('td', null, s.workstreams.join(', ')),
      ),
    ),
    'No meetings yet.',
  );
}

/** S6 `rhythm` (rows 47 to 51). */
export function rhythmStep(state: WizardState, ui: Ui): VNode {
  const work = state.work;
  const rhythm = (work.profile.rhythm ??= {
    dailyStart: true,
    dailyShutdown: true,
    acceptedOverlaps: [],
  });
  const preview = state.preview;
  const result = state.recommend;
  const budget = preview?.blockers.find((b) => b.code === 'W-TIME-BUDGET');
  const noSlot = preview?.blockers.find((b) => b.code === 'W-NO-SLOT');
  const placements = preview?.blockers.filter((b) => b.overlap !== undefined) ?? [];
  return h(
    'div',
    { test: 'step-rhythm' },
    preview === undefined
      ? h('p', { class: 'failure' }, state.problem ?? 'The rhythm could not be composed yet.')
      : section(
          'Your weekly rhythm',
          seriesTable(preview),
          h(
            'p',
            { test: 'time-budget' },
            `About ${String(Math.round(preview.timeBudget.averageWeeklyMinutes))} minutes a week of meetings and reviews, against a budget of ${String(preview.timeBudget.weeklyManagementMinutes)}.`,
          ),
          notices(preview.warnings, 'warn', 'rhythm-warnings'),
        ),
    ask(
      47,
      result === undefined
        ? null
        : result.recommendations.filter(ownInstance).map((rec) => {
            const template = chosenTemplate(work, rec, result.templates);
            if (template === undefined) return null;
            const tailoring = tailoringOf(work, rec);
            const defaults = template.id === rec.templateId ? rec.parameterDefaults : {};
            return h(
              'div',
              { class: 'row', test: `times-${rec.workstreamKey}` },
              h('strong', null, rec.workstreamKey),
              template.parameters
                .filter((p) => p.key.startsWith('weekly.'))
                .map((p) =>
                  parameterControl(
                    ui,
                    p,
                    tailoring,
                    defaults,
                    `time-${rec.workstreamKey}-${p.key}`,
                  ),
                ),
            );
          }),
      button('Compose again', () => void ui.reload(), { test: 'recompose' }),
    ),
    ask(
      48,
      checkbox(
        'Keep the daily start',
        rhythm.dailyStart,
        (checked) => (rhythm.dailyStart = checked),
        'daily-start',
      ),
      checkbox(
        'Keep the daily shutdown',
        rhythm.dailyShutdown,
        (checked) => (rhythm.dailyShutdown = checked),
        'daily-shutdown',
      ),
    ),
    ask(
      49,
      placements.length === 0 && rhythm.acceptedOverlaps.length === 0
        ? h('p', { class: 'muted' }, 'Nothing needs your confirmation.')
        : null,
      placements.map((blocker, index) =>
        h(
          'div',
          { class: 'row', test: `placement-${String(index)}` },
          h('span', null, blocker.text),
          button(
            'Confirm',
            () => {
              const overlap = blocker.overlap;
              if (overlap === undefined) return;
              rhythm.acceptedOverlaps = [...rhythm.acceptedOverlaps, overlap];
              void ui.reload();
            },
            { test: `confirm-placement-${String(index)}` },
          ),
        ),
      ),
      rhythm.acceptedOverlaps.map((overlap, index) =>
        h(
          'div',
          { class: 'row' },
          chip('confirmed', 'good'),
          ` ${overlap.meetingKey} of ${overlap.workstreamKey}${overlap.blockId === undefined ? ' outside working hours' : ` in ${overlap.blockId}`} `,
          button('Withdraw', () => {
            rhythm.acceptedOverlaps = rhythm.acceptedOverlaps.filter((_, i) => i !== index);
            void ui.reload();
          }),
        ),
      ),
    ),
    ask(
      50,
      budget === undefined && rhythm.timeBudgetFix === undefined
        ? h('p', { class: 'muted' }, 'The rhythm fits your budget.')
        : [
            budget === undefined ? null : h('p', { class: 'flash error' }, budget.text),
            select(
              'Pick one',
              rhythm.timeBudgetFix ?? '',
              [
                { value: '', label: 'Choose…' },
                { value: 'merge', label: 'Merge more meetings' },
                { value: 'shorten', label: 'Shorten meetings to their minimums' },
                { value: 'biweekly', label: 'Move personal-os weekly reviews to every other week' },
                { value: 'raise_budget', label: 'Raise the budget' },
              ],
              (value) => {
                if (value === '') delete rhythm.timeBudgetFix;
                else rhythm.timeBudgetFix = value as NonNullable<typeof rhythm.timeBudgetFix>;
                void ui.reload();
              },
              'time-budget-fix',
            ),
          ],
    ),
    ask(
      51,
      noSlot === undefined
        ? h('p', { class: 'muted' }, 'Every required meeting has a slot.')
        : [
            h('p', { class: 'flash error' }, noSlot.text),
            button('Change a time (S5)', () => ui.go({ screen: 'onboarding', step: 'tailoring' })),
            button('Change a block (S1)', () => ui.go({ screen: 'onboarding', step: 'workspace' })),
          ],
    ),
  );
}

const CATEGORIES: readonly ToolCategory[] = [
  'calendar',
  'email',
  'chat',
  'social',
  'social_scheduler',
  'cms',
  'crm',
  'hosting',
  'code',
  'docs',
  'time_tracking',
  'analytics',
  'job_board',
  'accounting',
  'task_tracker',
  'other',
];

const TRACKERS = {
  jira: { toolName: 'Jira', connectorId: 'jira' },
  linear: { toolName: 'Linear', connectorId: 'linear' },
  sheet: { toolName: 'Google Sheets', connectorId: 'google-sheets' },
} as const;

function choiceText(choice: ToolAnswer['choice']): string {
  switch (choice.kind) {
    case 'connector':
      return `connector ${choice.connectorId}`;
    case 'discover':
      return 'find with AI';
    default:
      return choice.kind;
  }
}

function workstreamBoxes(
  state: WizardState,
  chosen: string[],
  test: string,
  extra: readonly string[] = [],
): VNode {
  const keys = [...extra, ...state.work.profile.workstreams.map((w) => w.key)];
  return h(
    'div',
    { class: 'scopes' },
    keys.map((key) =>
      checkbox(
        key,
        chosen.includes(key),
        (checked) => {
          const at = chosen.indexOf(key);
          if (checked && at < 0) chosen.push(key);
          if (!checked && at >= 0) chosen.splice(at, 1);
        },
        `${test}-${key}`,
      ),
    ),
  );
}

/** S7 `tools` (rows 52 to 59; the team task tracker is owner decision C2). */
export function toolsStep(state: WizardState, ui: Ui): VNode {
  const work = state.work;
  const tools = work.profile.tools;
  const form = work.forms.tool;
  const tracker = work.forms.tracker;
  const mapping = work.calendarMapping;
  const route = work.forms.route;
  const byCategory = CATEGORIES.filter((category) =>
    tools.some((tool) => tool.category === category),
  );
  return h(
    'div',
    { test: 'step-tools' },
    h(
      'p',
      { class: 'muted' },
      'Connectors arrive in a later release. Until then, choose a connector to set up later, manual (you do these steps by hand), find with AI, or later. Nothing signs in now.',
    ),
    ask(
      52,
      byCategory.length === 0 ? h('p', { class: 'empty' }, 'No tools yet.') : null,
      byCategory.map((category) =>
        h(
          'div',
          { class: 'tool-group', test: `tools-${category}` },
          h('h3', null, category.replace(/_/g, ' ')),
          table(
            ['Tool', 'Workstreams', 'Account', 'Choice', ''],
            tools
              .filter((tool) => tool.category === category)
              .map((tool) =>
                h(
                  'tr',
                  null,
                  h('td', null, tool.toolName),
                  h('td', null, tool.workstreamKeys.join(', ')),
                  h('td', null, tool.accountLabel ?? ''),
                  h('td', null, choiceText(tool.choice)),
                  h(
                    'td',
                    null,
                    button('Remove', () => {
                      work.profile.tools = tools.filter((t) => t !== tool);
                      ui.render();
                    }),
                  ),
                ),
              ),
            '',
          ),
        ),
      ),
      h(
        'div',
        { class: 'form', test: 'add-tool' },
        select(
          'Category',
          form.category,
          CATEGORIES.map((c) => ({ value: c, label: c.replace(/_/g, ' ') })),
          (v) => (form.category = v),
          'tool-category',
        ),
        field('Tool', form.toolName, (v) => (form.toolName = v), {
          test: 'tool-name',
          placeholder: 'Gmail',
        }),
        ask(54, workstreamBoxes(state, form.workstreamKeys, 'tool-workstream')),
        ask(
          55,
          field('Account label', form.accountLabel, (v) => (form.accountLabel = v), {
            test: 'tool-account',
            placeholder: 'gmail-alderwick',
          }),
        ),
        ask(
          56,
          select(
            'Choice',
            form.choice,
            [
              { value: 'connector', label: 'A connector' },
              { value: 'manual', label: 'Manual: I do it by hand' },
              { value: 'discover', label: 'Find with AI (public research only, when I start it)' },
              { value: 'later', label: 'Later' },
            ],
            (v) => {
              form.choice = v as typeof form.choice;
              ui.render();
            },
            'tool-choice',
          ),
          form.choice === 'connector'
            ? field('Connector ID', form.connectorId, (v) => (form.connectorId = v), {
                test: 'tool-connector',
                placeholder: 'gmail',
              })
            : null,
        ),
        button(
          'Add tool',
          () => {
            if (form.toolName.trim() === '' || form.workstreamKeys.length === 0) {
              ui.flash('A tool needs a name and at least one workstream.', 'error');
              return;
            }
            if (form.choice === 'connector' && form.connectorId.trim() === '') {
              ui.flash('Name the connector, or choose manual, find with AI or later.', 'error');
              return;
            }
            work.profile.tools = [
              ...tools,
              {
                workstreamKeys: [...form.workstreamKeys],
                category: form.category as ToolCategory,
                toolName: form.toolName.trim(),
                ...(form.accountLabel.trim() === ''
                  ? {}
                  : { accountLabel: form.accountLabel.trim() }),
                choice:
                  form.choice === 'connector'
                    ? { kind: 'connector', connectorId: form.connectorId.trim() }
                    : { kind: form.choice },
              },
            ];
            work.forms.tool = { ...form, toolName: '', accountLabel: '', connectorId: '' };
            ui.render();
          },
          { test: 'tool-add', primary: true },
        ),
      ),
    ),
    ask(
      53,
      h(
        'p',
        { class: 'muted' },
        'Where does your team track tasks? With none, Command Center can keep them in a Google Sheet once that connector arrives.',
      ),
      select(
        'Team tasks',
        tracker.answer,
        [
          { value: '', label: 'Choose…' },
          { value: 'jira', label: 'Jira' },
          { value: 'linear', label: 'Linear' },
          { value: 'sheet', label: 'None → Google Sheet' },
        ],
        (v) => (tracker.answer = v as typeof tracker.answer),
        'tracker',
      ),
      workstreamBoxes(state, tracker.workstreamKeys, 'tracker-workstream'),
      button(
        'Set the task tracker',
        () => {
          if (tracker.answer === '' || tracker.workstreamKeys.length === 0) {
            ui.flash('Choose the tracker and its workstreams.', 'error');
            return;
          }
          const picked = TRACKERS[tracker.answer];
          work.profile.tools = [
            ...tools.filter((tool) => tool.category !== 'task_tracker'),
            {
              workstreamKeys: [...tracker.workstreamKeys],
              category: 'task_tracker',
              toolName: picked.toolName,
              choice: { kind: 'later' },
            },
          ];
          ui.render();
        },
        { test: 'tracker-set' },
      ),
    ),
    section(
      'Calendars',
      ask(
        57,
        table(
          ['Workstreams', 'Account (binding)', 'Calendar', 'Role', ''],
          mapping.routes.flatMap((r, routeIndex) =>
            r.targets.map((target) =>
              h(
                'tr',
                null,
                h('td', null, r.workstreams === 'all' ? 'all' : r.workstreams.join(', ')),
                h('td', null, target.binding),
                h('td', null, target.calendar),
                h('td', null, target.role),
                h(
                  'td',
                  null,
                  button('Remove', () => {
                    mapping.routes = mapping.routes.filter((_, i) => i !== routeIndex);
                    ui.render();
                  }),
                ),
              ),
            ),
          ),
          'No calendar routes: meetings can still be exported as .ics.',
        ),
        field('Account (binding label)', route.binding, (v) => (route.binding = v), {
          test: 'route-binding',
          placeholder: 'gcal-main',
        }),
        field('Calendar', route.calendar, (v) => (route.calendar = v), {
          test: 'route-calendar',
          placeholder: 'Work',
        }),
      ),
      ask(58, workstreamBoxes(state, route.workstreams, 'route-workstream', ['all', 'portfolio'])),
      ask(
        59,
        select(
          'Role',
          route.role,
          [
            { value: 'primary', label: 'Primary: its moves are accepted first' },
            { value: 'mirror', label: 'Mirror' },
          ],
          (v) => (route.role = v as 'primary' | 'mirror'),
          'route-role',
        ),
        button(
          'Add calendar route',
          () => {
            if (
              route.binding.trim() === '' ||
              route.calendar.trim() === '' ||
              route.workstreams.length === 0
            ) {
              ui.flash('A route needs an account, a calendar and its workstreams.', 'error');
              return;
            }
            const workstreams = route.workstreams.includes('all') ? 'all' : [...route.workstreams];
            const target = {
              binding: route.binding.trim(),
              calendar: route.calendar.trim(),
              role: route.role,
            };
            const same = mapping.routes.find(
              (r) => JSON.stringify(r.workstreams) === JSON.stringify(workstreams),
            );
            if (
              same !== undefined &&
              target.role === 'primary' &&
              same.targets.some((t) => t.role === 'primary')
            ) {
              ui.flash(
                'Those workstreams have a primary calendar already; add this one as a mirror.',
                'error',
              );
              return;
            }
            if (same === undefined)
              mapping.routes = [...mapping.routes, { workstreams, targets: [target] }];
            else same.targets = [...same.targets, target];
            const providers = tools
              .filter((t) => t.category === 'calendar' && t.choice.kind === 'connector')
              .map((t) => (t.choice as { connectorId: string }).connectorId);
            mapping.providers =
              providers.length === 0 ? ['google-calendar'] : [...new Set(providers)];
            route.calendar = '';
            ui.render();
          },
          { test: 'route-add' },
        ),
      ),
    ),
  );
}

const PROVIDERS = [
  { value: 'claude_cli', label: 'Claude CLI' },
  { value: 'anthropic_api', label: 'Anthropic API' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'none', label: 'None: no AI steps' },
  { value: 'discover', label: 'Another provider (find with AI)' },
];

const TASKS = ['draft', 'extract', 'plan', 'review', 'summarize', 'discover', 'tailor'] as const;

/** S8 `ai` (rows 60 to 64). */
export function aiStep(state: WizardState, ui: Ui): VNode {
  const ai = state.work.profile.ai;
  const discovering = ai.discover !== undefined;
  return h(
    'div',
    { test: 'step-ai' },
    h(
      'p',
      { class: 'muted' },
      'No AI runs in this build: the choice is recorded, and AI steps start in a later release, with a test call first.',
    ),
    ask(
      60,
      select(
        'Provider',
        discovering ? 'discover' : ai.provider,
        PROVIDERS,
        (value) => {
          if (value === 'discover') {
            ai.provider = 'none';
            ai.discover = { providerName: ai.discover?.providerName ?? '' };
          } else {
            ai.provider = value;
            delete ai.discover;
          }
          ui.render();
        },
        'ai-provider',
      ),
    ),
    ask(
      61,
      discovering
        ? field(
            'Provider name',
            ai.discover?.providerName ?? '',
            (v) => (ai.discover = { providerName: v }),
            { test: 'ai-discover' },
          )
        : h('p', { class: 'muted' }, 'Asked when your provider has no adapter.'),
    ),
    ask(
      62,
      field(
        'Model (empty: the default)',
        ai.model ?? '',
        (v) => {
          if (v.trim() === '') delete ai.model;
          else ai.model = v.trim();
        },
        { test: 'ai-model' },
      ),
    ),
    ask(
      63,
      h(
        'div',
        { class: 'form' },
        TASKS.map((task) =>
          select(
            task,
            ai.perTask?.[task]?.provider ?? '',
            [{ value: '', label: 'As above' }, ...PROVIDERS.filter((p) => p.value !== 'discover')],
            (value) => {
              const perTask = { ...(ai.perTask ?? {}) };
              if (value === '') delete perTask[task];
              else perTask[task] = { provider: value };
              if (Object.keys(perTask).length === 0) delete ai.perTask;
              else ai.perTask = perTask;
            },
            `ai-task-${task}`,
          ),
        ),
      ),
    ),
    ask(
      64,
      field(
        'Daily budget (USD)',
        ai.dailyBudgetUsd === undefined ? '' : String(ai.dailyBudgetUsd),
        (v) => {
          const value = Number(v);
          if (v.trim() === '' || !Number.isFinite(value) || value < 0) delete ai.dailyBudgetUsd;
          else ai.dailyBudgetUsd = value;
        },
        { type: 'number', test: 'ai-budget' },
      ),
    ),
  );
}

/** S9 `commit` (rows 65 to 67): the full preview, then Confirm. */
export function commitStep(state: WizardState, ui: Ui, confirm: () => void): VNode {
  const preview = state.preview;
  if (preview === undefined) {
    return h(
      'div',
      { test: 'step-commit' },
      h('p', { class: 'failure' }, state.problem ?? 'No preview yet.'),
    );
  }
  const blocked = preview.blockers.length > 0;
  const calendar = preview.outwardActions.filter((a) => a.kind === 'calendar_batch');
  const signIns = preview.outwardActions.filter((a) => a.kind === 'sign_in');
  const appOnly = state.status.appOnly;
  return h(
    'div',
    { test: 'step-commit' },
    h(
      'p',
      null,
      `Nothing outside Command Center changes now. Confirm writes these records in one step; the meetings start in the week of ${preview.rhythmStartsOn}.`,
    ),
    section(
      'Workstreams and frameworks',
      table(
        ['Workstream', 'Kind', 'Framework', 'Mode', 'Packs', 'Rules'],
        preview.workstreams.map((w) => {
          const instance = preview.frameworkInstances.find((i) => i.workstream === w.key);
          return h(
            'tr',
            { test: `preview-${w.key}` },
            h('td', null, w.name),
            h('td', null, w.kind.replace('_', ' ')),
            h('td', null, instance?.templateId ?? (w.parent === undefined ? '' : `as ${w.parent}`)),
            h('td', null, instance?.mode ?? ''),
            h('td', null, instance?.packs.join(', ') ?? ''),
            h('td', null, instance?.firedRules.join(' ') ?? ''),
          );
        }),
        'No workstreams.',
      ),
    ),
    section(
      'Meetings',
      seriesTable(preview),
      h(
        'p',
        { class: 'muted' },
        `${String(preview.instances.count)} meetings planned to ${preview.instances.last ?? ''}.`,
      ),
    ),
    section(
      'Scorecard and goals',
      table(
        ['Ref', 'Line', 'Target', 'Workstreams'],
        preview.measures.map((m) =>
          h(
            'tr',
            null,
            h('td', null, m.ref),
            h('td', null, m.name),
            h('td', null, m.target),
            h('td', null, m.workstreams.join(', ')),
          ),
        ),
        'No scorecard lines.',
      ),
      table(
        ['Ref', 'Goal', 'Workstream', 'Period'],
        preview.goals.map((g) =>
          h(
            'tr',
            null,
            h('td', null, g.ref),
            h('td', null, g.title),
            h('td', null, g.workstream),
            h('td', null, g.period),
          ),
        ),
        'No goals.',
      ),
    ),
    section(
      'Before you confirm',
      notices(preview.blockers, 'error', 'commit-blockers'),
      notices(preview.warnings, 'warn', 'commit-warnings'),
      h(
        'ul',
        { test: 'app-only' },
        appOnly
          .filter((a) => a.row === 9 || a.row === 10)
          .map((a) =>
            h(
              'li',
              null,
              `${String(a.row)}. ${a.question}: `,
              a.answered ? chip('set', 'good') : chip('not set; you may set it later in Settings'),
            ),
          ),
      ),
    ),
    ask(
      65,
      button(blocked ? 'Answer the blockers first' : 'Confirm', confirm, {
        test: 'onboarding-confirm',
        primary: true,
        disabled: blocked,
      }),
    ),
    ask(
      66,
      calendar.length === 0
        ? h(
            'p',
            { class: 'muted' },
            'No calendar is connected. Meetings stay in Command Center (and can be exported as .ics).',
          )
        : h(
            'ul',
            null,
            calendar.map((a) => h('li', null, a.text)),
          ),
      h(
        'p',
        { class: 'muted' },
        'The first calendar write asks you to approve one batch, in the app, once a calendar connector is installed.',
      ),
    ),
    ask(
      67,
      signIns.length === 0
        ? h('p', { class: 'muted' }, 'No service to sign in to.')
        : h(
            'ul',
            { test: 'sign-ins' },
            signIns.map((a) => h('li', null, a.text)),
          ),
    ),
  );
}
