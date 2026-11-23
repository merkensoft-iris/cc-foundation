/**
 * S4 and S5 of the onboarding wizard (01 §3, §3.1 rows 34 to 46; §8): the recommendation with
 * its two alternatives, and the tailoring questions of each framework instance.
 */
import type {
  FrameworkRecommendation,
  FrameworkTemplate,
  GoalKind,
  ParameterSpec,
  TailoringAnswers,
} from '@cc/schemas';

import type { Ui } from '../../app/screen.js';
import { button, checkbox, chip, field, section, select, table } from '../../ui/parts.js';
import { h, type VNode } from '../../ui/vnode.js';
import {
  ask,
  chosenTemplate,
  numberOf,
  ownInstance,
  packsOf,
  tailoringOf,
  WEEKDAY_NAMES,
  WEEKDAYS,
  type WizardState,
  type Work,
} from './model.js';

/** S4 `recommendation` (row 34). */
export function recommendationStep(state: WizardState, ui: Ui): VNode {
  const result = state.recommend;
  if (result === undefined) {
    return h(
      'p',
      { class: 'failure', test: 'step-recommendation' },
      state.problem ?? 'No recommendation yet.',
    );
  }
  const work = state.work;
  return h(
    'div',
    { test: 'step-recommendation' },
    h(
      'p',
      { class: 'muted' },
      'Each workstream gets one framework. The recommendation follows fixed rules from your answers (no AI); you may pick one of the two alternatives instead.',
    ),
    result.recommendations.map((rec) => {
      const name =
        work.profile.workstreams.find((w) => w.key === rec.workstreamKey)?.name ??
        rec.workstreamKey;
      if (!ownInstance(rec)) {
        return section(
          name,
          h(
            'p',
            { test: `rec-${rec.workstreamKey}` },
            rec.rationale[0] ?? 'Uses its parent’s framework.',
          ),
        );
      }
      const chosen = chosenTemplate(work, rec, result.templates)?.id ?? rec.templateId;
      const options = [
        {
          id: rec.templateId,
          label: `Accept ${rec.templateId}`,
          why: undefined as string | undefined,
        },
        ...rec.alternatives.map((alt) => ({
          id: alt.templateId,
          label: `Use ${alt.templateId} instead`,
          why: alt.whyNot,
        })),
      ];
      return section(
        name,
        h(
          'div',
          { test: `rec-${rec.workstreamKey}` },
          h(
            'p',
            null,
            chip(rec.templateId, 'good'),
            ' ',
            chip(rec.mode),
            ' ',
            rec.packIds.map((pack) => [chip(pack), ' ']),
            rec.mergeGroup === undefined ? null : chip(`merged: ${rec.mergeGroup}`),
          ),
          h('p', { class: 'muted' }, `Rules: ${rec.firedRules.join(', ')}`),
          h(
            'ul',
            null,
            rec.rationale.map((line) => h('li', null, line)),
          ),
          rec.warnings.map((warning) =>
            h('p', { class: 'flash error' }, `${warning.code}: ${warning.text}`),
          ),
          ask(
            34,
            h(
              'div',
              { class: 'choices' },
              options.map((option) =>
                h(
                  'div',
                  { class: 'choice' },
                  button(
                    option.label,
                    () => {
                      work.choices[rec.workstreamKey] = option.id;
                      ui.render();
                    },
                    {
                      test: `choose-${rec.workstreamKey}-${option.id}`,
                      primary: chosen === option.id,
                    },
                  ),
                  option.id === chosen ? [' ', chip('chosen', 'good')] : null,
                  option.why === undefined ? null : h('span', { class: 'muted' }, ` ${option.why}`),
                ),
              ),
            ),
          ),
        ),
      );
    }),
  );
}

/** Records S4: the recommendations and the choices (01 §4 `recommendations`, `accepted`). */
export function acceptChoices(state: WizardState, now: string): void {
  const result = state.recommend;
  if (result === undefined) return;
  const work = state.work;
  work.profile.recommendations = result.recommendations;
  work.profile.accepted = result.recommendations.filter(ownInstance).map((rec) => {
    const templateId = chosenTemplate(work, rec, result.templates)?.id ?? rec.templateId;
    const before = work.profile.accepted?.find((a) => a.workstreamKey === rec.workstreamKey);
    return {
      workstreamKey: rec.workstreamKey,
      templateId,
      acceptedAt: before?.templateId === templateId ? before.acceptedAt : now,
      overrodeRecommendation: templateId !== rec.templateId,
    };
  });
}

