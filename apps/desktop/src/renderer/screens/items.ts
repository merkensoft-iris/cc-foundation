/**
 * Items (09 P1-11; 03 §7, §9): the list, an item's detail with its history, the review queue
 * and the drafts.
 *
 * The review queue confirms, attests or rejects claims (03 §9.2 step 4). **Confirm** is enabled
 * only when every required requirement has checkable evidence; otherwise it is disabled with
 * the reason shown, and **Attest** is offered instead (owner decision Q5, AC-03-09). Attested
 * items are done, counted apart from verified ones (03 §9.3). Accepting drafts and dropping
 * items are here too. All of these are human-only (04 §4.3): the app is the only place they
 * happen.
 */
import type {
  DomainEvent,
  Evidence,
  HistoryResult,
  ItemReview,
  ItemsListResult,
  ItemSummary,
} from '../app/api.js';
import type { AppRoute, ItemsTab } from '../app/routes.js';
import { act, type Screen, type Ui } from '../app/screen.js';
import {
  button,
  chip,
  field,
  healthChip,
  link,
  page,
  section,
  select,
  stateChip,
  table,
  tabs,
} from '../ui/parts.js';
import { h, type VNode } from '../ui/vnode.js';

export interface ItemsState {
  tab: ItemsTab;
  filter: 'active' | 'all';
  list?: ItemsListResult;
  queue?: ItemReview[];
  drafts?: readonly ItemSummary[];
  detail?: { review: ItemReview; history: readonly DomainEvent[] };
  /** Typed notes and reasons, by `<action>:<ref>`. */
  readonly text: Record<string, string>;
}

const TABS = [
  { id: 'list', label: 'All items' },
  { id: 'review', label: 'Review queue' },
  { id: 'drafts', label: 'Drafts' },
] as const;

function evidenceList(evidence: readonly Evidence[]): VNode {
  if (evidence.length === 0) return h('p', { class: 'empty' }, 'No evidence attached.');
  return h(
    'ul',
    { class: 'evidence', test: 'evidence' },
    evidence.map((record) =>
      h(
        'li',
        null,
        chip(record.kind.replace('_', ' '), record.kind === 'note' ? 'warn' : 'neutral'),
        ' ',
        record.summary,
        record.requirementId === undefined
          ? null
          : h('span', { class: 'muted' }, ` (${record.requirementId})`),
      ),
    ),
  );
}

/** The review actions for a claimed item: Confirm, Attest with a note, Reject with a reason. */
export function reviewCard(state: ItemsState, review: ItemReview, ui: Ui): VNode {
  const { item, evidence } = review;
  const options = review.review;
  const ref = item.ref;
  const note = state.text[`attest:${ref}`] ?? '';
  const reason = state.text[`reject:${ref}`] ?? '';
  return h(
    'article',
    { class: 'card review', test: `review-${ref}` },
    h('h3', null, `${ref} ${item.title}`),
    h('p', null, h('strong', null, 'Done means: '), item.doneMeans),
    item.claim?.note === undefined
      ? null
      : h('p', null, h('strong', null, 'Claim note: '), item.claim.note),
    evidenceList(evidence),
    h(
      'div',
      { class: 'actions' },
      button(
        'Confirm',
        () =>
          void act(ui, () => ui.call('items.confirm', { ref }), `${ref} confirmed: verified done.`),
        {
          test: 'confirm',
          primary: true,
          disabled: !options.confirm.enabled,
          ...(options.confirm.reason === undefined ? {} : { title: options.confirm.reason }),
        },
      ),
    ),
    options.confirm.enabled || options.confirm.reason === undefined
      ? null
      : h('p', { class: 'reason', test: 'confirm-reason', role: 'note' }, options.confirm.reason),
    h(
      'div',
      { class: 'actions' },
      field('Attestation note', note, (value) => (state.text[`attest:${ref}`] = value), {
        test: 'attest-note',
        placeholder: 'How you know it was done',
      }),
      button(
        'Attest',
        () => {
          const text = (state.text[`attest:${ref}`] ?? '').trim();
          if (text === '') {
            ui.flash('An attestation needs a note: say how you know it was done.', 'error');
            return;
          }
          void act(
            ui,
            () => ui.call('items.attest', { ref, note: text }),
            `${ref} attested: done, counted apart from verified items.`,
          );
        },
        { test: 'attest', disabled: !options.attest.enabled },
      ),
    ),
    h(
      'div',
      { class: 'actions' },
      field('Rejection reason', reason, (value) => (state.text[`reject:${ref}`] = value), {
        test: 'reject-reason',
      }),
      button(
        'Reject',
        () => {
          const text = (state.text[`reject:${ref}`] ?? '').trim();
          if (text === '') {
            ui.flash('Rejecting a claim needs a reason.', 'error');
            return;
          }
          void act(
            ui,
            () => ui.call('items.reject', { ref, reason: text }),
            `${ref} rejected: back in progress, at risk.`,
          );
        },
        { test: 'reject', disabled: !options.reject.enabled },
      ),
    ),
    h(
      'p',
      { class: 'muted' },
      'Attested items count as done and are reported apart from verified ones.',
    ),
  );
}

