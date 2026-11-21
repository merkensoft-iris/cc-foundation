/**
 * Settings (09 P1-11). It opens on the Overview: four plain status cards that answer "is my
 * work backed up?", "who can use Command Center?", "when will it interrupt me?" and "is AI
 * sending anything anywhere?", each with one action and a way into its section. A Settings
 * menu leads to the section pages, whose names are the ones core error help sends the user
 * to: Backups (04 §9.1, P1-17: `settings-backups.ts`), Agent access (07 §5, 04 §8 rule 3:
 * `settings-agents.ts`), Notifications (02 §10) and AI (a placeholder until the AI layer, P3;
 * no AI runs in this build).
 *
 * Every section page has its basics on top and an Advanced panel at the bottom, on one fixed
 * row grid (label | value | action). Human-only actions (04 §4.3) are done here as the user;
 * the hard-to-undo and high-risk ones take an inline confirmation.
 */
import type { BackupStatus, PrincipalRow } from '../app/api.js';
import type { AppRoute, SettingsSection } from '../app/routes.js';
import type { Screen, Ui } from '../app/screen.js';
import { button } from '../ui/parts.js';
import { h, type Child, type VNode } from '../ui/vnode.js';
import { agentsView, HIGH_RISK, KIND_LABELS } from './settings-agents.js';
import {
  BACKUP_STATE,
  backUpNow,
  backupsView,
  lastBackup,
  loadBackups,
  type BackupsState,
} from './settings-backups.js';
import { advanced, ago, card, listing, pageHead, pill, row } from './settings-parts.js';

export {
  MCP_CLIENT_SCOPES,
  MCP_SERVER,
  registrationCommand,
  type McpClient,
} from './settings-agents.js';

/** The quiet hours and hard protected blocks of onboarding S1 (01 §3; 02 §10 rule 4). */
export interface QuietTimes {
  readonly quietHours: readonly { readonly start: string; readonly end: string }[];
  readonly hardBlocks: number;
}

export interface SettingsState {
  readonly section: SettingsSection;
  readonly principals?: readonly PrincipalRow[];
  readonly backups?: BackupsState;
  readonly backupStatus?: BackupStatus;
  readonly quiet?: QuietTimes;
}

/** The Settings menu, in its fixed order. */
export const SECTIONS: readonly { readonly id: SettingsSection; readonly label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'backups', label: 'Backups' },
  { id: 'agents', label: 'Agent access' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'ai', label: 'AI' },
];

/** Sections the design names that arrive in later versions (core error help points there). */
const LATER = ['Connectors', 'Browser sessions', 'Approvals', 'Secrets'];

/** The kinds pushed as desktop notifications (02 §10 rule 2), in plain words. */
const PUSHED: readonly { kind: string; label: string }[] = [
  { kind: 'meeting_reminder', label: 'A meeting is about to start' },
  { kind: 'confirmation_waiting', label: 'Something is waiting for your confirmation' },
  { kind: 'browser_session_needs_you', label: 'A browser sign-in needs you' },
  { kind: 'escalation', label: 'An item is escalating' },
  { kind: 'failed_step', label: 'A step failed and needs you' },
  { kind: 'rhythm_escalation', label: 'Meetings keep being missed' },
  { kind: 'backup_failing', label: 'Backups are failing, or a restore check failed' },
];

const AI_OFF = 'AI isn’t part of this version: no AI runs, and nothing is sent to an AI service.';

/** Which Advanced panels are open, kept for the window. */
type Open = Record<SettingsSection, boolean>;

function openPanels(ui: Ui): Open {
  return ui.keep<Open>('settings-advanced', () => ({
    overview: false,
    backups: false,
    agents: false,
    notifications: false,
    ai: false,
  }));
}

function toggler(ui: Ui, section: SettingsSection): () => void {
  return () => {
    const open = openPanels(ui);
    open[section] = !open[section];
    ui.render();
  };
}

async function loadQuiet(ui: Ui): Promise<QuietTimes> {
  const status = await ui.call<{
    profile?: {
      workspace: {
        quietHours: { start: string; end: string }[];
        protectedBlocks: { policy: 'hard' | 'soft' }[];
      };
    };
  }>('onboarding.status', {});
  const workspace = status.profile?.workspace;
  return {
    quietHours: workspace?.quietHours ?? [],
    hardBlocks: workspace?.protectedBlocks.filter((block) => block.policy === 'hard').length ?? 0,
  };
}

async function loadPrincipals(ui: Ui): Promise<PrincipalRow[]> {
  const list = await ui.call<{ principals: PrincipalRow[] }>('principals.list', {});
  return list.principals;
}

