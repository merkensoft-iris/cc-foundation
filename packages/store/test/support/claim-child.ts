/**
 * One claim command in a process that can be killed in the middle of it (AC-03-07).
 *
 * The parent runs this with `--kill-after <n>`; the child seeds a store, then kills itself
 * with SIGKILL immediately after the nth write statement of the claim transaction. Nothing
 * in packages/store/src knows about this: the child patches better-sqlite3's own `run` in
 * its own process, so the store code under test is exactly the shipped code.
 *
 * It reports by writing marker files in the profile directory with `writeFileSync`, not on
 * stdout: a pipe can still hold buffered output when SIGKILL lands, and Windows has no exit
 * signal to read. `armed` means the claim transaction started; `committed` means it returned.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ActionItem, Actor } from '@cc/schemas';

interface Options {
  readonly profileDir: string;
  /** Kill after this many write statements; 0 never kills, -1 kills just after COMMIT. */
  readonly killAfter: number;
}

function parseArgs(argv: readonly string[]): Options {
  const value = (flag: string): string => {
    const index = argv.indexOf(flag);
    const found = index === -1 ? undefined : argv[index + 1];
    if (found === undefined) throw new Error(`missing ${flag}`);
    return found;
  };
  return { profileDir: value('--profile-dir'), killAfter: Number(value('--kill-after')) };
}

const options = parseArgs(process.argv.slice(2));

/** Durable before the next line runs, so a SIGKILL cannot lose it. */
function mark(name: string, content = ''): void {
  writeFileSync(join(options.profileDir, `${name}.marker`), content);
}

const WRITE = /^\s*(?:INSERT|UPDATE|DELETE)\b/i;
let armed = false;
let writes = 0;

const Database = (await import('better-sqlite3')).default;
const statementPrototype = Object.getPrototypeOf(new Database(':memory:').prepare('SELECT 1')) as {
  run: (...args: unknown[]) => unknown;
};
const run = statementPrototype.run;
statementPrototype.run = function patched(this: { source: string }, ...args: unknown[]): unknown {
  const result = run.apply(this, args);
  if (armed && WRITE.test(this.source)) {
    writes++;
    if (writes === options.killAfter) process.kill(process.pid, 'SIGKILL');
  }
  return result;
};

const { openStore } = await import('@cc/store');
const { seedReferenceWorkspace } = await import('./reference.js');

const store = openStore({
  userDataDir: options.profileDir,
  now: () => '2026-11-13T09:00:00Z',
  env: {},
});
seedReferenceWorkspace(store);
mark('seeded');

const agent: Actor = { kind: 'agent', principalId: 'agt_cli_default', runId: 'run_03' };
const item: ActionItem = store.read((tx) => tx.require('action_items', 'act_a0142'));

mark('armed');
armed = true;
store.command({ actor: agent, correlationId: 'run_03' }, (tx) => {
  tx.update(
    'action_items',
    {
      ...item,
      lifecycle: 'claimed_done',
      claim: { at: '2026-11-12T05:01:00Z', by: agent, note: 'Sent and filed.' },
    },
    item.version,
  );
  tx.insert('evidence', {
    id: 'evd_a0142_claim',
    actionItemId: item.id,
    requirementId: 'er1',
    kind: 'note',
    summary: 'Claim note recorded with the claim',
    capturedAt: '2026-11-12T05:01:00Z',
    capturedBy: agent,
    version: 1,
  });
  tx.event({
    type: 'action_item.claimed',
    entity: { kind: 'action_item', id: item.id, ref: item.ref },
    before: { lifecycle: item.lifecycle },
    after: { lifecycle: 'claimed_done' },
  });
});
armed = false;

if (options.killAfter === -1) process.kill(process.pid, 'SIGKILL');
mark('committed', String(writes));
store.close();