/** Accept (with an optional note, for an absent owner) and Drop (with a reason). */
function draftActions(state: ItemsState, ref: string, ui: Ui): VNode {
  const note = state.text[`accept:${ref}`] ?? '';
  return h(
    'div',
    { class: 'actions', test: `draft-${ref}` },
    field(
      'Note (accepting for an absent owner)',
      note,
      (value) => (state.text[`accept:${ref}`] = value),
      {
        test: 'accept-note',
      },
    ),
    button(
      'Accept',
      () => {
        const text = (state.text[`accept:${ref}`] ?? '').trim();
        void act(
          ui,
          () => ui.call('items.accept', text === '' ? { ref } : { ref, note: text }),
          `${ref} accepted: now open.`,
        );
      },
      { test: 'accept', primary: true },
    ),
    dropAction(state, ref, ui),
  );
}

function dropAction(state: ItemsState, ref: string, ui: Ui): VNode {
  return h(
    'span',
    { class: 'inline' },
    field(
      'Drop reason',
      state.text[`drop:${ref}`] ?? '',
      (value) => (state.text[`drop:${ref}`] = value),
      {
        test: 'drop-reason',
      },
    ),
    button(
      'Drop',
      () => {
        const reason = (state.text[`drop:${ref}`] ?? '').trim();
        if (reason === '') {
          ui.flash('Dropping an item needs a reason.', 'error');
          return;
        }
        void act(ui, () => ui.call('items.drop', { ref, reason }), `${ref} dropped.`);
      },
      { test: 'drop' },
    ),
  );
}

function itemRows(items: readonly ItemSummary[], ui: Ui): VNode[] {
  return items.map((item) =>
    h(
      'tr',
      { test: `item-${item.ref}` },
      h(
        'td',
        null,
        link(item.ref, () => ui.go({ screen: 'items', ref: item.ref })),
      ),
      h('td', null, item.title),
      h('td', null, item.workstream ?? ''),
      h('td', null, item.owner ?? ''),
      h('td', null, item.due),
      h('td', null, stateChip(item.state), ' ', healthChip(item.health)),
    ),
  );
}

function historyList(events: readonly DomainEvent[]): VNode {
  return h(
    'ol',
    { class: 'history', test: 'history' },
    events.map((event) =>
      h(
        'li',
        null,
        h('span', { class: 'time' }, event.at.slice(0, 16).replace('T', ' ')),
        ' ',
        event.type,
        ' by ',
        event.actor.kind === 'agent'
          ? `agent ${String(event.actor.principalId)}`
          : event.actor.kind,
      ),
    ),
  );
}

function detailView(state: ItemsState, ui: Ui): VNode {
  const detail = state.detail;
  if (detail === undefined) return h('p', null, 'No item.');
  const { item } = detail.review;
  const closed = item.lifecycle === 'verified_done' || item.lifecycle === 'dropped';
  return page(
    `${item.ref} ${item.title}`,
    h(
      'p',
      null,
      link('All items', () => ui.go({ screen: 'items', tab: 'list' })),
    ),
    h(
      'dl',
      { class: 'facts', test: 'item-facts' },
      h('dt', null, 'State'),
      h('dd', null, stateChip(item.lifecycle), ' ', healthChip(item.health)),
      h('dt', null, 'Due'),
      h(
        'dd',
        null,
        `${item.due.date}${item.due.time === undefined ? '' : ` ${item.due.time}`} (${item.due.timeZone})`,
      ),
      h('dt', null, 'Done means'),
      h('dd', null, item.doneMeans),
      item.healthNote === undefined
        ? null
        : [h('dt', null, 'Health note'), h('dd', null, item.healthNote)],
      h('dt', null, 'Carried'),
      h(
        'dd',
        null,
        `${String(item.carryCount)} times, escalation level ${String(item.escalationLevel)}`,
      ),
      item.verification?.method === undefined
        ? null
        : [h('dt', null, 'Closed as'), h('dd', null, item.verification.method)],
    ),
    section(
      'Evidence requirements',
      h(
        'ul',
        null,
        item.evidenceRequirements.map((requirement) =>
          h(
            'li',
            null,
            `${requirement.id}: ${requirement.description}`,
            requirement.required ? '' : ' (optional)',
          ),
        ),
      ),
    ),
    item.lifecycle === 'claimed_done'
      ? section('Review', reviewCard(state, detail.review, ui))
      : section('Evidence', evidenceList(detail.review.evidence)),
    item.lifecycle === 'draft'
      ? section('Draft', draftActions(state, item.ref, ui))
      : closed
        ? null
        : section('Drop', dropAction(state, item.ref, ui)),
    section('History', historyList(detail.history)),
  );
}

