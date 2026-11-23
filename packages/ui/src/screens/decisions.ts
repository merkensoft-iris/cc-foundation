/**
 * Decisions (09 P1-11; 03 §5.5, §10): the register, a decision's detail, opening a proposed one
 * onto the agenda with its decider, and deciding an open one. Opening and deciding are
 * human-only (04 §4.3, INV-03-02) and so happen only here.
 */
import type { Decision, DecisionRow } from '../app/api.js';
import type { AppRoute } from '../app/routes.js';
import { act, type Screen, type Ui } from '../app/screen.js';
import { button, chip, field, link, page, section, select, table } from '../ui/parts.js';
import { h, type VNode } from '../ui/vnode.js';

export interface DecisionsState {
  rows: readonly DecisionRow[];
  detail?: Decision;
  /** The people who may be the decider (INV-03-02), for the picker. */
  deciders: readonly Person[];
  readonly form: {
    optionId: string;
    text: string;
    why: string;
    waiverNote: string;
    /** The decider picked when opening; empty keeps the proposed one. */
    deciderId: string;
  };
}

interface Person {
  readonly id: string;
  readonly name: string;
}

const OPEN: ReadonlySet<string> = new Set(['proposed', 'advising', 'open']);

function statusChip(status: string): VNode {
  return chip(status, status === 'decided' ? 'good' : OPEN.has(status) ? 'warn' : 'neutral');
}

/** 03 §10 rule 2: the user accepts a proposed decision onto the agenda and sets its decider. */
function openForm(state: DecisionsState, decision: Decision, ui: Ui): VNode {
  const form = state.form;
  const deciderId = form.deciderId === '' ? decision.deciderId : form.deciderId;
  const people = state.deciders.some((person) => person.id === decision.deciderId)
    ? state.deciders
    : [{ id: decision.deciderId, name: decision.deciderId }, ...state.deciders];
  return h(
    'div',
    { class: 'form', test: 'open-form' },
    select(
      'Decider',
      deciderId,
      people.map((person) => ({ value: person.id, label: person.name })),
      (value) => (form.deciderId = value),
      'open-decider',
    ),
    button(
      'Open',
      () => {
        const picked = form.deciderId === '' ? decision.deciderId : form.deciderId;
        void act(
          ui,
          () =>
            ui.call('decisions.open', {
              ref: decision.ref,
              ...(picked === decision.deciderId ? {} : { decider: picked }),
            }),
          `${decision.ref} opened.`,
        );
      },
      { test: 'open-decision', primary: true },
    ),
  );
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
      h('dt', null, 'Decider'),
      h(
        'dd',
        { test: 'decider' },
        state.deciders.find((person) => person.id === decision.deciderId)?.name ??
          decision.deciderId,
      ),
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
    decision.status === 'proposed' ? section('Open', openForm(state, decision, ui)) : null,
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
      deciderId: '',
    }));
    if (route.screen === 'decisions' && route.ref !== undefined) {
      const { decision, deciders } = await ui.call('decisions.get', { ref: route.ref });
      return { rows: [], detail: decision, deciders: deciders ?? [], form };
    }
    const list = await ui.call('decisions.list', { limit: 200 });
    return { rows: list.decisions, deciders: [], form };
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
