/**
 * Settings → Agent access (07 §5; 04 §4.2, §8 rule 3). Adding, changing and removing an agent
 * (a principal) is human-only (04 §4.3): only this screen does it, as the user.
 *
 * The basics: one row per agent with its permission set and a plain sentence of what it can
 * do, and Remove access with a confirmation; Connect an assistant, which adds an `mcp_client`
 * principal with the Helper set (the `claude-code` row of 07 §5) and shows the one line that
 * registers the `command-center` server with the chosen client, with a Copy button.
 *
 * Advanced: the exact permissions of one agent as a checkbox grid (plain label and scope ID),
 * the permission sets, workstreams and sensitive access, adding an agent of any kind, and the
 * removed agents.
 *
 * Remove access and granting one of the four high-risk scopes of 07 §5 rule 3 (in the grid and
 * when adding an agent) are Tier H operations (04 §4.3 rule 4, C-04-12): this screen explains
 * them inline, and the user confirms them in the app shell's confirm window, with text the
 * core wrote. While that window is open the screen says "Confirm in the window".
 */
import type { Params } from '@cc/ui-sdk/v1';

import { GRANT_ONLY_SCOPES, SCOPES, type PrincipalRow } from '../app/api.js';
import {
  act,
  actInWindow,
  errorText,
  IN_WINDOW,
  inWindow,
  waitingInWindow,
  type Ui,
} from '../app/screen.js';
import { button, inWindowNote } from '../ui/parts.js';
import { h, type VNode } from '../ui/vnode.js';
import {
  advanced,
  ago,
  card,
  choice,
  confirmPanel,
  copyBox,
  fields,
  input,
  listing,
  pageHead,
  row,
  tag,
} from './settings-parts.js';

type Scope = (typeof SCOPES)[number];
type PrincipalKind = Params<'principals.create'>['kind'];

/** The MCP server name of 07 §7. */
export const MCP_SERVER = 'command-center';

/** The MCP clients whose registration command Settings prints (04 §8 rule 3). */
export type McpClient = 'claude-code' | 'codex' | 'other';

/** The permission sets of 07 §5: named scope sets; any other set is Custom. */
export const PRESETS = [
  {
    id: 'helper',
    label: 'Helper',
    scopes: [
      'read',
      'items:write',
      'items:claim',
      'decisions:propose',
      'meetings:capture',
      'connectors:read',
    ],
  },
  { id: 'drafts', label: 'Drafts only', scopes: ['read', 'items:write'] },
  { id: 'read', label: 'Read only', scopes: ['read'] },
] as const satisfies readonly { id: string; label: string; scopes: readonly Scope[] }[];

export type PresetId = (typeof PRESETS)[number]['id'] | 'custom';

/** The scopes an MCP client gets when connected here: the Helper set (07 §5 `claude-code`). */
export const MCP_CLIENT_SCOPES = PRESETS[0].scopes;

/**
 * The four scopes no agent has by default (07 §5 rule 3); granting one is confirmed in the app
 * shell's confirm window (C-04-12).
 */
export const HIGH_RISK: ReadonlySet<string> = new Set<Scope>(GRANT_ONLY_SCOPES);

/** Each scope in plain words (the README glossary), and as a verb for the summary sentence. */
export const SCOPE_LABELS: Readonly<Record<Scope, { label: string; verb: string }>> = {
  read: { label: 'See your work', verb: 'see your work' },
  'items:write': { label: 'Draft items and update notes', verb: 'draft items' },
  'items:claim': { label: 'Mark its work done, with evidence', verb: 'mark its work done' },
  'decisions:propose': { label: 'Suggest decisions', verb: 'suggest decisions' },
  'meetings:capture': { label: 'Add notes in a live meeting', verb: 'add meeting notes' },
  'measures:write': { label: 'Enter scorecard numbers', verb: 'enter scorecard numbers' },
  'connectors:read': { label: 'See connected services', verb: 'see connected services' },
  'connectors:invoke': { label: 'Use connected services', verb: 'use connected services' },
  'sessions:read': { label: 'See browser sign-in status', verb: 'see browser sign-in status' },
  'discovery:request': {
    label: 'Ask to set up a new connection',
    verb: 'ask for new connections',
  },
  'requests:propose': { label: 'Suggest changes to your setup', verb: 'suggest setup changes' },
  'onboarding:apply': { label: 'Apply setup changes', verb: 'apply setup changes' },
};

