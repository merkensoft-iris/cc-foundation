/**
 * Settings → Backups (04 §9.1, 09 P1-17). The basics: the state in words with the last backup
 * and Back up now; the backup password; the second copy (the folder destination). Advanced:
 * the past backups with the human-only Restore (C-04-10: the core backs up the current store
 * first, then restarts on the restored one), the restore check with Check now, and what is
 * kept.
 *
 * The password is typed in the app shell's own window, never on this screen: main derives the
 * key and keeps it in the system keychain, and it never reaches the core (04 §9.1 rule 3). The
 * second copy's folder is chosen in the system's folder picker (04 §9.1 rule 5). Restore is a
 * Tier H operation: this screen explains it, and the user confirms it in the app shell's
 * confirm window (C-04-12).
 */
import type { BackupRecord, BackupStatus } from '../app/api.js';
import { act, actInWindow, errorText, IN_WINDOW, waitingInWindow, type Ui } from '../app/screen.js';
import { button, inWindowNote, link } from '../ui/parts.js';
import { h, type VNode } from '../ui/vnode.js';
import {
  advanced,
  ago,
  card,
  confirmPanel,
  fields,
  input,
  pageHead,
  pill,
  row,
  type Tone,
} from './settings-parts.js';

export interface BackupsState {
  readonly status: BackupStatus;
  readonly history: readonly BackupRecord[];
  readonly total: number;
}

export interface BackupsForm {
  label: string;
  /** The archive whose Restore is explained, before the shell confirms it. */
  confirming?: string | undefined;
  /** Change… opened the second-copy form. */
  changingDestination: boolean;
}

/** The backup state in plain words (README glossary) and its tone. */
export const BACKUP_STATE: Readonly<
  Record<BackupStatus['state'], { readonly label: string; readonly tone: Tone }>
> = {
  ok: { label: 'Protected', tone: 'good' },
  warning: { label: 'Needs attention', tone: 'warn' },
  failing: { label: 'Not working', tone: 'bad' },
  not_configured: { label: 'Only on this computer', tone: 'neutral' },
};

/** An instant as Home shows it: "2026-11-12 18:00 UTC". */
export function when(instant: string): string {
  return `${instant.slice(0, 16).replace('T', ' ')} UTC`;
}

export async function loadBackups(ui: Ui): Promise<BackupsState> {
  const [status, list] = await Promise.all([
    ui.call('backups.status', {}),
    ui.call('backups.list', { limit: 30 }),
  ]);
  return { status, history: list.backups, total: list.total };
}

export function backupsForm(ui: Ui): BackupsForm {
  return ui.keep<BackupsForm>('backups-form', () => ({
    label: '',
    changingDestination: false,
  }));
}

/** Back up now: the human-only run (04 §9.1 rule 1), from the page or the Overview. */
export function backUpNow(ui: Ui, test: string): VNode {
  return button(
    'Back up now',
    () => void act(ui, () => ui.call('backups.run', {}), 'Backup written.'),
    { test, primary: true },
  );
}

/** "Last backup 3 hours ago · Synced folder", or "No backup yet". */
export function lastBackup(status: BackupStatus, now: number): string {
  return status.lastGood === undefined
    ? 'No backup yet'
    : `Last backup ${ago(status.lastGood.at, now)} · ${status.lastGood.destination}`;
}

function statusRow(status: BackupStatus, ui: Ui): VNode {
  const state = BACKUP_STATE[status.state];
  return row({
    test: 'backup-status',
    label: 'Status',
    help: 'A backup runs every day after your daily shutdown, and before updates.',
    value: [
      h('span', { test: 'backup-state' }, pill(state.label, state.tone)),
      h(
        'span',
        {
          class: 'vtext',
          test: 'backup-last-good',
          ...(status.lastGood === undefined ? {} : { title: when(status.lastGood.at) }),
        },
        lastBackup(status, ui.now()),
      ),
    ],
    action: backUpNow(ui, 'backup-run'),
    below:
      status.reasons.length === 0
        ? null
        : h(
            'ul',
            { class: 'reasons', test: 'backup-reasons' },
            status.reasons.map((reason) => h('li', null, reason)),
          ),
  });
}

/** Set password…: the app shell asks for it in its own window (04 §9.1 rule 3). */
export function setPassphrase(ui: Ui, key: string): Promise<boolean> {
  return actInWindow(
    ui,
    key,
    () => ui.call('backups.passphrase', {}),
    'Backup password set. The next backup is checked with it.',
  );
}