/** "23:30 to 08:00", "12:30 to 13:30 and 23:00 to 07:00". */
function quietText(quiet: QuietTimes): string {
  return listing(quiet.quietHours.map((range) => `${range.start} to ${range.end}`));
}

function blocksText(quiet: QuietTimes): string {
  if (quiet.hardBlocks === 0) return '';
  return quiet.hardBlocks === 1
    ? ', and during your protected focus block'
    : `, and during your ${String(quiet.hardBlocks)} protected focus blocks`;
}

function menu(current: SettingsSection, ui: Ui): VNode {
  return h(
    'nav',
    { class: 'settings-menu', 'aria-label': 'Settings sections' },
    SECTIONS.map((entry) =>
      h(
        'button',
        {
          type: 'button',
          test: `tab-${entry.id}`,
          class: 'menu-item',
          ...(entry.id === current ? { 'aria-current': 'page' } : {}),
          onClick: () => ui.go({ screen: 'settings', tab: entry.id }),
        },
        entry.label,
      ),
    ),
    h(
      'div',
      { class: 'menu-later' },
      'In later versions:',
      LATER.map((label) => h('span', null, label)),
    ),
  );
}

function overviewCard(options: {
  readonly test: string;
  readonly title: string;
  readonly status: VNode;
  readonly text: Child;
  readonly actions: Child;
}): VNode {
  return h(
    'article',
    { class: 'ov-card', test: options.test },
    h('header', null, h('h3', null, options.title), options.status),
    h('p', null, options.text),
    h('footer', null, options.actions),
  );
}

function backupsText(status: BackupStatus, ui: Ui): string {
  const parts: string[] = [];
  if (status.lastGood === undefined) parts.push('No backup has been made yet.');
  else parts.push(`${lastBackup(status, ui.now())}.`);
  if (status.state !== 'ok' && status.reasons[0] !== undefined) parts.push(status.reasons[0]);
  else if (status.destination === undefined)
    parts.push('Set a backup password and a second copy so a lost computer loses nothing.');
  const test = status.lastRestoreTest;
  if (test !== undefined && status.state === 'ok') {
    parts.push(
      `The last restore check ${test.ok ? 'passed' : 'failed'} ${ago(test.at, ui.now())}.`,
    );
  }
  return parts.join(' ');
}

function agentsText(active: readonly PrincipalRow[]): string {
  if (active.length === 0) return 'No assistant or tool can reach Command Center.';
  const names = listing(
    active.map(
      (principal) => `${principal.name} (${KIND_LABELS[principal.kind] ?? principal.kind})`,
    ),
  );
  const risky = active.filter((principal) =>
    principal.scopes.some((scope) => HIGH_RISK.has(scope)),
  );
  return [
    `${names} ${active.length === 1 ? 'can' : 'can each'} work with Command Center. None of them can approve, decide or confirm anything for you.`,
    risky.length === 0
      ? ''
      : ` ${listing(risky.map((principal) => principal.name))} ${risky.length === 1 ? 'has a permission' : 'have permissions'} that needs care.`,
  ].join('');
}

function overviewView(state: SettingsState, ui: Ui): VNode {
  const go = (tab: SettingsSection) => () => ui.go({ screen: 'settings', tab });
  const status = state.backupStatus;
  const active = (state.principals ?? []).filter((p) => p.revokedAt === undefined);
  const risky = active.some((principal) => principal.scopes.some((s) => HIGH_RISK.has(s)));
  const quiet = state.quiet ?? { quietHours: [], hardBlocks: 0 };
  return h(
    'div',
    { test: 'overview' },
    pageHead(
      'Everything at a glance',
      'Command Center comes set up sensibly. These are the few things you may want to check.',
    ),
    h(
      'div',
      { class: 'ov-grid' },
      status === undefined
        ? null
        : overviewCard({
            test: 'overview-backups',
            title: 'Backups',
            status: pill(
              BACKUP_STATE[status.state].label,
              BACKUP_STATE[status.state].tone,
              'overview-backup-state',
            ),
            text: backupsText(status, ui),
            actions: [
              backUpNow(ui, 'overview-backup-run'),
              button('Manage', go('backups'), { test: 'overview-open-backups' }),
            ],
          }),
      overviewCard({
        test: 'overview-agents',
        title: 'Agent access',
        status: pill(
          `${String(active.length)} connected`,
          risky ? 'warn' : 'neutral',
          'overview-agent-count',
        ),
        text: agentsText(active),
        actions: button('Review access', go('agents'), {
          test: 'overview-open-agents',
          primary: true,
        }),
      }),
      overviewCard({
        test: 'overview-notifications',
        title: 'Notifications',
        status: pill('On', 'good'),
        text:
          quiet.quietHours.length === 0
            ? 'Pop-ups only for things that need you. No quiet hours are set.'
            : `Pop-ups only for things that need you. Quiet from ${quietText(quiet)}${blocksText(quiet)}.`,
        actions: button('Manage', go('notifications'), { test: 'overview-open-notifications' }),
      }),
      overviewCard({
        test: 'overview-ai',
        title: 'AI',
        status: pill('Off', 'neutral'),
        text: AI_OFF,
        actions: button('Details', go('ai'), { test: 'overview-open-ai' }),
      }),
    ),
  );
}