/** What granting a high-risk scope lets the agent do, and what stays with the user. */
const HIGH_RISK_DETAIL: Readonly<Record<string, string>> = {
  'connectors:invoke':
    'It can run actions in your connected services. Your policies still check every one, and anything that leaves Command Center still needs your confirmation here.',
  'discovery:request':
    'It can ask for a new service to be connected. Starting the work stays with you.',
  'requests:propose':
    'It can propose changes to your setup, such as engine changes. Approving them stays with you.',
  'onboarding:apply':
    'It can apply setup answers, such as an onboarding profile. Calendar changes still need your confirmation.',
};

export const KIND_LABELS: Readonly<Record<string, string>> = {
  mcp_client: 'AI assistant',
  cli: 'Command line',
  external_framework: 'Agent framework',
  internal_orchestrator: 'Built-in helper',
};

const CLIENTS: readonly { value: McpClient; label: string; name: string }[] = [
  { value: 'claude-code', label: 'Claude Code', name: 'claude-code' },
  { value: 'codex', label: 'Codex', name: 'codex' },
  { value: 'other', label: 'Another MCP tool', name: 'mcp-client' },
];

/** The command that registers the relay with a client, for one principal (04 §8 rule 3). */
export function registrationCommand(client: McpClient, principal: string): string {
  const relay = `cc-axi mcp --principal ${principal}`;
  switch (client) {
    case 'claude-code':
      return `claude mcp add ${MCP_SERVER} -- ${relay}`;
    case 'codex':
      return `codex mcp add ${MCP_SERVER} -- ${relay}`;
    case 'other':
      return JSON.stringify({
        mcpServers: {
          [MCP_SERVER]: { command: 'cc-axi', args: ['mcp', '--principal', principal] },
        },
      });
  }
}

/** The permission set a scope list is, or Custom. */
export function presetOf(scopes: readonly string[]): PresetId {
  const have = new Set(scopes);
  const found = PRESETS.find(
    (preset) =>
      preset.scopes.length === have.size && preset.scopes.every((scope) => have.has(scope)),
  );
  return found?.id ?? 'custom';
}

export function presetLabel(id: PresetId): string {
  return PRESETS.find((preset) => preset.id === id)?.label ?? 'Custom';
}

/** "Can see your work, draft items and mark its work done." */
export function canDo(scopes: readonly string[]): string {
  const verbs = SCOPES.filter((scope) => scopes.includes(scope)).map(
    (scope) => SCOPE_LABELS[scope].verb,
  );
  return verbs.length === 0 ? 'Can do nothing yet.' : `Can ${listing(verbs)}.`;
}

export interface AgentsForm {
  /** The agent whose Remove access is waiting for the second click. */
  removing?: string | undefined;
  /** The high-risk grant waiting for the second click. */
  granting?: { readonly name: string; readonly scope: Scope } | undefined;
  /** The agent whose exact permissions Advanced shows. */
  editing?: string | undefined;
  readonly add: { name: string; kind: PrincipalKind; scopes: Set<Scope>; confirming: boolean };
  readonly client: { name: string; client: McpClient };
}

