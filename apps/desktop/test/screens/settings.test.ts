/**
 * Settings (09 P1-11): the Overview of four status cards, the section menu, and the section
 * pages with their basics and Advanced panel. Agent access (07 §5; 04 §4.2, §8 rule 3): the
 * permission sets, Remove access and high-risk grants behind an inline confirmation,
 * Connect an assistant with its Copy line. Notifications with the quiet hours, and the AI
 * placeholder. Backups has its own file, `backups.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import type { BackupStatus } from '../../src/renderer/app/api.js';
import { SECTIONS } from '../../src/renderer/screens/settings.js';
import {
  canDo,
  presetOf,
  PRESETS,
  SCOPE_LABELS,
} from '../../src/renderer/screens/settings-agents.js';
import { allByTest, byTest, queryByTest, textOf } from '../../src/renderer/ui/vnode.js';
import { click, startApp, type } from './harness.js';

const principals = [
  {
    name: 'cli-default',
    kind: 'cli',
    scopes: [
      'read',
      'items:write',
      'items:claim',
      'measures:write',
      'connectors:read',
      'sessions:read',
    ],
    workstreamFilter: 'all',
    sensitiveAccess: false,
    lastUsedAt: '2026-11-13T07:30:00.000Z',
  },
  {
    name: 'claude-code',
    kind: 'mcp_client',
    scopes: [
      'read',
      'items:write',
      'items:claim',
      'decisions:propose',
      'meetings:capture',
      'connectors:read',
    ],
    workstreamFilter: 'all',
    sensitiveAccess: false,
  },
  {
    name: 'night-helper',
    kind: 'external_framework',
    scopes: ['read', 'items:write', 'connectors:invoke'],
    workstreamFilter: ['ws_1', 'ws_2'],
    sensitiveAccess: true,
  },
  {
    name: 'old-agent',
    kind: 'mcp_client',
    scopes: ['read'],
    workstreamFilter: 'all',
    sensitiveAccess: false,
    revokedAt: '2026-11-01T00:00:00Z',
  },
];

const ok: BackupStatus = {
  state: 'ok',
  lastGoodLocalAt: '2026-11-13T06:30:00.000Z',
  lastGoodOffMachineAt: '2026-11-13T06:30:00.000Z',
  lastGood: {
    id: 'bkp_01KA0000000000000000000002',
    at: '2026-11-13T06:30:00.000Z',
    destination: 'Synced folder',
  },
  lastRestoreTest: { at: '2026-11-11T09:30:00.000Z', ok: true, detail: 'ok' },
  destination: 'Synced folder',
  passphraseSet: true,
  reasons: [],
};

const onboarding = {
  state: 'committed',
  completedSteps: [],
  workstreams: 2,
  appOnly: [],
  profile: {
    workspace: {
      quietHours: [{ start: '23:30', end: '08:00' }],
      protectedBlocks: [{ policy: 'hard' }, { policy: 'soft' }],
    },
  },
};

function api(overrides: Record<string, (params: Record<string, unknown>) => unknown> = {}) {
  return {
    'backups.status': () => ok,
    'backups.run': () => ({ status: ok }),
    'principals.list': () => ({ principals, total: principals.length }),
    'principals.update': () => ({ principal: principals[0] }),
    'principals.revoke': () => ({ principal: principals[0] }),
    'principals.create': () => ({
      principal: principals[0],
      tokenPath: '/tmp/x/run/tokens/new.token',
    }),
    'onboarding.status': () => onboarding,
    ...overrides,
  };
}

describe('Settings: the Overview and the section menu (09 P1-11)', () => {
  it('opens on the Overview: four plain status cards for backups, agent access, notifications and AI', async () => {
    const app = await startApp(api(), { screen: 'settings' });
    expect(queryByTest(app.tree(), 'overview')).toBeDefined();
    expect(textOf(byTest(app.tree(), 'overview-backup-state'))).toBe('Protected');
    expect(textOf(byTest(app.tree(), 'overview-backups'))).toMatch(
      /Last backup 3 hours ago · Synced folder\. The last restore check passed 2 days ago\./,
    );
    expect(textOf(byTest(app.tree(), 'overview-agent-count'))).toBe('3 connected');
    expect(textOf(byTest(app.tree(), 'overview-agents'))).toMatch(
      /cli-default \(Command line\), claude-code \(AI assistant\) and night-helper \(Agent framework\) can each work with Command Center\. None of them can approve, decide or confirm anything for you\. night-helper has a permission that needs care\./,
    );
    expect(textOf(byTest(app.tree(), 'overview-notifications'))).toMatch(
      /Quiet from 23:30 to 08:00, and during your protected focus block\./,
    );
    expect(textOf(byTest(app.tree(), 'overview-ai'))).toMatch(/nothing is sent to an AI service/);
    // Only reads: nothing changes by opening Settings.
    expect(app.calls.map((call) => call.method).sort()).toEqual([
      'backups.status',
      'onboarding.status',
      'principals.list',
    ]);
  });

  it('a card leads into its section, and Back up now runs the human-only backup from the Overview', async () => {
    const app = await startApp(api(), { screen: 'settings' });
    await click(app, byTest(app.tree(), 'overview-backup-run'));
    expect(app.callsOf('backups.run')).toEqual([{}]);
    expect(textOf(byTest(app.tree(), 'flash'))).toBe('Backup written.');
    await click(app, byTest(app.tree(), 'overview-open-agents'));
    expect(app.app.route).toEqual({ screen: 'settings', tab: 'agents' });
    expect(queryByTest(app.tree(), 'agents')).toBeDefined();
  });

  it('the menu keeps the section names core error help points to, and marks the current one', async () => {
    expect(SECTIONS.map((section) => section.label)).toEqual([
      'Overview',
      'Backups',
      'Agent access',
      'Notifications',
      'AI',
    ]);
    const app = await startApp(api(), { screen: 'settings', tab: 'agents' });
    expect(byTest(app.tree(), 'tab-agents').props['aria-current']).toBe('page');
    expect(byTest(app.tree(), 'tab-overview').props['aria-current']).toBeUndefined();
    await click(app, byTest(app.tree(), 'tab-notifications'));
    expect(app.app.route).toEqual({ screen: 'settings', tab: 'notifications' });
  });
});

describe('Settings → Agent access (07 §5)', () => {
  it('07 §5 the permission sets are exact scope sets; any other set is Custom', () => {
    expect(PRESETS.map((preset) => [preset.label, preset.scopes])).toEqual([
      [
        'Helper',
        [
          'read',
          'items:write',
          'items:claim',
          'decisions:propose',
          'meetings:capture',
          'connectors:read',
        ],
      ],
      ['Drafts only', ['read', 'items:write']],
      ['Read only', ['read']],
    ]);
    expect(presetOf(['items:write', 'read'])).toBe('drafts');
    expect(presetOf(['read', 'measures:write'])).toBe('custom');
    expect(canDo(['read', 'items:write'])).toBe('Can see your work and draft items.');
    expect(canDo([])).toBe('Can do nothing yet.');
  });

  it('basics: one row per agent with its permission set and what it can do; removed agents only under Advanced', async () => {
    const app = await startApp(api(), { screen: 'settings', tab: 'agents' });
    const tree = app.tree();
    expect(textOf(byTest(tree, 'principal-cli-default'))).toMatch(
      /cli-defaultCommand line · used 2 hours agoCustom/,
    );
    expect(textOf(byTest(tree, 'preset-tag-claude-code'))).toBe('Helper');
    expect(textOf(byTest(tree, 'principal-claude-code'))).toMatch(/never used/);
    expect(textOf(byTest(tree, 'principal-night-helper'))).toMatch(/Needs care/);
    expect(textOf(byTest(tree, 'can-do-night-helper'))).toBe(
      'Can see your work, draft items and use connected services.',
    );
    expect(queryByTest(tree, 'principal-old-agent')).toBeUndefined();
    // Advanced is closed until asked for.
    expect(queryByTest(tree, 'agents-advanced')).toBeUndefined();
    expect(allByTest(tree, 'scope-cli-default-read')).toEqual([]);
  });

  it('U3 Remove access asks first; Cancel changes nothing, and only the second click revokes', async () => {
    const app = await startApp(api(), { screen: 'settings', tab: 'agents' });
    await click(app, byTest(app.tree(), 'revoke-cli-default'));
    expect(app.callsOf('principals.revoke')).toEqual([]);
    expect(textOf(byTest(app.tree(), 'revoke-confirm-cli-default'))).toMatch(
      /Remove access for cli-default\? It stops working with Command Center straight away and its key is deleted\. You can connect it again later\./,
    );
    await click(app, byTest(app.tree(), 'revoke-cancel-cli-default'));
    expect(queryByTest(app.tree(), 'revoke-confirm-cli-default')).toBeUndefined();
    expect(app.callsOf('principals.revoke')).toEqual([]);

    await click(app, byTest(app.tree(), 'revoke-cli-default'));
    await click(app, byTest(app.tree(), 'revoke-now-cli-default'));
    expect(app.callsOf('principals.revoke')).toEqual([{ name: 'cli-default' }]);
    expect(textOf(byTest(app.tree(), 'flash'))).toMatch(/cli-default can no longer reach/);
  });

  it('Advanced: exact permissions apply at once, but a high-risk grant (07 §5 rule 3) takes a confirmation', async () => {
    const app = await startApp(api(), { screen: 'settings', tab: 'agents' });
    await click(app, byTest(app.tree(), 'agents-advanced-toggle'));
    const grid = byTest(app.tree(), 'scopes-cli-default');
    expect(textOf(grid)).toMatch(/Use connected servicesNeeds careconnectors:invoke/);

    byTest(grid, 'scope-cli-default-decisions:propose').props.onCheck?.(true);
    await app.settle();
    expect(app.callsOf('principals.update')).toEqual([
      { name: 'cli-default', scopes: [...principals[0]!.scopes, 'decisions:propose'] },
    ]);
    // The panel stays open across the reload.
    expect(queryByTest(app.tree(), 'agents-advanced')).toBeDefined();

    byTest(app.tree(), 'scope-cli-default-onboarding:apply').props.onCheck?.(true);
    await app.settle();
    expect(app.callsOf('principals.update')).toHaveLength(1);
    expect(textOf(byTest(app.tree(), 'grant-confirm-cli-default-onboarding:apply'))).toMatch(
      /Let cli-default apply setup changes \(onboarding:apply\)\? .*Calendar changes still need your confirmation\./,
    );
    await click(app, byTest(app.tree(), 'grant-cancel-cli-default-onboarding:apply'));
    expect(app.callsOf('principals.update')).toHaveLength(1);
    expect(queryByTest(app.tree(), 'grant-confirm-cli-default-onboarding:apply')).toBeUndefined();

    byTest(app.tree(), 'scope-cli-default-onboarding:apply').props.onCheck?.(true);
    await app.settle();
    await click(app, byTest(app.tree(), 'grant-now-cli-default-onboarding:apply'));
    expect(app.callsOf('principals.update')[1]).toEqual({
      name: 'cli-default',
      scopes: [...principals[0]!.scopes, 'onboarding:apply'],
    });

    // Revoking a high-risk scope needs no confirmation.
    type(byTest(app.tree(), 'permissions-agent'), 'night-helper');
    await app.settle();
    expect(textOf(byTest(app.tree(), 'workstreams-night-helper'))).toMatch(
      /2 workstreams · can see sensitive ones/,
    );
    byTest(app.tree(), 'scope-night-helper-connectors:invoke').props.onCheck?.(false);
    await app.settle();
    expect(app.callsOf('principals.update')[2]).toEqual({
      name: 'night-helper',
      scopes: ['read', 'items:write'],
    });
  });

  it('Advanced: a permission set replaces the scopes; removed agents are listed without controls', async () => {
    const app = await startApp(api(), { screen: 'settings', tab: 'agents' });
    await click(app, byTest(app.tree(), 'agents-advanced-toggle'));
    type(byTest(app.tree(), 'preset-cli-default'), 'read');
    await app.settle();
    expect(app.callsOf('principals.update')).toEqual([{ name: 'cli-default', scopes: ['read'] }]);
    expect(textOf(byTest(app.tree(), 'removed-old-agent'))).toBe('old-agent');
    expect(allByTest(app.tree(), 'scope-old-agent-read')).toEqual([]);
    expect(queryByTest(app.tree(), 'revoke-old-agent')).toBeUndefined();
  });

  it('Advanced: adding an agent with a high-risk permission asks first; without one it adds at once', async () => {
    const app = await startApp(api(), { screen: 'settings', tab: 'agents' });
    await click(app, byTest(app.tree(), 'agents-advanced-toggle'));
    const form = () => byTest(app.tree(), 'add-principal');
    type(byTest(form(), 'principal-name'), 'Not Valid');
    await click(app, byTest(form(), 'add-principal-submit'));
    expect(app.callsOf('principals.create')).toEqual([]);
    expect(textOf(byTest(app.tree(), 'flash'))).toMatch(/lower-case letters/);

    type(byTest(form(), 'principal-name'), 'night-drafter');
    type(byTest(form(), 'principal-kind'), 'external_framework');
    byTest(form(), 'add-scope-discovery:request').props.onCheck?.(true);
    await app.settle();
    await click(app, byTest(form(), 'add-principal-submit'));
    expect(app.callsOf('principals.create')).toEqual([]);
    expect(textOf(byTest(app.tree(), 'add-principal-confirm'))).toMatch(
      /Add night-drafter with a permission that needs care\? Ask to set up a new connection: .*Starting the work stays with you\./,
    );
    await click(app, byTest(app.tree(), 'add-principal-cancel'));
    expect(app.callsOf('principals.create')).toEqual([]);

    await click(app, byTest(form(), 'add-principal-submit'));
    await click(app, byTest(app.tree(), 'add-principal-now'));
    expect(app.callsOf('principals.create')).toEqual([
      { name: 'night-drafter', kind: 'external_framework', scopes: ['read', 'discovery:request'] },
    ]);
    expect(textOf(byTest(app.tree(), 'flash'))).toMatch(
      /night-drafter added\. Its key is in .*new\.token/,
    );

    type(byTest(form(), 'principal-name'), 'reader');
    byTest(form(), 'add-scope-discovery:request').props.onCheck?.(false);
    await app.settle();
    await click(app, byTest(form(), 'add-principal-submit'));
    expect(app.callsOf('principals.create')[1]).toEqual({
      name: 'reader',
      kind: 'external_framework',
      scopes: ['read'],
    });
  });

  it('AC-07-03 Connect an assistant creates an mcp_client principal with the Helper set and shows its registration line with Copy (04 §8 rule 3)', async () => {
    const registered = {
      name: 'claude-code',
      kind: 'mcp_client',
      scopes: ['read', 'items:write'],
      workstreamFilter: 'all',
      sensitiveAccess: false,
    };
    const listed: unknown[] = [principals[0], principals[3]];
    const app = await startApp(
      api({
        'principals.list': () => ({ principals: listed, total: listed.length }),
        'principals.create': () => {
          listed.push(registered);
          return { principal: registered, tokenPath: '/tmp/x/run/tokens/claude-code.token' };
        },
      }),
      { screen: 'settings', tab: 'agents' },
    );
    // The removed MCP client gets no line.
    expect(textOf(byTest(app.tree(), 'mcp-registrations'))).toMatch(/No assistant connected yet\./);
    await click(app, byTest(app.tree(), 'add-mcp-client-submit'));
    expect(app.callsOf('principals.create')).toEqual([
      {
        name: 'claude-code',
        kind: 'mcp_client',
        scopes: [
          'read',
          'items:write',
          'items:claim',
          'decisions:propose',
          'meetings:capture',
          'connectors:read',
        ],
      },
    ]);
    const command = 'claude mcp add command-center -- cc-axi mcp --principal claude-code';
    expect(textOf(byTest(app.tree(), 'flash'))).toBe(
      `claude-code added. Register it with: ${command}`,
    );
    expect(textOf(byTest(app.tree(), 'mcp-command-claude-code'))).toBe(command);
    await click(app, byTest(app.tree(), 'copy-claude-code'));
    expect(app.copied).toEqual([command]);
    expect(textOf(byTest(app.tree(), 'flash'))).toMatch(/^Copied\./);

    type(byTest(app.tree(), 'mcp-client'), 'codex');
    await app.settle();
    expect(textOf(byTest(app.tree(), 'mcp-command-claude-code'))).toBe(
      'codex mcp add command-center -- cc-axi mcp --principal claude-code',
    );
    // A name the user did not change follows the tool.
    expect(byTest(app.tree(), 'mcp-client-name').props.value).toBe('codex');
    type(byTest(app.tree(), 'mcp-client'), 'other');
    await app.settle();
    expect(JSON.parse(textOf(byTest(app.tree(), 'mcp-command-claude-code')))).toEqual({
      mcpServers: {
        'command-center': { command: 'cc-axi', args: ['mcp', '--principal', 'claude-code'] },
      },
    });

    type(byTest(app.tree(), 'mcp-client-name'), 'Not Valid');
    await click(app, byTest(app.tree(), 'add-mcp-client-submit'));
    expect(app.callsOf('principals.create')).toHaveLength(1);
    expect(textOf(byTest(app.tree(), 'flash'))).toMatch(/lower-case letters/);
  });

  it('U2 every scope has a plain label; the scope ID is shown only beside it, under Advanced', () => {
    for (const entry of Object.values(SCOPE_LABELS)) {
      expect(entry.label).toMatch(/^[A-Z][a-z ,-]+$/);
      expect(entry.label).not.toMatch(/:/);
    }
  });
});

describe('Settings → Notifications and AI', () => {
  it('02 §10 shows the quiet hours from onboarding, and the pushed kinds under Advanced', async () => {
    const app = await startApp(api(), { screen: 'settings', tab: 'notifications' });
    expect(textOf(byTest(app.tree(), 'quiet-hours'))).toMatch(
      /23:30 to 08:00, and during your protected focus block/,
    );
    expect(allByTest(app.tree(), 'pushed-escalation')).toEqual([]);
    await click(app, byTest(app.tree(), 'notifications-advanced-toggle'));
    expect(allByTest(app.tree(), 'pushed-escalation')).toHaveLength(1);
    expect(textOf(byTest(app.tree(), 'notifications-advanced'))).toMatch(
      /Meetings keep being missed/,
    );
    expect(app.calls.map((call) => call.method)).toEqual(['onboarding.status']);
  });

  it('without onboarding answers there are no quiet hours to show', async () => {
    const app = await startApp(
      api({ 'onboarding.status': () => ({ state: 'not_started', completedSteps: [] }) }),
      { screen: 'settings', tab: 'notifications' },
    );
    expect(textOf(byTest(app.tree(), 'quiet-hours'))).toMatch(/None set/);
  });

  it('the AI placeholder says nothing is sent, without calling anything', async () => {
    const app = await startApp({}, { screen: 'settings', tab: 'ai' });
    expect(textOf(byTest(app.tree(), 'ai-placeholder'))).toMatch(
      /no AI runs, and nothing is sent to an AI service/,
    );
    expect(app.calls).toEqual([]);
  });
});