function notificationsView(quiet: QuietTimes, open: boolean, ui: Ui): VNode {
  return h(
    'div',
    { test: 'notifications' },
    pageHead(
      'Notifications',
      'Only things that need you pop up on your desktop. Progress, retries and routine syncs wait quietly in the app.',
    ),
    card(
      null,
      row({
        label: 'Pop-ups',
        help: 'Always on in this version.',
        value: [pill('On', 'good'), h('span', { class: 'vtext' }, 'Only for things that need you')],
      }),
      row({
        test: 'quiet-hours',
        label: 'Quiet hours',
        help: 'Pop-ups that come due wait and arrive together when quiet hours end. Set during setup.',
        value:
          quiet.quietHours.length === 0
            ? h('span', { class: 'muted' }, 'None set')
            : `${quietText(quiet)}${blocksText(quiet)}`,
      }),
      advanced(
        {
          test: 'notifications-advanced',
          title: 'Advanced',
          summary: 'Exactly what pops up.',
          open,
          toggle: toggler(ui, 'notifications'),
        },
        () => [
          row({
            label: 'Pops up for',
            help: 'Everything else waits in the app.',
            value: h(
              'ul',
              { class: 'plain-list' },
              PUSHED.map((entry) => h('li', { test: `pushed-${entry.kind}` }, entry.label)),
            ),
          }),
        ],
      ),
    ),
  );
}

function aiView(open: boolean, ui: Ui): VNode {
  return h(
    'div',
    { test: 'ai-placeholder' },
    pageHead('AI', AI_OFF),
    card(
      null,
      row({
        label: 'AI features',
        help: 'Nothing is sent to an AI service.',
        value: pill('Off', 'neutral'),
      }),
      advanced(
        {
          test: 'ai-advanced',
          title: 'Advanced',
          summary: 'What arrives later, and how it is switched on.',
          open,
          toggle: toggler(ui, 'ai'),
        },
        () => [
          row({
            label: 'Coming later',
            value:
              'Summaries before meetings, drafting from notes and email, and a second opinion on claimed work.',
          }),
          row({
            label: 'Switching it on',
            value:
              'AI stays off until you turn it on here, one workstream at a time, with the provider you choose.',
          }),
        ],
      ),
    ),
  );
}

export const settingsScreen: Screen<SettingsState> = {
  async load(ui, route: AppRoute) {
    const section: SettingsSection =
      route.screen === 'settings' ? (route.tab ?? 'overview') : 'overview';
    switch (section) {
      case 'overview': {
        const [backupStatus, principals, quiet] = await Promise.all([
          ui.call<BackupStatus>('backups.status', {}),
          loadPrincipals(ui),
          loadQuiet(ui),
        ]);
        return { section, backupStatus, principals, quiet };
      }
      case 'backups':
        return { section, backups: await loadBackups(ui) };
      case 'agents':
        return { section, principals: await loadPrincipals(ui) };
      case 'notifications':
        return { section, quiet: await loadQuiet(ui) };
      case 'ai':
        return { section };
    }
  },
  view(state, ui) {
    const open = openPanels(ui);
    const body =
      state.section === 'backups' && state.backups !== undefined
        ? backupsView(state.backups, open.backups, toggler(ui, 'backups'), ui)
        : state.section === 'agents'
          ? agentsView(state.principals ?? [], open.agents, toggler(ui, 'agents'), ui)
          : state.section === 'notifications'
            ? notificationsView(
                state.quiet ?? { quietHours: [], hardBlocks: 0 },
                open.notifications,
                ui,
              )
            : state.section === 'ai'
              ? aiView(open.ai, ui)
              : overviewView(state, ui);
    return h(
      'section',
      { class: 'screen settings' },
      h(
        'div',
        { class: 'settings-layout' },
        h('div', { class: 'settings-side' }, h('h1', null, 'Settings'), menu(state.section, ui)),
        h('div', { class: 'settings-page' }, body),
      ),
    );
  },
};