export function agentsForm(ui: Ui): AgentsForm {
  return ui.keep<AgentsForm>('settings-agents', () => ({
    add: { name: '', kind: 'mcp_client', scopes: new Set<Scope>(['read']), confirming: false },
    client: { name: 'claude-code', client: 'claude-code' },
  }));
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const NAME_RULE = 'A name is lower-case letters, digits and dashes, such as night-helper.';

function update(ui: Ui, principal: PrincipalRow, scopes: readonly Scope[], done: string): void {
  void act(
    ui,
    () => ui.call('principals.update', { name: principal.name, scopes: [...scopes] }),
    done,
  );
}

function agentRow(principal: PrincipalRow, form: AgentsForm, ui: Ui): VNode {
  const kind = KIND_LABELS[principal.kind] ?? principal.kind;
  const used =
    principal.lastUsedAt === undefined
      ? 'never used'
      : `used ${ago(principal.lastUsedAt, ui.now())}`;
  const risky = principal.scopes.some((scope) => HIGH_RISK.has(scope));
  return row({
    test: `principal-${principal.name}`,
    label: principal.name,
    help: `${kind} · ${used}`,
    value: [
      tag(presetLabel(presetOf(principal.scopes)), 'neutral', `preset-tag-${principal.name}`),
      risky ? tag('Needs care', 'warn') : null,
      h('span', { class: 'vtext', test: `can-do-${principal.name}` }, canDo(principal.scopes)),
    ],
    action: h(
      'button',
      {
        type: 'button',
        class: 'secondary danger',
        test: `revoke-${principal.name}`,
        onClick: () => {
          form.removing = principal.name;
          ui.render();
        },
      },
      'Remove access…',
    ),
    below: waitingInWindow(ui, `revoke-${principal.name}`)
      ? inWindowNote(IN_WINDOW.confirm, `revoke-in-window-${principal.name}`)
      : form.removing === principal.name
        ? confirmPanel({
            test: `revoke-confirm-${principal.name}`,
            question: `Remove access for ${principal.name}?`,
            detail:
              'It stops working with Command Center straight away and its key is deleted. You can connect it again later. You confirm it in Command Center’s own window next.',
            confirm: 'Remove access…',
            danger: true,
            confirmTest: `revoke-now-${principal.name}`,
            cancelTest: `revoke-cancel-${principal.name}`,
            onConfirm: () => {
              form.removing = undefined;
              void actInWindow(
                ui,
                `revoke-${principal.name}`,
                () => ui.call('principals.revoke', { name: principal.name }),
                `${principal.name} can no longer reach Command Center; its key is deleted.`,
              );
            },
            onCancel: () => {
              form.removing = undefined;
              ui.render();
            },
          })
        : null,
  });
}

function connectRows(active: readonly PrincipalRow[], form: AgentsForm, ui: Ui): VNode[] {
  const add = form.client;
  const client = CLIENTS.find((entry) => entry.value === add.client) ?? CLIENTS[0];
  const clients = active.filter((principal) => principal.kind === 'mcp_client');
  const connect = row({
    test: 'add-mcp-client',
    label: 'Connect an assistant',
    help: 'Pick the tool; Command Center shows the one line to paste into it.',
    value: fields(
      choice(
        'Assistant',
        add.client,
        CLIENTS,
        (value) => {
          const previous = CLIENTS.find((entry) => entry.value === add.client);
          add.client = value as McpClient;
          // A name the user has not changed follows the tool.
          if (add.name === previous?.name) {
            add.name = CLIENTS.find((entry) => entry.value === value)?.name ?? add.name;
          }
          ui.render();
        },
        'mcp-client',
      ),
      input('Name', add.name, (value) => (add.name = value), {
        test: 'mcp-client-name',
        placeholder: client?.name ?? 'claude-code',
      }),
    ),
    action: button(
      'Connect',
      () => {
        const name = add.name.trim();
        if (!NAME.test(name)) {
          ui.flash(NAME_RULE, 'error');
          return;
        }
        const params = { name, kind: 'mcp_client' as const, scopes: [...MCP_CLIENT_SCOPES] };
        void (async () => {
          try {
            await ui.call('principals.create', params);
            ui.flash(
              `${name} added. Register it with: ${registrationCommand(add.client, name)}`,
              'ok',
            );
          } catch (error) {
            ui.flash(errorText(error), 'error');
          }
          await ui.reload();
        })();
      },
      { test: 'add-mcp-client-submit', primary: true },
    ),
  });
  const commands =
    clients.length === 0
      ? row({
          test: 'mcp-registrations',
          label: 'Paste this in the assistant',
          help: 'It holds no secret.',
          value: h('span', { class: 'muted' }, 'No assistant connected yet.'),
        })
      : h(
          'div',
          { test: 'mcp-registrations' },
          clients.map((principal) =>
            row({
              label: `Paste this in ${client?.label ?? 'the assistant'}`,
              help: `For ${principal.name}. It holds no secret.`,
              value: copyBox(
                registrationCommand(add.client, principal.name),
                ui,
                `mcp-command-${principal.name}`,
                `copy-${principal.name}`,
              ),
            }),
          ),
        );
  return [connect, commands];
}

/** The exact permissions of one agent: a column-snapped grid, plain label and scope ID. */
function permissionGrid(principal: PrincipalRow, form: AgentsForm, ui: Ui): VNode {
  return h(
    'div',
    {
      class: 'checks',
      role: 'group',
      'aria-label': `Permissions for ${principal.name}`,
      test: `scopes-${principal.name}`,
    },
    SCOPES.map((scope) =>
      scopeCheck(
        scope,
        principal.scopes.includes(scope),
        (checked) => {
          if (checked && HIGH_RISK.has(scope)) {
            form.granting = { name: principal.name, scope };
            ui.render();
            return;
          }
          const scopes = checked
            ? [...principal.scopes, scope]
            : principal.scopes.filter((s) => s !== scope);
          update(
            ui,
            principal,
            scopes,
            `${principal.name} ${checked ? 'can now' : 'can no longer'} ${SCOPE_LABELS[scope].verb}.`,
          );
        },
        `scope-${principal.name}-${scope}`,
      ),
    ),
  );
}

function scopeCheck(
  scope: Scope,
  checked: boolean,
  onCheck: (checked: boolean) => void,
  test: string,
): VNode {
  return h(
    'label',
    { class: HIGH_RISK.has(scope) ? 'scope care' : 'scope' },
    h('input', { type: 'checkbox', checked, onCheck, test }),
    h(
      'span',
      null,
      SCOPE_LABELS[scope].label,
      HIGH_RISK.has(scope) ? h('b', { class: 'caretag' }, 'Needs care') : null,
      h('small', null, scope),
    ),
  );
}

function grantConfirm(principal: PrincipalRow, scope: Scope, form: AgentsForm, ui: Ui): VNode {
  const label = SCOPE_LABELS[scope].label;
  return confirmPanel({
    test: `grant-confirm-${principal.name}-${scope}`,
    question: `Let ${principal.name} ${label.toLowerCase()} (${scope})?`,
    detail: `${HIGH_RISK_DETAIL[scope] ?? ''} You confirm it in Command Center’s own window next.`,
    confirm: 'Allow…',
    confirmTest: `grant-now-${principal.name}-${scope}`,
    cancelTest: `grant-cancel-${principal.name}-${scope}`,
    onConfirm: () => {
      form.granting = undefined;
      void actInWindow(
        ui,
        `grant-${principal.name}`,
        () =>
          ui.call('principals.update', {
            name: principal.name,
            scopes: [...principal.scopes, scope],
          }),
        `${principal.name} can now ${SCOPE_LABELS[scope].verb}.`,
      );
    },
    onCancel: () => {
      form.granting = undefined;
      ui.render();
    },
  });
}

function permissionsView(active: readonly PrincipalRow[], form: AgentsForm, ui: Ui): VNode[] {
  if (active.length === 0) return [h('p', { class: 'muted' }, 'No agent has access.')];
  const principal = active.find((entry) => entry.name === form.editing) ?? active[0];
  if (principal === undefined) return [];
  const preset = presetOf(principal.scopes);
  return [
    row({
      label: 'Agent',
      help: 'Whose permissions to change.',
      value: fields(
        choice(
          'Agent',
          principal.name,
          active.map((entry) => ({
            value: entry.name,
            label: `${entry.name} (${KIND_LABELS[entry.kind] ?? entry.kind})`,
          })),
          (value) => {
            form.editing = value;
            form.granting = undefined;
            ui.render();
          },
          'permissions-agent',
        ),
        choice(
          'Permission set',
          preset,
          [
            ...PRESETS.map((entry) => ({ value: entry.id, label: entry.label })),
            ...(preset === 'custom' ? [{ value: 'custom', label: 'Custom' }] : []),
          ],
          (value) => {
            const chosen = PRESETS.find((entry) => entry.id === value);
            if (chosen === undefined) return;
            update(
              ui,
              principal,
              [...chosen.scopes],
              `${principal.name} now has the ${chosen.label} permissions.`,
            );
          },
          `preset-${principal.name}`,
        ),
      ),
    }),
    permissionGrid(principal, form, ui),
    waitingInWindow(ui, `grant-${principal.name}`)
      ? inWindowNote(IN_WINDOW.confirm, `grant-in-window-${principal.name}`)
      : form.granting?.name === principal.name
        ? grantConfirm(principal, form.granting.scope, form, ui)
        : null,
    row({
      test: `workstreams-${principal.name}`,
      label: 'Workstreams',
      help: 'Changing these arrives in a later version.',
      value: [
        principal.workstreamFilter === 'all'
          ? 'All workstreams'
          : `${String(principal.workstreamFilter.length)} workstreams`,
        h(
          'span',
          { class: 'muted small' },
          principal.sensitiveAccess ? ' · can see sensitive ones' : ' · not sensitive ones',
        ),
      ],
    }),
    row({
      label: 'Last used',
      value:
        principal.lastUsedAt === undefined
          ? 'Never'
          : `${principal.lastUsedAt.slice(0, 16).replace('T', ' ')} UTC`,
    }),
  ].filter((node): node is VNode => node !== null);
}

function addAgentView(form: AgentsForm, ui: Ui): VNode {
  const add = form.add;
  const risky = [...add.scopes].filter((scope) => HIGH_RISK.has(scope));
  const submit = () => {
    const name = add.name.trim();
    const params = { name, kind: add.kind, scopes: [...add.scopes] };
    add.confirming = false;
    // With a high-risk scope the core asks the app shell to confirm it (C-04-12).
    const create = () => ui.call('principals.create', params);
    void (async () => {
      try {
        const created = await (risky.length > 0 ? inWindow(ui, 'add-principal', create) : create());
        add.name = '';
        ui.flash(`${name} added. Its key is in ${created.tokenPath}.`, 'ok');
      } catch (error) {
        ui.flash(errorText(error), 'error');
      }
      await ui.reload();
    })();
  };
  return h(
    'div',
    { test: 'add-principal' },
    row({
      label: 'Add another agent',
      help: 'A command-line tool or an agent framework, with exactly the permissions you tick.',
      value: fields(
        input('Name', add.name, (value) => (add.name = value), {
          test: 'principal-name',
          placeholder: 'night-helper',
        }),
        choice(
          'Kind',
          add.kind,
          [
            { value: 'mcp_client', label: 'AI assistant (MCP)' },
            { value: 'cli', label: 'Command line' },
            { value: 'external_framework', label: 'Agent framework' },
          ],
          (value) => (add.kind = value),
          'principal-kind',
        ),
      ),
      action: button(
        'Add agent',
        () => {
          if (!NAME.test(add.name.trim())) {
            ui.flash(NAME_RULE, 'error');
            return;
          }
          if (risky.length > 0) {
            add.confirming = true;
            ui.render();
            return;
          }
          submit();
        },
        { test: 'add-principal-submit' },
      ),
      below: waitingInWindow(ui, 'add-principal')
        ? inWindowNote(IN_WINDOW.confirm, 'add-principal-in-window')
        : add.confirming
          ? confirmPanel({
              test: 'add-principal-confirm',
              question: `Add ${add.name.trim()} with ${risky.length === 1 ? 'a permission' : 'permissions'} that ${risky.length === 1 ? 'needs' : 'need'} care?`,
              detail: [
                ...risky.map(
                  (scope) => `${SCOPE_LABELS[scope].label}: ${HIGH_RISK_DETAIL[scope] ?? ''}`,
                ),
                'You confirm it in Command Center’s own window next.',
              ].join(' '),
              confirm: 'Add agent…',
              confirmTest: 'add-principal-now',
              cancelTest: 'add-principal-cancel',
              onConfirm: submit,
              onCancel: () => {
                add.confirming = false;
                ui.render();
              },
            })
          : null,
    }),
    h(
      'div',
      { class: 'checks', role: 'group', 'aria-label': 'Permissions for the new agent' },
      SCOPES.map((scope) =>
        scopeCheck(
          scope,
          add.scopes.has(scope),
          (checked) => {
            if (checked) add.scopes.add(scope);
            else add.scopes.delete(scope);
            add.confirming = false;
            ui.render();
          },
          `add-scope-${scope}`,
        ),
      ),
    ),
  );
}

export function agentsView(
  principals: readonly PrincipalRow[],
  open: boolean,
  toggle: () => void,
  ui: Ui,
): VNode {
  const form = agentsForm(ui);
  const active = principals.filter((principal) => principal.revokedAt === undefined);
  const removed = principals.filter((principal) => principal.revokedAt !== undefined);
  return h(
    'div',
    { test: 'agents' },
    pageHead(
      'Agent access',
      'Assistants and tools that can work with Command Center. Only you can approve, decide or confirm, in this app.',
    ),
    card(
      'agents-basic',
      active.length === 0
        ? row({ label: 'Agents', value: h('span', { class: 'muted' }, 'No agent has access.') })
        : active.map((principal) => agentRow(principal, form, ui)),
      connectRows(active, form, ui),
      advanced(
        {
          test: 'agents-advanced',
          title: 'Advanced · exact permissions',
          summary: 'Choose each permission one by one, see workstreams, add other kinds of agents.',
          open,
          toggle,
        },
        () => [
          ...permissionsView(active, form, ui),
          addAgentView(form, ui),
          removed.length === 0
            ? null
            : row({
                test: 'removed-agents',
                label: 'Removed',
                help: 'These can no longer reach Command Center.',
                value: removed.map((principal) =>
                  h(
                    'span',
                    { class: 'removed', test: `removed-${principal.name}` },
                    principal.name,
                  ),
                ),
              }),
          h(
            'p',
            { class: 'small muted' },
            'Permissions keep cooperating agents apart. They do not protect against other programs running as you; the confirmations in this app do that.',
          ),
        ],
      ),
    ),
  );
}
