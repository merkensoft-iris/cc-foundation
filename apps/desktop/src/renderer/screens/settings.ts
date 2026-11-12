/**
 * Settings (09 P1-11): Agent access (07 §5: principals, their scopes and workstreams; adding,
 * changing and revoking are human-only, 04 §4.3), Notifications (02 §10), and a placeholder for
 * the AI settings, which arrive with the AI layer (P3). No AI runs in this build.
 */
import { SCOPES, type PrincipalRow } from '../app/api.js';
import type { AppRoute } from '../app/routes.js';
import { act, errorText, type Screen, type Ui } from '../app/screen.js';
import { button, checkbox, chip, field, page, section, select, table, tabs } from '../ui/parts.js';
import { h, type VNode } from '../ui/vnode.js';

type Tab = 'agents' | 'notifications' | 'ai';

export interface SettingsState {
  tab: Tab;
  principals?: readonly PrincipalRow[];
  readonly add: { name: string; kind: string; scopes: Set<string> };
}

const TABS = [
  { id: 'agents', label: 'Agent access' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'ai', label: 'AI' },
] as const;

/** The kinds pushed as desktop notifications (02 §10 rule 2); the rest stay in the app. */
const PUSHED: readonly { kind: string; label: string }[] = [
  { kind: 'meeting_reminder', label: 'Meeting reminders' },
  { kind: 'confirmation_waiting', label: 'A confirmation is waiting' },
  { kind: 'browser_session_needs_you', label: 'A browser session needs you' },
  { kind: 'escalation', label: 'Escalations (E1 and above)' },
  { kind: 'failed_step', label: 'A step failed' },
  { kind: 'rhythm_escalation', label: 'Rhythm escalations' },
  { kind: 'backup_failing', label: 'Backups failing' },
];

function scopesCell(principal: PrincipalRow, ui: Ui): VNode {
  const revoked = principal.revokedAt !== undefined;
  return h(
    'div',
    { class: 'scopes', test: `scopes-${principal.name}` },
    SCOPES.map((scope) =>
      revoked
        ? principal.scopes.includes(scope)
          ? chip(scope)
          : null
        : checkbox(
            scope,
            principal.scopes.includes(scope),
            (checked) => {
              const scopes = checked
                ? [...principal.scopes, scope]
                : principal.scopes.filter((s) => s !== scope);
              void act(
                ui,
                () => ui.call('principals.update', { name: principal.name, scopes }),
                `${checked ? 'Granted' : 'Revoked'} ${scope} ${checked ? 'to' : 'from'} ${principal.name}.`,
              );
            },
            `scope-${principal.name}-${scope}`,
          ),
    ),
  );
}

function agentsView(state: SettingsState, ui: Ui): VNode {
  const add = state.add;
  return h(
    'div',
    null,
    h(
      'p',
      { class: 'muted' },
      'Agents reach Command Center through the CLI and MCP as principals. Each has its scopes and workstreams. ',
      'Scopes keep cooperating agents apart; they are not a defence against code running as you.',
    ),
    table(
      ['Principal', 'Kind', 'Scopes', 'Workstreams', 'Last used', ''],
      (state.principals ?? []).map((principal) =>
        h(
          'tr',
          { test: `principal-${principal.name}` },
          h(
            'td',
            null,
            principal.name,
            principal.revokedAt === undefined ? null : [' ', chip('revoked', 'bad')],
          ),
          h('td', null, principal.kind),
          h('td', null, scopesCell(principal, ui)),
          h(
            'td',
            null,
            principal.workstreamFilter === 'all'
              ? 'all'
              : `${String(principal.workstreamFilter.length)} workstreams`,
            principal.sensitiveAccess ? ' · sensitive' : '',
          ),
          h('td', null, principal.lastUsedAt?.slice(0, 16).replace('T', ' ') ?? 'never'),
          h(
            'td',
            null,
            principal.revokedAt === undefined
              ? button(
                  'Revoke',
                  () =>
                    void act(
                      ui,
                      () => ui.call('principals.revoke', { name: principal.name }),
                      `${principal.name} revoked; its token file is deleted.`,
                    ),
                  { test: `revoke-${principal.name}` },
                )
              : null,
          ),
        ),
      ),
      'No principals.',
    ),
    section(
      'Add a principal',
      h(
        'div',
        { class: 'form', test: 'add-principal' },
        field('Name', add.name, (value) => (add.name = value), {
          test: 'principal-name',
          placeholder: 'claude-code',
        }),
        select(
          'Kind',
          add.kind,
          [
            { value: 'mcp_client', label: 'MCP client' },
            { value: 'cli', label: 'CLI' },
            { value: 'external_framework', label: 'External agent framework' },
          ],
          (value) => (add.kind = value),
          'principal-kind',
        ),
        h(
          'div',
          { class: 'scopes' },
          SCOPES.map((scope) =>
            checkbox(
              scope,
              add.scopes.has(scope),
              (checked) => {
                if (checked) add.scopes.add(scope);
                else add.scopes.delete(scope);
              },
              `add-scope-${scope}`,
            ),
          ),
        ),
        button(
          'Add principal',
          () => {
            const name = add.name.trim();
            if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
              ui.flash('A principal name is lower-case letters, digits and dashes.', 'error');
              return;
            }
            const params = { name, kind: add.kind, scopes: [...add.scopes] };
            void (async () => {
              try {
                const created = await ui.call<{ tokenPath: string }>('principals.create', params);
                add.name = '';
                ui.flash(`${name} added. Its token is in ${created.tokenPath}.`, 'ok');
              } catch (error) {
                ui.flash(errorText(error), 'error');
              }
              await ui.reload();
            })();
          },
          { test: 'add-principal-submit', primary: true },
        ),
      ),
    ),
  );
}

function notificationsView(): VNode {
  return h(
    'div',
    { test: 'notifications' },
    h('p', null, 'These are pushed as desktop notifications. Everything else waits in the app.'),
    h(
      'ul',
      null,
      PUSHED.map((entry) => h('li', { test: `pushed-${entry.kind}` }, entry.label)),
    ),
    h(
      'p',
      { class: 'muted' },
      'Nothing is pushed during quiet hours or hard protected blocks. Both come from your onboarding answers.',
    ),
  );
}

function aiView(): VNode {
  return h(
    'div',
    { test: 'ai-placeholder' },
    h(
      'p',
      null,
      'AI features are not part of this build. No AI runs, and nothing is sent to an AI provider.',
    ),
    h(
      'p',
      { class: 'muted' },
      'AI arrives in a later phase: pre-read summaries, drafting from notes and email, and advisory review of claims. ',
      'It will be off until you turn it on here, workstream by workstream.',
    ),
  );
}

export const settingsScreen: Screen<SettingsState> = {
  async load(ui, route: AppRoute) {
    const tab: Tab = route.screen === 'settings' ? (route.tab ?? 'agents') : 'agents';
    const add = ui.keep('add-principal', () => ({
      name: '',
      kind: 'mcp_client',
      scopes: new Set<string>(['read']),
    }));
    if (tab !== 'agents') return { tab, add };
    const list = await ui.call<{ principals: PrincipalRow[] }>('principals.list', {});
    return { tab, add, principals: list.principals };
  },
  view(state, ui) {
    const header = tabs(state.tab, TABS, (tab) => ui.go({ screen: 'settings', tab }));
    const body =
      state.tab === 'agents'
        ? agentsView(state, ui)
        : state.tab === 'notifications'
          ? notificationsView()
          : aiView();
    return page('Settings', header, body);
  },
};
