/**
 * AC-03-07: killing the app process during a claim transaction leaves either no change or
 * the full change (projection and event), never one without the other.
 *
 * The test is not a thought experiment about SQLite's atomicity: it runs the real claim
 * command in a real child process and sends that process SIGKILL after each write statement
 * of the transaction in turn, then reopens the store and checks the three halves of the
 * change agree - the action item's lifecycle, its evidence row and its `action_item.claimed`
 * event. Nothing in packages/store/src knows the test exists; the child patches
 * better-sqlite3 in its own process (packages/store/test/support/claim-child.ts).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createProfileDir } from '@cc/test-kit';
import { openStore } from '@cc/store';

// --import takes a module specifier: on Windows an absolute path is not a valid one.
const HOOK = new URL('./support/ts-hook.mjs', import.meta.url).href;
const CHILD = fileURLToPath(new URL('./support/claim-child.ts', import.meta.url));

interface Run {
  readonly killed: boolean;
  readonly writes?: number;
}

/**
 * Runs the claim in a child process, killing it after `killAfter` write statements. The
 * child reports with marker files rather than stdout, because SIGKILL can discard output
 * still buffered in the pipe, and because Windows terminates a process without a signal.
 */
function claim(profileDir: string, killAfter: number): Run {
  const result = spawnSync(
    process.execPath,
    ['--import', HOOK, CHILD, '--profile-dir', profileDir, '--kill-after', String(killAfter)],
    { encoding: 'utf8', timeout: 120_000 },
  );
  const marker = (name: string): string | undefined => {
    const path = join(profileDir, `${name}.marker`);
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  };
  if (marker('armed') === undefined) {
    throw new Error(
      `the claim child never reached the transaction (status ${String(result.status)}, ` +
        `signal ${String(result.signal)}):\n${result.stderr}`,
    );
  }
  const committed = marker('committed');
  if (committed === undefined) {
    // It died inside the transaction, or just after COMMIT, which is what the test asked for.
    expect(result.status === 0 && result.signal === null).toBe(false);
    return { killed: true };
  }
  if (result.status !== 0) {
    throw new Error(`claim child failed (${String(result.status)}):\n${result.stderr}`);
  }
  return { killed: false, writes: Number(committed) };
}

interface Outcome {
  readonly lifecycle: string;
  readonly hasEvidence: boolean;
  readonly hasEvent: boolean;
  readonly version: number;
}

/** What the store holds after the process died, read the way the app reads it on restart. */
function outcome(profileDir: string): Outcome {
  const store = openStore({ userDataDir: profileDir, now: () => '2026-11-13T09:00:00Z', env: {} });
  try {
    return store.read((tx) => {
      const item = tx.require('action_items', 'act_a0142');
      return {
        lifecycle: item.lifecycle,
        version: item.version,
        hasEvidence: tx.get('evidence', 'evd_a0142_claim') !== undefined,
        hasEvent: tx
          .history('action_item', 'act_a0142')
          .some((event) => event.type === 'action_item.claimed'),
      };
    });
  } finally {
    store.close();
  }
}

describe('a claim transaction', { timeout: 240_000 }, () => {
  it('AC-03-07 killing the app process mid-claim leaves no change or the full change', () => {
    const profile = createProfileDir();
    let writes: number;
    try {
      const committed = claim(profile.path, 0);
      expect(committed.killed).toBe(false);
      writes = committed.writes ?? 0;
      expect(writes).toBeGreaterThan(1);
      expect(outcome(profile.path)).toEqual({
        lifecycle: 'claimed_done',
        hasEvidence: true,
        hasEvent: true,
        version: 5,
      });
    } finally {
      profile.cleanup();
    }

    // Kill after each write statement of the transaction in turn, and once after COMMIT.
    for (const killAfter of [...Array.from({ length: writes }, (_, i) => i + 1), -1]) {
      const run = createProfileDir();
      try {
        const result = claim(run.path, killAfter);
        expect(
          result.killed,
          `kill-after ${String(killAfter)} should have killed the process`,
        ).toBe(true);
        const after = outcome(run.path);
        const halves = [after.lifecycle === 'claimed_done', after.hasEvidence, after.hasEvent];
        expect(
          new Set(halves).size,
          `kill-after ${String(killAfter)} left a partial claim: ${JSON.stringify(after)}`,
        ).toBe(1);
        if (killAfter === -1) expect(halves).toEqual([true, true, true]);
        else expect(halves).toEqual([false, false, false]);
        expect(after.version).toBe(halves[0] === true ? 5 : 4);
      } finally {
        run.cleanup();
      }
    }
  });
});
