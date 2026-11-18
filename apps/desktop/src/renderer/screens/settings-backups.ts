/**
 * Settings → Backups (04 §9.1, 09 P1-17): the state, "Last good backup", the last restore
 * test, the passphrase and the folder destination, back up now and test now, and the history
 * with the human-only Restore (C-04-10: the core backs up the current store first, then
 * restarts on the restored one).
 *
 * The passphrase goes to main, which derives the key and keeps it in the system keychain; it
 * never reaches the core (04 §9.1 rule 3).
 */
import type { BackupRecord, BackupStatus } from '../app/api.js';
import { act, errorText, type Ui } from '../app/screen.js';
import { button, chip, field, section, table } from '../ui/parts.js';
import { h, type VNode } from '../ui/vnode.js';

export interface BackupsState {
  readonly status: BackupStatus;
  readonly history: readonly BackupRecord[];
  readonly total: number;
}

export interface BackupsForm {
  passphrase: string;
  confirm: string;
  label: string;
  path: string;
  /** The archive whose Restore is waiting for the second click. */
  confirming?: string | undefined;
}

const STATE_TONE = {
  ok: 'good',
  warning: 'warn',
  failing: 'bad',
  not_configured: 'neutral',
} as const;
const STATE_LABEL = {
  ok: 'ok',
  warning: 'warning',
  failing: 'failing',
  not_configured: 'not configured',
} as const;

export function when(instant: string): string {
  return `${instant.slice(0, 16).replace('T', ' ')} UTC`;
}

export async function loadBackups(ui: Ui): Promise<BackupsState> {
  const [status, list] = await Promise.all([
    ui.call<BackupStatus>('backups.status', {}),
    ui.call<{ backups: BackupRecord[]; total: number }>('backups.list', { limit: 30 }),
  ]);
  return { status, history: list.backups, total: list.total };
}

export function backupsForm(ui: Ui): BackupsForm {
  return ui.keep<BackupsForm>('backups-form', () => ({
    passphrase: '',
    confirm: '',
    label: '',
    path: '',
  }));
}

function statusView(status: BackupStatus): VNode {
  const test = status.lastRestoreTest;
  return h(
    'div',
    { test: 'backup-status' },
    h(
      'p',
      null,
      'State: ',
      h(
        'span',
        { test: 'backup-state' },
        chip(STATE_LABEL[status.state], STATE_TONE[status.state]),
      ),
    ),
    h(
      'p',
      { test: 'backup-last-good' },
      'Last good backup: ',
      status.lastGood === undefined
        ? 'none yet'
        : `${when(status.lastGood.at)} · ${status.lastGood.destination}`,
    ),
    h(
      'p',
      { test: 'backup-last-test' },
      'Last restore test: ',
      test === undefined
        ? 'not run yet'
        : [
            `${when(test.at)} `,
            test.ok ? chip('passed', 'good') : chip('failed', 'bad'),
            ` ${test.detail}`,
          ],
    ),
    status.reasons.length === 0
      ? null
      : h(
          'ul',
          { class: 'list', test: 'backup-reasons' },
          status.reasons.map((reason) => h('li', null, reason)),
        ),
  );
}

function copies(record: BackupRecord): string {
  const local = record.local.pruned === true ? 'pruned' : record.local.ok ? 'kept' : 'failed';
  const off =
    record.offMachine === undefined
      ? 'off'
      : record.offMachine.pruned === true
        ? 'pruned'
        : record.offMachine.ok
          ? record.offMachine.destination
          : `failed: ${record.offMachine.error ?? 'unknown'}`;
  return `this computer: ${local} · off-machine: ${off}`;
}

function restorable(record: BackupRecord): boolean {
  if (record.verified?.ok === false) return false;
  return (
    (record.local.ok && record.local.pruned !== true) ||
    (record.offMachine?.ok === true && record.offMachine.pruned !== true)
  );
}

function historyView(state: BackupsState, form: BackupsForm, ui: Ui): VNode {
  return table(
    ['When', 'Why', 'Copies', 'Restore test', ''],
    state.history.map((record) =>
      h(
        'tr',
        { test: `backup-${record.id}` },
        h('td', null, when(record.at)),
        h('td', null, record.trigger.replace('_', ' ')),
        h('td', null, copies(record)),
        h(
          'td',
          null,
          record.verified === undefined
            ? ''
            : record.verified.ok
              ? chip('passed', 'good')
              : chip('failed', 'bad'),
        ),
        h(
          'td',
          null,
          !restorable(record)
            ? null
            : form.confirming === record.id
              ? h(
                  'span',
                  { class: 'prompt', test: `restore-confirm-${record.id}` },
                  'Command Center backs up the current data first, then restores this backup and restarts. ',
                  button(
                    'Restore now',
                    () => {
                      form.confirming = undefined;
                      void act(
                        ui,
                        () => ui.call('backups.restore', { id: record.id }),
                        `Restoring the backup of ${when(record.at)}; the current data was backed up first.`,
                      );
                    },
                    { test: `restore-now-${record.id}`, primary: true },
                  ),
                  ' ',
                  button(
                    'Cancel',
                    () => {
                      form.confirming = undefined;
                      ui.render();
                    },
                    { test: `restore-cancel-${record.id}` },
                  ),
                )
              : button(
                  'Restore',
                  () => {
                    form.confirming = record.id;
                    ui.render();
                  },
                  { test: `restore-${record.id}` },
                ),
        ),
      ),
    ),
    'No backups yet. The first one runs today, or now with Back up now.',
  );
}