/** One ParameterSpec as a control, bound to the tailoring answers (Q-T01, C-01-04). */
export function parameterControl(
  ui: Ui,
  spec: ParameterSpec,
  tailoring: TailoringAnswers,
  defaults: Record<string, unknown>,
  test: string,
): VNode {
  const current = tailoring.parameters[spec.key] ?? defaults[spec.key] ?? spec.default;
  const set = (value: unknown) => {
    tailoring.parameters = { ...tailoring.parameters, [spec.key]: value };
  };
  const label = spec.description;
  switch (spec.type) {
    case 'weekday':
      return select(
        label,
        String(current),
        WEEKDAYS.map((day) => ({ value: day, label: WEEKDAY_NAMES[day] })),
        set,
        test,
      );
    case 'time_of_day':
      return field(label, String(current), set, { type: 'time', test });
    case 'int':
    case 'duration_minutes':
      return field(
        `${label}${spec.min !== undefined && spec.max !== undefined ? ` (${String(spec.min)} to ${String(spec.max)})` : ''}`,
        String(current),
        (value) => set(Math.round(numberOf(value, Number(current)))),
        { type: 'number', test },
      );
    case 'enum':
      return select(
        label,
        String(current),
        (spec.enum ?? []).map((value) => ({ value, label: value.replace(/_/g, ' ') })),
        set,
        test,
      );
    case 'bool':
      return checkbox(label, current === true, (checked) => set(checked), test);
    case 'string':
      return field(label, String(current), set, { test });
  }
}

const GOAL_KINDS: Readonly<Record<string, GoalKind>> = {
  rocks: 'priority',
  wig: 'wig',
  personal_goals: 'personal_goal',
  okr: 'objective',
  priorities: 'priority',
};

