/**
 * Home (07 §4.3, 09 P1-11): today's meetings, what needs the user, and the most urgent items.
 *
 * A `commandcenter://confirmations/<id>` link opens here, with its inline prompt (owner
 * decision Q3, 10 Nov 2026): phase 1 has no Confirmations screen, and until the confirmations
 * of P1-13 and P2-01 exist the prompt says where a pending confirmation is decided.
 */
import type { HomeResult } from '../app/api.js';
import type { AppRoute } from '../app/routes.js';
import type { Screen, Ui } from '../app/screen.js';
import { chip, link, page, section, stateChip, table } from '../ui/parts.js';
import { h, type VNode } from '../ui/vnode.js';

export interface HomeState {
  readonly home: HomeResult;
}

function attention(home: HomeResult, ui: Ui): VNode {
  const a = home.attention;
  const entries: { label: string; count: number; open?: () => void; test: string }[] = [
    {
      label: 'Overdue',
      count: a.overdue,
      test: 'attention-overdue',
      open: () => ui.go({ screen: 'items', tab: 'list' }),
    },
    {
      label: 'At risk or off track',
      count: a.atRisk,
      test: 'attention-at-risk',
      open: () => ui.go({ screen: 'items', tab: 'list' }),
    },
    {
      label: 'Awaiting review',
      count: a.awaitingReview,
      test: 'attention-review',
      open: () => ui.go({ screen: 'items', tab: 'review' }),
    },
    { label: 'Confirmations pending', count: a.confirmationsPending, test: 'attention-confirm' },
    {
      label: 'Browser sessions needing you',
      count: a.sessionsNeedingYou,
      test: 'attention-sessions',
    },
  ];
  return h(
    'ul',
    { class: 'attention' },
    entries.map((entry) =>
      h(
        'li',
        { test: entry.test, class: entry.count > 0 ? 'due' : 'clear' },
        h('strong', null, String(entry.count)),
        ' ',
        entry.open === undefined || entry.count === 0 ? entry.label : link(entry.label, entry.open),
      ),
    ),
  );
}

/** The inline prompt a confirmation or request link opens (owner decision Q3). */
function prompt(route: AppRoute): VNode | null {
  if (route.screen !== 'home') return null;
  if (route.confirmation !== undefined) {
    return h(
      'div',
      { class: 'prompt', role: 'alert', test: 'confirmation-prompt' },
      h('strong', null, `Confirmation ${route.confirmation}`),
      h(
        'p',
        null,
        'Confirmations are decided inline, on the item, meeting or onboarding step that raised them. ',
        'This one is not waiting here. The Confirmations screen arrives in phase 2.',
      ),
    );
  }
  if (route.request !== undefined) {
    return h(
      'div',
      { class: 'prompt', role: 'alert', test: 'request-prompt' },
      h('strong', null, `Development request ${route.request}`),
      h(
        'p',
        null,
        'Development requests are reviewed on their own screen, which arrives in phase 6.',
      ),
    );
  }
  return null;
}

export const homeScreen: Screen<HomeState> = {
  async load(ui) {
    return { home: await ui.call<HomeResult>('home.get', {}) };
  },
  view({ home }, ui, route) {
    return page(
      'Home',
      prompt(route),
      h(
        'p',
        { class: 'muted' },
        `Workspace ${home.workspace} · ${home.now.slice(0, 16).replace('T', ' ')}`,
      ),
      section(
        'Today',
        home.today.length === 0
          ? h('p', { class: 'empty' }, 'No meetings today.')
          : h(
              'ul',
              { class: 'list', test: 'today' },
              home.today.map((meeting) =>
                h(
                  'li',
                  null,
                  h('span', { class: 'time' }, meeting.time),
                  ' ',
                  link(meeting.title, () => ui.go({ screen: 'meetings', ref: meeting.ref })),
                  ' ',
                  chip(meeting.ref),
                ),
              ),
            ),
      ),
      section('Needs you', attention(home, ui)),
      section(
        `Due soon (${String(home.counts.dueSoon)} of ${String(home.counts.open)} open)`,
        table(
          ['Item', 'Title', 'Due', 'State'],
          home.items.map((item) =>
            h(
              'tr',
              { test: `home-item-${item.ref}` },
              h(
                'td',
                null,
                link(item.ref, () => ui.go({ screen: 'items', ref: item.ref })),
              ),
              h('td', null, item.title),
              h('td', null, item.due),
              h('td', null, stateChip(item.state)),
            ),
          ),
          'Nothing is due in the next seven days.',
        ),
      ),
    );
  },
};
