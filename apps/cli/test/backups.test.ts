/**
 * `cc-axi backups status` in-process against the real core in headless mode (07 §4.2,
 * 04 §9.1 rule 8). Running, testing and restoring are human-only and have no command.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createProfileDir, type ProfileDir } from '@cc/test-kit';

import { COMMANDS } from '../src/spec.ts';
import { cli } from './support/run.ts';
import { startTestCore, type TestCore } from './support/core.ts';

const SLOW_MS = 60_000;

const opened: { profile: ProfileDir; core: TestCore }[] = [];
afterEach(async () => {
  for (const { profile, core } of opened.splice(0)) {
    await core.close();
    profile.cleanup();
  }
});

describe('cc-axi backups status', { timeout: SLOW_MS }, () => {
  it('C-04-10 shows the state, the last good backup and the last restore test; nothing runs or restores from the CLI', async () => {
    const profile = createProfileDir();
    const core = await startTestCore({ profileDir: profile.path });
    opened.push({ profile, core });
    const run = await cli(profile.path, ['backups', 'status']);
    expect(run.code).toBe(0);
    expect(run.output['backups']).toEqual({
      state: 'not_configured',
      last_good: 'none',
      last_good_off_machine: 'none',
      destination: 'none',
      passphrase_set: false,
    });
    expect(run.output['last_restore_test']).toBe('none');
    expect(run.output['help']).toEqual([
      'Backups are run, tested and restored in the app: Settings → Backups',
    ]);
    const paths = COMMANDS.map((command) => command.path).filter((path) =>
      path.startsWith('backups'),
    );
    expect(paths).toEqual(['backups status']);
  });
});
