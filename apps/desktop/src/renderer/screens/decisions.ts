/**
 * Decisions (09 P1-11; 03 §5.5, §10): the register, a decision's detail, and deciding an open
 * one, which is human-only (04 §4.3, INV-03-02) and so happens only here.
 */
import type { Decision, DecisionRow } from '../app/api.js';
import type { AppRoute } from '../app/routes.js';
import { act, type Screen, type Ui } from '../app/screen.js';
import { button, chip, field, link, page, section, select, table } from '../ui/parts.js';
import { h, type VNode } from '../ui/vnode.js';

export interface DecisionsState {
  rows: readonly DecisionRow[];
  detail?: Decision;
  readonly form: { optionId: string; text: string; why: string; waiverNote: string };
}

const OPEN: ReadonlySet<string> = new Set(['proposed', 'advising', 'open']);

function statusChip(status: string): VNode {
  return chip(status, status === 'decided' ? 'good' : OPEN.has(status) ? 'warn' : 'neutral');
}

function decideForm(state: DecisionsState, decision: Decision, ui: Ui): VNode {
  const form = state.form;
  return h(
    'div',
    { class: 'form', test: 'decide-form' },
    decision.options.length === 0
      ? null
      : select(
          'Option',
          form.optionId,
          [
            { value: '', label: 'None of the options' },
            ...decision.options.map((option) => ({ value: option.id, label: option.text })),
          ],
          (value) => (form.optionId = value),
          'decide-option',
        ),
    field('Outcome', form.text, (value) => (form.text = value), { test: 'decide-text' }),
    field('Why', form.why, (value) => (form.why = value), { test: 'decide-why', multiline: true }),
    decision.reversibility === 'one_way'
      ? field(
          'Memo waiver note (one-way door)',
          form.waiverNote,
          (value) => (form.waiverNote = value),
          {
            test: 'decide-waiver',
          },
        )
      : null,
    button(
      'Decide',
      () => {
        if (form.text.trim() === '' || form.why.trim() === '') {
          ui.flash('A decision needs its outcome and why.', 'error');
          return;
        }
        void act(
          ui,
          () =>
            ui.call('decisions.decide', {
              ref: decision.ref,
              text: form.text.trim(),
              why: form.why.trim(),
              ...(form.optionId === '' ? {} : { optionId: form.optionId }),
              ...(form.waiverNote.trim() === '' ? {} : { waiverNote: form.waiverNote.trim() }),
            }),
          `${decision.ref} decided.`,
        );
      },
      { test: 'decide', primary: true },
    ),
  );
}

function detailView(state: DecisionsState, decision: Decision, ui: Ui): VNode {
  return page(
    `${decision.ref} ${decision.question}`,
    h(
      'p',
      null,
      link('All decisions', () => ui.go({ screen: 'decisions' })),
    ),
    h(
      'dl',
      { class: 'facts' },
      h('dt', null, 'Status'),
      h('dd', null, statusChip(decision.status)),
      h('dt', null, 'Reversibility'),
      h('dd', null, decision.reversibility === 'one_way' ? 'One-way door' : 'Two-way door'),
      decision.dueBy === undefined
        ? null
        : [h('dt', null, 'Due by'), h('dd', null, decision.dueBy)],
    ),
    section(
      'Options',
      decision.options.length === 0
        ? h('p', { class: 'empty' }, 'No options recorded.')
        : h(
            'ol',
            null,
            decision.options.map((option) => h('li', null, option.text)),
          ),
    ),
    decision.outcome === undefined
      ? null
      : section(
          'Outcome',
          h('p', { test: 'outcome' }, decision.outcome.text),
          h('p', { class: 'muted' }, `Why: ${decision.outcome.why}`),
        ),
    decision.status === 'open' ? section('Decide', decideForm(state, decision, ui)) : null,
  );
}

export const decisionsScreen: Screen<DecisionsState> = {
  async load(ui, route: AppRoute) {
    const ref = route.screen === 'decisions' ? route.ref : undefined;
    const form = ui.keep(`decide:${ref ?? ''}`, () => ({
      optionId: '',
      text: '',
      why: '',
      waiverNote: '',
    }));
    if (route.screen === 'decisions' && route.ref !== undefined) {
      const { decision } = await ui.call<{ decision: Decision }>('decisions.get', {
        ref: route.ref,
      });
      return { rows: [], detail: decision, form };
    }
    const list = await ui.call<{ decisions: DecisionRow[] }>('decisions.list', { limit: 200 });
    return { rows: list.decisions, form };
  },
  view(state, ui) {
    if (state.detail !== undefined) return detailView(state, state.detail, ui);
    return page(
      'Decisions',
      table(
        ['Decision', 'Question', 'Due by', 'Status'],
        state.rows.map((row) =>
          h(
            'tr',
            { test: `decision-${row.ref}` },
            h(
              'td',
              null,
              link(row.ref, () => ui.go({ screen: 'decisions', ref: row.ref })),
            ),
            h('td', null, row.question),
            h('td', null, row.dueBy ?? ''),
            h('td', null, statusChip(row.status)),
          ),
        ),
        'No decisions yet.',
      ),
    );
  },
};