function passphraseRow(status: BackupStatus, ui: Ui): VNode {
  const waiting = waitingInWindow(ui, 'backup-passphrase');
  return row({
    test: 'backup-passphrase-form',
    label: 'Backup password',
    help: 'Locks every backup. Command Center cannot recover a lost one, so keep it somewhere safe. You type it in Command Center’s own window, not on this page.',
    value: waiting
      ? inWindowNote(IN_WINDOW.secret, 'backup-passphrase-in-window')
      : status.passphraseSet
        ? pill('Set', 'good', 'backup-passphrase-state')
        : h(
            'span',
            { class: 'vtext muted', test: 'backup-passphrase-state' },
            'Not set: backups stay on this computer until it is.',
          ),
    action: waiting
      ? null
      : button(
          status.passphraseSet ? 'Change password…' : 'Set password…',
          () => void setPassphrase(ui, 'backup-passphrase'),
          { test: 'settings-backup-passphrase-set', primary: !status.passphraseSet },
        ),
  });
}

/** Choose folder…: the app shell asks for it in the system folder picker (04 §9.1 rule 5). */
export function chooseDestination(ui: Ui, key: string, label: string): Promise<boolean> {
  return actInWindow(
    ui,
    key,
    () => ui.call('backups.destination', { destination: { kind: 'folder', label } }),
    `Backups are copied to ${label} from the next one on.`,
  );
}

function destinationRow(status: BackupStatus, form: BackupsForm, ui: Ui): VNode {
  const open = status.destination === undefined || form.changingDestination;
  const waiting = waitingInWindow(ui, 'backup-destination');
  return row({
    test: 'backup-destination-form',
    label: 'Second copy',
    help: 'A folder such as Google Drive, Dropbox, a NAS or a USB disk. Only locked backups go there, never your live data.',
    value: waiting
      ? inWindowNote(IN_WINDOW.folder, 'backup-destination-in-window')
      : open
        ? [
            fields(
              input('Name', form.label, (value) => (form.label = value), {
                test: 'settings-backup-label',
                placeholder: 'Synced folder',
              }),
            ),
            status.destination === undefined
              ? null
              : h(
                  'span',
                  { class: 'link-action' },
                  link(
                    'Stop copying: keep backups on this computer only',
                    () => {
                      form.changingDestination = false;
                      void act(
                        ui,
                        () => ui.call('backups.destination', { destination: null }),
                        'Backups now stay on this computer only.',
                      );
                    },
                    'settings-backup-destination-clear',
                  ),
                ),
          ]
        : h('span', { test: 'backup-destination' }, status.destination ?? ''),
    action: waiting
      ? null
      : open
        ? [
            button(
              'Choose folder…',
              () => {
                const label = form.label.trim();
                if (label === '') {
                  ui.flash('Name the second copy first, such as Synced folder.', 'error');
                  return;
                }
                void (async () => {
                  if (await chooseDestination(ui, 'backup-destination', label)) {
                    form.changingDestination = false;
                    ui.render();
                  }
                })();
              },
              { test: 'settings-backup-destination-set' },
            ),
            status.destination === undefined
              ? null
              : button(
                  'Cancel',
                  () => {
                    form.changingDestination = false;
                    ui.render();
                  },
                  { test: 'settings-backup-destination-cancel' },
                ),
          ]
        : button(
            'Change…',
            () => {
              form.changingDestination = true;
              ui.render();
            },
            { test: 'settings-backup-destination-change' },
          ),
  });
}

const TRIGGER: Readonly<Record<BackupRecord['trigger'], string>> = {
  scheduled: 'Scheduled',
  manual: 'Back up now',
  pre_migration: 'Before an upgrade',
  pre_update: 'Before an update',
  pre_restore: 'Before a restore',
};

function copies(record: BackupRecord): string {
  const local = record.local.pruned === true ? 'removed' : record.local.ok ? 'kept' : 'failed';
  const off =
    record.offMachine === undefined
      ? 'none'
      : record.offMachine.pruned === true
        ? 'removed'
        : record.offMachine.ok
          ? record.offMachine.destination
          : `failed: ${record.offMachine.error ?? 'unknown'}`;
  return `This computer: ${local} · second copy: ${off}`;
}

function restorable(record: BackupRecord): boolean {
  if (record.verified?.ok === false) return false;
  return (
    (record.local.ok && record.local.pruned !== true) ||
    (record.offMachine?.ok === true && record.offMachine.pruned !== true)
  );
}