async function loadTab(ui: Ui, state: ItemsState): Promise<void> {
  if (state.tab === 'list') {
    state.list = await ui.call<ItemsListResult>('items.list', {
      ...(state.filter === 'active' ? { state: 'active' } : {}),
      fields: ['owner', 'health', 'workstream'],
      limit: 200,
    });
  } else if (state.tab === 'review') {
    const claimed = await ui.call<ItemsListResult>('items.list', {
      state: 'claimed_done',
      limit: 200,
    });
    state.queue = await Promise.all(
      claimed.items.map((item) => ui.call<ItemReview>('items.review', { ref: item.ref })),
    );
  } else {
    const drafts = await ui.call<ItemsListResult>('items.list', {
      state: 'draft',
      fields: ['owner', 'workstream'],
      limit: 200,
    });
    state.drafts = drafts.items;
  }
}

export const itemsScreen: Screen<ItemsState> = {
  async load(ui, route: AppRoute) {
    if (route.screen !== 'items') throw new Error('not the items screen');
    // Typed notes and the chosen filter survive the reload after an action.
    const kept = ui.keep('items', () => ({
      text: {} as Record<string, string>,
      filter: 'active' as 'active' | 'all',
    }));
    const state: ItemsState = { tab: route.tab ?? 'list', filter: kept.filter, text: kept.text };
    if (route.ref !== undefined) {
      const [review, history] = await Promise.all([
        ui.call<ItemReview>('items.review', { ref: route.ref }),
        ui.call<HistoryResult>('items.history', { ref: route.ref, limit: 200 }),
      ]);
      state.detail = { review, history: history.events };
      return state;
    }
    await loadTab(ui, state);
    return state;
  },
  view(state, ui, route) {
    if (route.screen === 'items' && route.ref !== undefined) return detailView(state, ui);
    const header = tabs(state.tab, TABS, (tab) => ui.go({ screen: 'items', tab }));
    if (state.tab === 'review') {
      const queue = state.queue ?? [];
      return page(
        'Items',
        header,
        h(
          'p',
          { class: 'muted' },
          `${String(queue.length)} claim${queue.length === 1 ? '' : 's'} awaiting review.`,
        ),
        queue.length === 0
          ? h('p', { class: 'empty' }, 'Nothing is waiting for review.')
          : queue.map((review) => reviewCard(state, review, ui)),
      );
    }
    if (state.tab === 'drafts') {
      const drafts = state.drafts ?? [];
      return page(
        'Items',
        header,
        drafts.length === 0
          ? h('p', { class: 'empty' }, 'No drafts are waiting.')
          : drafts.map((item) =>
              h(
                'article',
                { class: 'card', test: `draft-card-${item.ref}` },
                h(
                  'h3',
                  null,
                  link(`${item.ref} ${item.title}`, () =>
                    ui.go({ screen: 'items', ref: item.ref }),
                  ),
                ),
                h(
                  'p',
                  { class: 'muted' },
                  `Due ${item.due}${item.owner === undefined ? '' : ` · ${item.owner}`}`,
                ),
                draftActions(state, item.ref, ui),
              ),
            ),
      );
    }
    const list = state.list ?? { items: [], total: 0 };
    return page(
      'Items',
      header,
      select(
        'Show',
        state.filter,
        [
          { value: 'active', label: 'Active items' },
          { value: 'all', label: 'All items, closed too' },
        ],
        (value) => {
          ui.keep('items', () => ({ text: state.text, filter: state.filter })).filter =
            value === 'all' ? 'all' : 'active';
          void ui.reload();
        },
        'items-filter',
      ),
      table(
        ['Item', 'Title', 'Workstream', 'Owner', 'Due', 'State'],
        itemRows(list.items, ui),
        'No items.',
      ),
      list.total > list.items.length
        ? h(
            'p',
            { class: 'muted' },
            `Showing ${String(list.items.length)} of ${String(list.total)}.`,
          )
        : null,
    );
  },
};