function measuresQuestion(
  ui: Ui,
  work: Work,
  rec: FrameworkRecommendation,
  tailoring: TailoringAnswers,
  packs: WizardState['recommend'],
): VNode {
  const key = rec.workstreamKey;
  const form = (work.forms.measure[key] ??= {
    name: '',
    role: 'lead',
    unit: 'count',
    cadence: 'weekly',
    op: 'gte',
    value: '',
    value2: '',
    ownerRole: 'self',
    source: 'manual',
  });
  const suggestions = packsOf(rec, packs?.packs ?? []).flatMap((pack) => pack.measureTemplates);
  const add = (line: TailoringAnswers['measures'][number]) => {
    tailoring.measures = [...tailoring.measures, line];
    ui.render();
  };
  return ask(
    37,
    table(
      ['Line', 'Role', 'Unit', 'Cadence', 'Target', 'Owner', 'Source', ''],
      tailoring.measures.map((line, index) =>
        h(
          'tr',
          { test: `measure-${key}-${String(index)}` },
          h('td', null, line.ref === undefined ? line.name : `${line.ref} ${line.name}`),
          h('td', null, line.role),
          h('td', null, line.currency === undefined ? line.unit : `${line.unit} ${line.currency}`),
          h('td', null, line.cadence),
          h(
            'td',
            null,
            line.target === undefined
              ? 'per plan'
              : `${line.target.op} ${String(line.target.value)}${line.target.value2 === undefined ? '' : ` and ${String(line.target.value2)}`}`,
          ),
          h('td', null, line.ownerRole),
          h('td', null, line.source),
          h(
            'td',
            null,
            button('Remove', () => {
              tailoring.measures = tailoring.measures.filter((_, i) => i !== index);
              ui.render();
            }),
          ),
        ),
      ),
      'No scorecard lines yet.',
    ),
    suggestions.length === 0
      ? null
      : h(
          'div',
          { class: 'suggestions' },
          h('span', { class: 'muted' }, 'From your packs: '),
          suggestions
            .filter((s) => !tailoring.measures.some((line) => line.name === s.name))
            .map((s) =>
              // A suggestion fills the form below; the user sets its target before adding it.
              button(
                `+ ${s.name}`,
                () => {
                  const cadence =
                    s.cadence === 'weekly' ||
                    s.cadence === 'daily' ||
                    s.cadence === 'monthly' ||
                    s.cadence === 'quarterly'
                      ? s.cadence
                      : 'weekly';
                  Object.assign(form, {
                    name: s.name,
                    role: s.role,
                    unit: s.unit,
                    cadence,
                    op: s.defaultTarget?.op ?? 'gte',
                    value: s.defaultTarget === undefined ? '' : String(s.defaultTarget.value),
                    value2: '',
                  });
                  ui.render();
                },
                { test: `suggest-${key}-${s.key}` },
              ),
            ),
        ),
    h(
      'div',
      { class: 'form', test: `add-measure-${key}` },
      field('Line', form.name, (v) => (form.name = v), { test: `measure-name-${key}` }),
      select(
        'Role',
        form.role,
        [
          { value: 'lead', label: 'lead' },
          { value: 'lag', label: 'lag' },
        ],
        (v) => (form.role = v as 'lead' | 'lag'),
      ),
      select(
        'Unit',
        form.unit,
        ['count', 'percent', 'currency', 'hours', 'boolean', 'days'].map((u) => ({
          value: u,
          label: u,
        })),
        (v) => (form.unit = v),
      ),
      select(
        'Cadence',
        form.cadence,
        ['weekly', 'daily', 'monthly', 'quarterly'].map((c) => ({ value: c, label: c })),
        (v) => (form.cadence = v),
      ),
      select(
        'Target',
        form.op,
        [
          { value: 'gte', label: 'at least' },
          { value: 'lte', label: 'at most' },
          { value: 'eq', label: 'equal to' },
          { value: 'between', label: 'between' },
          { value: 'plan', label: 'per plan (set later)' },
        ],
        (v) => {
          form.op = v;
          ui.render();
        },
      ),
      form.op === 'plan'
        ? null
        : field('Value', form.value, (v) => (form.value = v), { test: `measure-value-${key}` }),
      form.op === 'between' ? field('and', form.value2, (v) => (form.value2 = v)) : null,
      field('Owner (role)', form.ownerRole, (v) => (form.ownerRole = v)),
      select(
        'Source',
        form.source,
        [
          { value: 'manual', label: 'manual' },
          { value: 'derived', label: 'derived' },
        ],
        (v) => (form.source = v as 'manual' | 'derived'),
      ),
      button(
        'Add line',
        () => {
          if (form.name.trim() === '') {
            ui.flash('A scorecard line needs a name.', 'error');
            return;
          }
          const value =
            form.value === 'true'
              ? true
              : form.value === 'false'
                ? false
                : numberOf(form.value, NaN);
          if (form.op !== 'plan' && typeof value === 'number' && Number.isNaN(value)) {
            ui.flash('A target is a number, or true or false.', 'error');
            return;
          }
          add({
            name: form.name.trim(),
            role: form.role,
            unit: form.unit as TailoringAnswers['measures'][number]['unit'],
            cadence: form.cadence as TailoringAnswers['measures'][number]['cadence'],
            ...(form.op === 'plan'
              ? {}
              : {
                  target: {
                    op: form.op as 'gte' | 'lte' | 'eq' | 'between',
                    value,
                    ...(form.op === 'between' ? { value2: numberOf(form.value2, 0) } : {}),
                  },
                }),
            ownerRole: form.ownerRole.trim() || 'self',
            source: form.source,
          });
          form.name = '';
          form.value = '';
        },
        { test: `measure-add-${key}` },
      ),
    ),
  );
}