function historyView(state: BackupsState, form: BackupsForm, ui: Ui): VNode {
  if (state.history.length === 0) {
    return h(
      'p',
      { class: 'empty' },
      'No backups yet. The first one runs today, or now with Back up now.',
    );
  }
  const rows = state.history.flatMap((record) => [
    h(
      'tr',
      { test: `backup-${record.id}` },
      h('td', { class: 'nowrap' }, when(record.at)),
      h('td', { class: 'nowrap' }, TRIGGER[record.trigger]),
      h('td', null, copies(record)),
      h(
        'td',
        { class: 'nowrap' },
        record.verified === undefined
          ? ''
          : record.verified.ok
            ? pill('Passed', 'good')
            : pill('Failed', 'bad'),
      ),
      h(
        'td',
        { class: 'act' },
        restorable(record)
          ? button(
              'Restore…',
              () => {
                form.confirming = record.id;
                ui.render();
              },
              { test: `restore-${record.id}` },
            )
          : null,
      ),
    ),
    waitingInWindow(ui, `restore-${record.id}`)
      ? h(
          'tr',
          { class: 'confirm-row' },
          h(
            'td',
            { colspan: '5' },
            inWindowNote(IN_WINDOW.confirm, `restore-in-window-${record.id}`),
          ),
        )
      : null,
    form.confirming === record.id && restorable(record)
      ? h(
          'tr',
          { class: 'confirm-row' },
          h(
            'td',
            { colspan: '5' },
            confirmPanel({
              test: `restore-confirm-${record.id}`,
              question: `Restore the backup from ${when(record.at)}?`,
              detail:
                'Command Center backs up the current data first, then restores this backup and restarts. You confirm it in Command Center’s own window next.',
              confirm: 'Restore now…',
              confirmTest: `restore-now-${record.id}`,
              cancelTest: `restore-cancel-${record.id}`,
              onConfirm: () => {
                form.confirming = undefined;
                void actInWindow(
                  ui,
                  `restore-${record.id}`,
                  () => ui.call('backups.restore', { id: record.id }),
                  `Restoring the backup of ${when(record.at)}; the current data was backed up first.`,
                );
              },
              onCancel: () => {
                form.confirming = undefined;
                ui.render();
              },
            }),
          ),
        )
      : null,
  ]);
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'set-table' },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', null, 'When'),
          h('th', null, 'Why'),
          h('th', null, 'Copies'),
          h('th', { class: 'nowrap' }, 'Restore check'),
          h('th', null, ''),
        ),
      ),
      h('tbody', null, rows),
    ),
  );
}

function restoreCheckRow(status: BackupStatus, ui: Ui): VNode {
  const test = status.lastRestoreTest;
  return row({
    label: 'Restore check',
    help: 'Opens the newest backup and checks it is complete. It runs every 30 days by itself, and after a password or second-copy change.',
    value: h(
      'span',
      { test: 'backup-last-test' },
      test === undefined
        ? 'Not run yet'
        : [
            test.ok ? pill('Passed', 'good') : pill('Failed', 'bad'),
            ` ${when(test.at)}`,
            test.ok ? '' : `: ${test.detail}`,
          ],
    ),
    action: button(
      'Check now',
      () =>
        void (async () => {
          try {
            const result = await ui.call('backups.test', {});
            ui.flash(
              result.test.ok
                ? 'The restore check passed.'
                : `The restore check failed: ${result.test.detail}`,
              result.test.ok ? 'ok' : 'error',
            );
          } catch (error) {
            ui.flash(errorText(error), 'error');
          }
          await ui.reload();
        })(),
      { test: 'backup-test' },
    ),
  });
}

export function backupsView(state: BackupsState, open: boolean, toggle: () => void, ui: Ui): VNode {
  const form = backupsForm(ui);
  return h(
    'div',
    { test: 'backups' },
    pageHead(
      'Backups',
      'A locked copy of your work is made every day, so nothing is lost if this computer fails.',
    ),
    card(
      'backups-basic',
      statusRow(state.status, ui),
      passphraseRow(state.status, ui),
      destinationRow(state.status, form, ui),
      advanced(
        {
          test: 'backups-advanced',
          title: 'Advanced',
          summary: 'Past backups, restore, and the restore check.',
          open,
          toggle,
        },
        () => [
          h(
            'h3',
            { class: 'set-subhead' },
            `Past backups (${String(state.history.length)} of ${String(state.total)})`,
          ),
          historyView(state, form, ui),
          restoreCheckRow(state.status, ui),
          h(
            'p',
            { class: 'small muted' },
            'Kept: 7 daily and 4 weekly backups, here and in the second copy.',
          ),
        ],
      ),
    ),
  );
}