function passphraseForm(status: BackupStatus, form: BackupsForm, ui: Ui): VNode {
  return h(
    'div',
    { class: 'form', test: 'backup-passphrase-form' },
    h(
      'p',
      { class: 'muted' },
      'Every archive is encrypted with a key made from this passphrase. Command Center cannot recover a lost one: keep it somewhere safe. ',
      'Until it is set, backups stay on this computer.',
    ),
    status.passphraseSet ? chip('passphrase set', 'good') : chip('not set'),
    field('Passphrase', form.passphrase, (value) => (form.passphrase = value), {
      type: 'password',
      test: 'settings-backup-passphrase',
    }),
    field('Passphrase again', form.confirm, (value) => (form.confirm = value), {
      type: 'password',
      test: 'settings-backup-passphrase-confirm',
    }),
    button(
      status.passphraseSet ? 'Change passphrase' : 'Set passphrase',
      () => {
        if (form.passphrase !== form.confirm) {
          ui.flash('The two passphrases differ.', 'error');
          return;
        }
        const passphrase = form.passphrase;
        void (async () => {
          const ok = await act(
            ui,
            () => ui.call('backups.passphrase', { passphrase }),
            'Backup passphrase set. The next backup is tested with it.',
          );
          if (ok) {
            form.passphrase = '';
            form.confirm = '';
            ui.render();
          }
        })();
      },
      { test: 'settings-backup-passphrase-set' },
    ),
  );
}

function destinationForm(status: BackupStatus, form: BackupsForm, ui: Ui): VNode {
  return h(
    'div',
    { class: 'form', test: 'backup-destination-form' },
    h(
      'p',
      { class: 'muted' },
      'Encrypted archives are copied to this folder: a synced folder such as Google Drive or Dropbox, a NAS or a USB disk. ',
      'Only finished, encrypted archives go there, never the live database. Google Drive and S3 arrive with their connectors.',
    ),
    status.destination === undefined ? chip('no destination') : chip(status.destination, 'good'),
    field('Label', form.label, (value) => (form.label = value), {
      test: 'settings-backup-label',
      placeholder: 'Synced folder',
    }),
    field('Folder', form.path, (value) => (form.path = value), {
      test: 'settings-backup-path',
      placeholder: '/Users/you/Google Drive/Command Center',
    }),
    h(
      'div',
      { class: 'actions' },
      button(
        'Set destination',
        () => {
          const label = form.label.trim();
          const path = form.path.trim();
          if (label === '' || path === '') {
            ui.flash('A destination needs a label and a folder.', 'error');
            return;
          }
          void act(
            ui,
            () => ui.call('backups.destination', { destination: { kind: 'folder', label, path } }),
            `Backups are copied to ${label} from the next one on.`,
          );
        },
        { test: 'settings-backup-destination-set' },
      ),
      status.destination === undefined
        ? null
        : button(
            'Remove destination',
            () =>
              void act(
                ui,
                () => ui.call('backups.destination', { destination: null }),
                'Backups now stay on this computer only.',
              ),
            { test: 'settings-backup-destination-clear' },
          ),
    ),
  );
}

export function backupsView(state: BackupsState, ui: Ui): VNode {
  const form = backupsForm(ui);
  return h(
    'div',
    { test: 'backups' },
    statusView(state.status),
    h(
      'div',
      { class: 'actions' },
      button(
        'Back up now',
        () => void act(ui, () => ui.call('backups.run', {}), 'Backup written.'),
        { test: 'backup-run', primary: true },
      ),
      button(
        'Test restore now',
        () =>
          void (async () => {
            try {
              const result = await ui.call<{ test: { ok: boolean; detail: string } }>(
                'backups.test',
                {},
              );
              ui.flash(
                result.test.ok
                  ? 'The restore test passed.'
                  : `The restore test failed: ${result.test.detail}`,
                result.test.ok ? 'ok' : 'error',
              );
            } catch (error) {
              ui.flash(errorText(error), 'error');
            }
            await ui.reload();
          })(),
        { test: 'backup-test' },
      ),
    ),
    section(
      `History (${String(state.history.length)} of ${String(state.total)})`,
      historyView(state, form, ui),
    ),
    section('Passphrase', passphraseForm(state.status, form, ui)),
    section('Off-machine destination', destinationForm(state.status, form, ui)),
  );
}
