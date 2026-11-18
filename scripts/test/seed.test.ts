/** pnpm cc:seed (08 §6; 09 P1-15): the reference scenario in a profile directory. */
import { describe, expect, it } from 'vitest';

import { createProfileDir } from '@cc/test-kit';

import { parseSeedArgs, runSeed, USAGE } from '../seed.ts';

describe('cc:seed', { timeout: 60_000 }, () => {
  it('seeds the reference scenario on 2026-11-04 and refuses to seed the same profile again', async () => {
    const profile = createProfileDir();
    try {
      const args = ['--scenario', 'reference', '--profile-dir', profile.path];
      const first = await runSeed(args, {});
      expect(first.exitCode).toBe(0);
      expect(first.lines[0]).toBe(
        `cc:seed: the reference scenario is seeded in ${profile.path}, on 2026-11-04 09:40 Asia/Kolkata`,
      );
      expect(first.lines.join('\n')).toMatch(
        /3 workstreams, 6 meeting series, \d{3} meeting instances/,
      );
      expect(first.lines.at(-1)).toBe(
        '  worked examples: A-0142 is A-0001, A-0144 is A-0002, A-0160 is A-0003, D-0008 is D-0001, R-0002 is R-0001',
      );

      const again = await runSeed(args, {});
      expect(again.exitCode).toBe(1);
      expect(again.lines.join('\n')).toMatch(
        /E_CONFLICT.*\n(?:.*\n)*.*new, empty profile directory/,
      );
    } finally {
      profile.cleanup();
    }
  });

  it('takes --today, and exits 2 with the usage line on a bad argument', async () => {
    expect(
      parseSeedArgs(['--scenario=reference', '--profile-dir', 'p', '--today', '2026-11-11']),
    ).toMatchObject({
      scenario: 'reference',
      today: '2026-11-11',
    });
    for (const argv of [
      [],
      ['--scenario', 'reference'],
      ['--scenario', 'other', '--profile-dir', 'p'],
      ['--scenario', 'reference', '--profile-dir', 'p', '--today', '11/04/2026'],
      ['--scenario', 'reference', '--profile-dir', 'p', '--force'],
    ]) {
      const run = await runSeed(argv, {});
      expect(run.exitCode, argv.join(' ')).toBe(2);
      expect(run.lines.at(-1)).toBe(USAGE);
    }
  });
});