function goalsQuestion(
  ui: Ui,
  work: Work,
  rec: FrameworkRecommendation,
  template: FrameworkTemplate,
  tailoring: TailoringAnswers,
): VNode {
  const key = rec.workstreamKey;
  const kind = GOAL_KINDS[template.backbone.goalModel] ?? 'priority';
  const wig = kind === 'wig';
  const form = (work.forms.goal[key] ??= {
    title: '',
    ownerRole: 'self',
    doneMeans: '',
    from: '',
    to: '',
    unit: '',
    by: '',
  });
  return ask(
    38,
    table(
      [template.vocabulary.goal, 'Owner', 'Done means', ''],
      tailoring.goals.map((goal, index) =>
        h(
          'tr',
          { test: `goal-${key}-${String(index)}` },
          h(
            'td',
            null,
            goal.target === undefined
              ? goal.title
              : `${goal.title} (from ${String(goal.target.from)} to ${String(goal.target.to)} ${goal.target.unit} by ${goal.target.by ?? 'a date to confirm'})`,
          ),
          h('td', null, goal.ownerRole),
          h('td', null, goal.doneMeans ?? ''),
          h(
            'td',
            null,
            button('Remove', () => {
              tailoring.goals = tailoring.goals.filter((_, i) => i !== index);
              ui.render();
            }),
          ),
        ),
      ),
      `No ${template.vocabulary.goal.toLowerCase()} yet; drafts are fine.`,
    ),
    h(
      'div',
      { class: 'form', test: `add-goal-${key}` },
      field(template.vocabulary.goal, form.title, (v) => (form.title = v), {
        test: `goal-title-${key}`,
      }),
      field('Owner (role)', form.ownerRole, (v) => (form.ownerRole = v)),
      field('Done means', form.doneMeans, (v) => (form.doneMeans = v), {
        test: `goal-done-${key}`,
      }),
      wig ? field('From', form.from, (v) => (form.from = v), { type: 'number' }) : null,
      wig ? field('To', form.to, (v) => (form.to = v), { type: 'number' }) : null,
      wig ? field('Unit', form.unit, (v) => (form.unit = v)) : null,
      wig ? field('By (empty: to confirm)', form.by, (v) => (form.by = v), { type: 'date' }) : null,
      button(
        `Add ${template.vocabulary.goal.toLowerCase()}`,
        () => {
          if (form.title.trim() === '') {
            ui.flash('Give it a title.', 'error');
            return;
          }
          tailoring.goals = [
            ...tailoring.goals,
            {
              title: form.title.trim(),
              kind,
              ownerRole: form.ownerRole.trim() || 'self',
              ...(form.doneMeans.trim() === '' ? {} : { doneMeans: form.doneMeans.trim() }),
              ...(wig && form.unit.trim() !== ''
                ? {
                    target: {
                      from: numberOf(form.from, 0),
                      to: numberOf(form.to, 0),
                      unit: form.unit.trim(),
                      by: form.by === '' ? null : form.by,
                    },
                  }
                : {}),
            },
          ];
          work.forms.goal[key] = {
            title: '',
            ownerRole: 'self',
            doneMeans: '',
            from: '',
            to: '',
            unit: '',
            by: '',
          };
          ui.render();
        },
        { test: `goal-add-${key}` },
      ),
    ),
  );
}

