/**
 * Issues and risks (09 P1-11; 03 §5.6, §11). Workspace-level risks, such as a risk to the
 * backups or to the machine, belong to no single workstream: they are recorded on the
 * Workspace pseudo-workstream, which this screen lists first (owner decision Q4, AC-03-11).
 */
import type { IssueRow, RiskRow, WorkstreamRow } from '../app/api.js';
import { act, type Screen, type Ui } from '../app/screen.js';
import { button, chip, field, page, section, select, table } from '../ui/parts.js';
import { h, type VNode } from '../ui/vnode.js';

export interface IssuesState {
  issues: readonly IssueRow[];
  risks: readonly RiskRow[];
  workstreams: readonly WorkstreamRow[];
  readonly risk: { workstream: string; description: string; trigger: string };
  readonly issue: { workstream: string; title: string };
}

/** The Workspace pseudo-workstream first, then the others by name. */
export function riskGroups(
  risks: readonly RiskRow[],
  workstreams: readonly WorkstreamRow[],
): { slug: string; label: string; risks: RiskRow[] }[] {
  const ordered = [...workstreams].sort(
    (a, b) =>
      Number(b.kind === 'workspace') - Number(a.kind === 'workspace') ||
      a.name.localeCompare(b.name),
  );
  return ordered
    .map((workstream) => ({
      slug: workstream.slug,
      label:
        workstream.kind === 'workspace'
          ? `${workstream.name} (workspace-level risks)`
          : workstream.name,
      risks: risks.filter((risk) => risk.workstream === workstream.slug),
    }))
    .filter((group) => group.risks.length > 0 || group.slug === 'workspace');
}

function riskForm(state: IssuesState, ui: Ui): VNode {
  const form = state.risk;
  return h(
    'div',
    { class: 'form', test: 'risk-form' },
    select(
      'Workstream',
      form.workstream,
      state.workstreams.map((w) => ({
        value: w.slug,
        label: w.kind === 'workspace' ? `${w.name} (the whole workspace)` : w.name,
      })),
      (value) => (form.workstream = value),
      'risk-workstream',
    ),
    field('Risk', form.description, (value) => (form.description = value), {
      test: 'risk-description',
      placeholder: 'What may happen',
    }),
    field('Trigger', form.trigger, (value) => (form.trigger = value), {
      test: 'risk-trigger',
      placeholder: 'What tells you it has happened',
    }),
    button(
      'Record risk',
      () => {
        if (form.description.trim() === '' || form.trigger.trim() === '') {
          ui.flash('A risk needs what may happen and its trigger.', 'error');
          return;
        }
        const params = {
          workstream: form.workstream,
          description: form.description.trim(),
          trigger: form.trigger.trim(),
        };
        void act(ui, () => ui.call('risks.record', params), 'Risk recorded.').then((ok) => {
          if (!ok) return;
          form.description = '';
          form.trigger = '';
          ui.render();
        });
      },
      { test: 'record-risk', primary: true },
    ),
  );
}

function issueForm(state: IssuesState, ui: Ui): VNode {
  const form = state.issue;
  const choices = state.workstreams.map((w) => ({ value: w.slug, label: w.name }));
  return h(
    'div',
    { class: 'form', test: 'issue-form' },
    select(
      'Workstream',
      form.workstream,
      choices,
      (value) => (form.workstream = value),
      'issue-workstream',
    ),
    field('Issue', form.title, (value) => (form.title = value), { test: 'issue-title' }),
    button(
      'Raise issue',
      () => {
        if (form.title.trim() === '') {
          ui.flash('An issue needs a title.', 'error');
          return;
        }
        const params = { workstream: form.workstream, title: form.title.trim() };
        void act(ui, () => ui.call('issues.raise', params), 'Issue raised.').then((ok) => {
          if (!ok) return;
          form.title = '';
          ui.render();
        });
      },
      { test: 'raise-issue' },
    ),
  );
}

export const issuesScreen: Screen<IssuesState> = {
  async load(ui) {
    const [issues, risks, workstreams] = await Promise.all([
      ui.call<{ issues: IssueRow[] }>('issues.list', { status: 'open', limit: 200 }),
      ui.call<{ risks: RiskRow[] }>('risks.list', { limit: 200 }),
      ui.call<{ workstreams: WorkstreamRow[] }>('workstreams.list', { limit: 200 }),
    ]);
    const active = workstreams.workstreams.filter((w) => w.status !== 'archived');
    const workspace = active.find((w) => w.kind === 'workspace')?.slug ?? active[0]?.slug ?? '';
    const firstOther = active.find((w) => w.kind !== 'workspace')?.slug ?? workspace;
    return {
      issues: issues.issues,
      risks: risks.risks,
      workstreams: active,
      risk: ui.keep('risk-form', () => ({ workstream: workspace, description: '', trigger: '' })),
      issue: ui.keep('issue-form', () => ({ workstream: firstOther, title: '' })),
    };
  },
  view(state, ui) {
    return page(
      'Issues and risks',
      section(
        'Open issues',
        table(
          ['Issue', 'Title', 'Rank'],
          state.issues.map((issue) =>
            h(
              'tr',
              { test: `issue-${issue.ref}` },
              h('td', null, issue.ref),
              h('td', null, issue.title),
              h('td', null, issue.rank === undefined ? '' : String(issue.rank)),
            ),
          ),
          'No open issues.',
        ),
        issueForm(state, ui),
      ),
      section(
        'Risks',
        riskGroups(state.risks, state.workstreams).map((group) =>
          h(
            'div',
            { class: 'group', test: `risks-${group.slug}` },
            h('h3', null, group.label),
            table(
              ['Risk', 'Description', 'Trigger', 'Status'],
              group.risks.map((risk) =>
                h(
                  'tr',
                  { test: `risk-${risk.ref}` },
                  h('td', null, risk.ref),
                  h('td', null, risk.description),
                  h('td', null, risk.trigger),
                  h('td', null, chip(risk.status, risk.status === 'triggered' ? 'bad' : 'neutral')),
                ),
              ),
              'No risks recorded.',
            ),
          ),
        ),
        riskForm(state, ui),
      ),
    );
  },
};
