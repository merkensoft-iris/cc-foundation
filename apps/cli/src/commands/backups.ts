/**
 * `cc-axi backups status` (07 §4.2, 04 §9.1 rule 8): the backup state, the last good backup
 * and the last restore test. Running a backup, the restore test and restoring are human-only
 * and stay in the app (04 §4.1, §4.3): the CLI has no command for them.
 */
import type { methods } from '@cc/schemas';

import type { Handler, ResultOf } from './common.js';

type StatusResult = ResultOf<typeof methods.backupsStatus>;

export const backupsStatus: Handler = async (_parsed, session) => {
  const api = await session.api();
  const status = await api.call<StatusResult>('backups.status', {});
  const output: Record<string, unknown> = {
    backups: {
      state: status.state,
      last_good:
        status.lastGood === undefined
          ? 'none'
          : `${status.lastGood.at} ${status.lastGood.destination}`,
      last_good_off_machine: status.lastGoodOffMachineAt ?? 'none',
      destination: status.destination ?? 'none',
      passphrase_set: status.passphraseSet,
    },
    last_restore_test:
      status.lastRestoreTest === undefined
        ? 'none'
        : {
            at: status.lastRestoreTest.at,
            ok: status.lastRestoreTest.ok,
            detail: status.lastRestoreTest.detail,
          },
  };
  if (status.reasons.length > 0) output['reasons'] = status.reasons;
  if (status.state !== 'ok') {
    output['help'] = ['Backups are run, tested and restored in the app: Settings → Backups'];
  }
  return output;
};