/** S5 `tailoring` (rows 35 to 46), per workstream with its own framework instance. */
export function tailoringStep(state: WizardState, ui: Ui): VNode {
  const result = state.recommend;
  if (result === undefined) {
    return h(
      'p',
      { class: 'failure', test: 'step-tailoring' },
      state.problem ?? 'Answer S4 first.',
    );
  }
  const work = state.work;
  return h(
    'div',
    { test: 'step-tailoring' },
    result.recommendations.filter(ownInstance).map((rec) => {
      const template = chosenTemplate(work, rec, result.templates);
      if (template === undefined) return null;
      const tailoring = tailoringOf(work, rec);
      const key = rec.workstreamKey;
      const name = work.profile.workstreams.find((w) => w.key === key)?.name ?? key;
      const defaults = template.id === rec.templateId ? rec.parameterDefaults : {};
      const decisionKeys = ['decision.method', 'decision.memoForOneWayDoors'];
      const jobSearch = rec.packIds.some((pack) => pack.startsWith('pack.job-search'));
      const spec = (k: string) => template.parameters.find((p) => p.key === k);
      return section(
        `${name}: ${template.name}`,
        h(
          'div',
          { class: 'form', test: `tailoring-${key}` },
          ask(
            35,
            template.parameters
              .filter((p) => !decisionKeys.includes(p.key))
              .map((p) => parameterControl(ui, p, tailoring, defaults, `param-${key}-${p.key}`)),
          ),
          ask(
            36,
            rec.mergeGroup === undefined
              ? h('p', { class: 'muted' }, 'This workstream has no merge group.')
              : checkbox(
                  `Merge into one ${rec.mergeGroup.replace(/-/g, ' ')}`,
                  tailoring.merge !== false,
                  (checked) => (tailoring.merge = checked),
                  `merge-${key}`,
                ),
          ),
          measuresQuestion(ui, work, rec, tailoring, result),
          goalsQuestion(ui, work, rec, template, tailoring),
          ask(
            39,
            spec('decision.method') === undefined
              ? h('p', { class: 'muted' }, `${template.id} does not ask this.`)
              : parameterControl(
                  ui,
                  spec('decision.method') as ParameterSpec,
                  tailoring,
                  defaults,
                  `param-${key}-decision.method`,
                ),
          ),
          ask(
            40,
            spec('decision.memoForOneWayDoors') === undefined
              ? h('p', { class: 'muted' }, `${template.id} does not ask this.`)
              : parameterControl(
                  ui,
                  spec('decision.memoForOneWayDoors') as ParameterSpec,
                  tailoring,
                  defaults,
                  `param-${key}-decision.memo`,
                ),
          ),
          ask(
            41,
            field(
              'Area = role, one per line ("* = self": you own everything)',
              Object.entries(tailoring.owners)
                .map(([area, role]) => `${area} = ${role}`)
                .join('\n'),
              (value) => {
                const owners: Record<string, string> = {};
                for (const line of value.split('\n')) {
                  const [area, role] = line.split('=').map((part) => part.trim());
                  if (area && role) owners[area] = role;
                }
                tailoring.owners = Object.keys(owners).length === 0 ? { '*': 'self' } : owners;
              },
              { multiline: true, test: `owners-${key}` },
            ),
          ),
          ask(
            42,
            select(
              'Review',
              tailoring.verification.policy,
              [
                { value: 'require_review', label: 'I review every claim' },
                { value: 'auto_close_on_checks', label: 'Close on passing checks' },
              ],
              (v) =>
                (tailoring.verification = {
                  ...tailoring.verification,
                  policy: v as 'require_review' | 'auto_close_on_checks',
                }),
              `review-${key}`,
            ),
            (['calendar_event', 'measure_threshold'] as const).map((check) =>
              checkbox(
                `Auto-close on ${check.replace('_', ' ')}`,
                tailoring.verification.autoCloseOn.includes(check),
                (checked) => {
                  const set = new Set(tailoring.verification.autoCloseOn);
                  if (checked) set.add(check);
                  else set.delete(check);
                  tailoring.verification = { ...tailoring.verification, autoCloseOn: [...set] };
                },
                `autoclose-${key}-${check}`,
              ),
            ),
          ),
          ask(
            43,
            field(
              'E2 after this many carries (1 to 3)',
              String(tailoring.escalation.e2CarryCount),
              (v) => (tailoring.escalation.e2CarryCount = Math.round(numberOf(v, 2))),
              { type: 'number', test: `e2-${key}` },
            ),
            field(
              'E3 after this many carries (3 to 6)',
              String(tailoring.escalation.e3CarryCount),
              (v) => (tailoring.escalation.e3CarryCount = Math.round(numberOf(v, 4))),
              { type: 'number', test: `e3-${key}` },
            ),
            field(
              'or overdue this many days (14 to 60)',
              String(tailoring.escalation.e3OverdueDays),
              (v) => (tailoring.escalation.e3OverdueDays = Math.round(numberOf(v, 30))),
              { type: 'number', test: `e3-days-${key}` },
            ),
          ),
          ask(
            44,
            select(
              'AI may see',
              tailoring.aiDataPolicy,
              [
                { value: 'allow', label: 'Everything' },
                { value: 'redact_people', label: 'Everything, with people’s names hidden' },
                { value: 'deny', label: 'Nothing' },
              ],
              (v) => (tailoring.aiDataPolicy = v as TailoringAnswers['aiDataPolicy']),
              `ai-policy-${key}`,
            ),
          ),
          ask(
            45,
            jobSearch
              ? (['profile', 'rubric', 'writing_style', 'master_resume'] as const).map((kind) =>
                  field(
                    `${kind.replace('_', ' ')} file (empty: to be written)`,
                    tailoring.groundingRefs?.find((r) => r.kind === kind)?.path ?? '',
                    (value) => {
                      const others = (tailoring.groundingRefs ?? []).filter((r) => r.kind !== kind);
                      tailoring.groundingRefs = [
                        ...others,
                        { kind, path: value.trim() === '' ? null : value.trim() },
                      ];
                    },
                    { test: `grounding-${key}-${kind}` },
                  ),
                )
              : h('p', { class: 'muted' }, 'Asked for a job search only.'),
          ),
          ask(
            46,
            field(
              'Roles told when items close, comma separated',
              tailoring.informRoles.join(', '),
              (v) => {
                tailoring.informRoles = v
                  .split(',')
                  .map((r) => r.trim())
                  .filter((r) => r !== '');
              },
              { test: `inform-${key}` },
            ),
          ),
        ),
      );
    }),
  );
}
