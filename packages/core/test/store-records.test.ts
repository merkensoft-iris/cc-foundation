import { claimItem } from '@cc/domain';
import type { Evidence } from '@cc/schemas';
import { FakeTimerClock } from '@cc/test-kit';
import { afterEach, describe, expect, it } from 'vitest';

import { domainContext } from '../src/domain.js';
import { LAST_USED_RESOLUTION_MS } from '../src/principals.js';
import { rejection, sentMessage, startTestCore, type TestCore } from './helpers.js';

let open: TestCore[] = [];
afterEach(async () => {
  for (const test of open) await test.dispose();
  open = [];
});

async function start(options: Parameters<typeof startTestCore>[0] = {}): Promise<TestCore> {
  const test = await startTestCore(options);
  open.push(test);
  return test;
}

const user = { actor: { kind: 'user' as const } };

const er1: Evidence = {
  id: 'evd_a0142_er1',
  actionItemId: 'act_a0142',
  requirementId: 'er1',
  kind: 'connector_record',
  summary: 'Sent message',
  record: { bindingId: 'bnd_gmail_ald', recordType: 'message', externalId: 'm1' },
  capturedAt: '2026-11-12T05:00:00Z',
  capturedBy: { kind: 'user' },
};

describe('the core on the workspace store (03 §12, P1-02)', () => {
  it('commits a command’s writes with their events, and rolls back a write on a stale version', async () => {
    const clock = new FakeTimerClock('2026-11-12T05:30:00Z');
    const { core, itemEvents } = await start({ seed: true, clock });
    const records = core.records;
    // Two commands read A-0142 at the same version; the second commits after the first.
    const read = records.read((view) => view.item('A-0142'));
    if (read === undefined) throw new Error('fixture missing');
    const claimOn = () =>
      records.command(user.actor, (view) => {
        const outcome = claimItem(domainContext(view, clock), user, read, [er1]);
        return { result: outcome.status, changes: outcome.changes };
      });
    expect(claimOn()).toBe('ok');
    expect(records.read((view) => view.item('A-0142'))?.version).toBe(read.version + 1);
    expect(() => claimOn()).toThrow(/version 5, not the expected 4/);
    expect(itemEvents().map((event) => event.type)).toEqual(['action_item.claimed']);
  });

  it('hands out HumanRefs from the workspace counters, with an event, in the command', async () => {
    const { core } = await start({ seed: true });
    const refs = core.records.command(user.actor, (view) => ({
      result: [view.nextRef('A'), view.nextRef('A'), view.nextRef('D')],
      changes: [],
    }));
    // The reference workspace's counters hold the next numbers: A 143, D 9. A-0144 is
    // already taken by a record, so the counter skips it.
    expect(refs).toEqual(['A-0143', 'A-0145', 'D-0009']);
    const workspace = core.store.read((tx) => tx.get('workspace', 'wsp_main'));
    expect(workspace?.counters).toMatchObject({ A: 146, D: 10 });
    const events = core.store.read((tx) => tx.history('workspace', 'wsp_main'));
    expect(events.map((event) => event.type)).toEqual([
      'workspace.created',
      'workspace.counter_advanced',
      'workspace.counter_advanced',
      'workspace.counter_advanced',
    ]);
  });

  it('finds an item by ref or ID, and a binding by label or ID with its installed actions', async () => {
    const { core } = await start({ seed: true });
    core.records.read((view) => {
      expect(view.item('act_a0142')?.ref).toBe('A-0142');
      expect(view.item('A-9999')).toBeUndefined();
      expect(view.binding('gmail-alderwick')).toEqual({
        id: 'bnd_gmail_ald',
        label: 'gmail-alderwick',
        actions: ['search_messages', 'create_draft', 'send_draft'],
      });
      expect(view.binding('bnd_gmail_ald')?.label).toBe('gmail-alderwick');
      expect(view.selfPersonId).toBe('per_self');
    });
  });

  it('a profile without a workspace answers E_NOT_FOUND, not an internal error', async () => {
    const test = await start();
    const cli = await test.connect();
    const error = await rejection(
      cli.call('items.claim', { ref: 'A-0142', evidence: [sentMessage()] }),
    );
    expect(error.code).toBe('E_NOT_FOUND');
  });

  it('keeps principals in agent_principals with one event per change, never the token', async () => {
    const clock = new FakeTimerClock('2026-11-12T05:30:00Z');
    const test = await start({ clock });
    const { core } = test;
    const created = await core.principals.create(
      { kind: 'user' },
      { name: 'claude-code', kind: 'mcp_client', scopes: ['read'] },
    );
    await core.principals.update({ kind: 'user' }, 'claude-code', {
      scopes: ['read', 'items:claim'],
    });
    await core.principals.revoke({ kind: 'user' }, 'claude-code');
    // The name is given out again on the same row (names are unique).
    const again = await core.principals.create(
      { kind: 'user' },
      { name: 'claude-code', kind: 'mcp_client', scopes: ['read'] },
    );
    expect(again.id).toBe(created.id);
    expect(again.revokedAt).toBeUndefined();

    const history = core.store.read((tx) => tx.history('agent_principal', created.id));
    expect(history.map((event) => [event.type, event.actor])).toEqual([
      ['agent_principal.created', { kind: 'user' }],
      ['agent_principal.updated', { kind: 'user' }],
      ['agent_principal.revoked', { kind: 'user' }],
      ['agent_principal.created', { kind: 'user' }],
    ]);
    const token = (await import('../src/tokens.js')).readToken(core.userData, 'claude-code');
    expect(JSON.stringify(history)).not.toContain(token);
    const cliDefault = await core.principals.get('cli-default');
    expect(
      core.store
        .read((tx) => tx.history('agent_principal', cliDefault?.id ?? ''))
        .map((e) => e.actor),
    ).toEqual([{ kind: 'system', component: 'migration' }]);
  });

  it('writes lastUsedAt at most once a minute per principal', async () => {
    const clock = new FakeTimerClock('2026-11-12T05:30:00Z');
    const test = await start({ clock });
    const used = async () => {
      (await test.connect()).close();
      const principal = await test.core.principals.get('cli-default');
      return test.core.store
        .read((tx) => tx.history('agent_principal', principal?.id ?? ''))
        .filter((event) => event.type === 'agent_principal.used').length;
    };
    expect(await used()).toBe(1);
    expect(await used()).toBe(1);
    await clock.advance(LAST_USED_RESOLUTION_MS);
    expect(await used()).toBe(2);
    expect((await test.core.principals.get('cli-default'))?.lastUsedAt).toBe(
      '2026-11-12T05:31:00.000Z',
    );
  });

  it('a restart reopens the same store: records and principals persist', async () => {
    const test = await start({ seed: true, subdir: 'profile' });
    const cli = await test.connect();
    await cli.call('items.claim', { ref: 'A-0142', evidence: [sentMessage()] });
    cli.close();
    const id = (await test.core.principals.get('cli-default'))?.id;
    await test.core.stop();

    const { startCore } = await import('../src/service.js');
    const again = await startCore({ userData: test.core.userData, env: {} });
    try {
      expect((await again.principals.get('cli-default'))?.id).toBe(id);
      expect(again.store.read((tx) => tx.get('action_items', 'act_a0142'))?.lifecycle).toBe(
        'claimed_done',
      );
    } finally {
      await again.stop();
    }
  });
});
