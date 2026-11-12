/**
 * AC-03-02 over the real local API: socket, endpoint record, mutual-proof handshake, scope
 * check, human-only gate, and the domain's claim (P1-03) committed with its events in the
 * profile's workspace store (P1-02), seeded from the fixtures.
 */
import { FakeTimerClock } from '@cc/test-kit';
import { afterEach, describe, expect, it } from 'vitest';

import { rejection, sentMessage, startTestCore, type TestCore } from './helpers.js';

let open: TestCore[] = [];
afterEach(async () => {
  for (const test of open) await test.dispose();
  open = [];
});

interface Claimed {
  status: string;
  item: { ref: string; lifecycle: string; claim?: { by: unknown }; waitingOn?: unknown };
  evidence: { record?: { bindingId: string }; capturedBy: unknown }[];
}

describe('AC-03-02 claims by agents, confirmation only by the user', () => {
  it('AC-03-02 an agent with items:claim claims A-0142 with evidence; a confirm from any CLI or MCP principal fails with E_HUMAN_REQUIRED and the item deep link', async () => {
    const clock = new FakeTimerClock('2026-11-12T05:30:00Z');
    const test = await startTestCore({ seed: true, clock });
    open.push(test);
    await test.core.principals.create(
      { kind: 'user' },
      { name: 'claude-code', kind: 'mcp_client', scopes: ['read', 'items:write', 'items:claim'] },
    );

    // cli-default (kind cli) has items:claim from install (07 §5).
    const cli = await test.connect('cli-default');
    expect(cli.principal.scopes).toContain('items:claim');
    const agent = { kind: 'agent', principalId: cli.principal.id };
    const claimed = await cli.call<Claimed>('items.claim', {
      ref: 'A-0142',
      evidence: [sentMessage()],
    });
    expect(claimed).toMatchObject({
      status: 'ok',
      item: { ref: 'A-0142', lifecycle: 'claimed_done', claim: { by: agent } },
      evidence: [{ record: { bindingId: 'bnd_gmail_ald' }, capturedBy: agent }],
    });
    expect(claimed.item.waitingOn).toBeUndefined();
    // The evidence and the claim are committed together, one event each (INV-03-09).
    expect(test.itemEvents().map((event) => [event.type, event.actor])).toEqual([
      ['evidence.added', agent],
      ['action_item.claimed', agent],
    ]);

    // C-03-01: the same claim again is a no-op and writes nothing.
    const again = await cli.call<Claimed>('items.claim', {
      ref: 'A-0142',
      evidence: [sentMessage()],
    });
    expect(again.status).toBe('no-op');
    expect(test.itemEvents()).toHaveLength(2);

    const mcp = await test.connect('claude-code');
    for (const client of [cli, mcp]) {
      const error = await rejection(client.call('items.confirm', { ref: 'A-0142' }));
      expect(error.code).toBe('E_HUMAN_REQUIRED');
      expect(error.help).toContain('Do this in the app: commandcenter://items/A-0142');
      expect(error.help).toContain('Run `cc-axi open A-0142`');
    }
    // Attest and reject are refused the same way (INV-03-07).
    for (const method of ['items.attest', 'items.reject']) {
      expect((await rejection(mcp.call(method, { ref: 'A-0142' }))).code).toBe('E_HUMAN_REQUIRED');
    }
    // Nothing the refused calls did reached the records: A-0142 waits for the user.
    const stored = test.core.store.read((tx) => tx.get('action_items', 'act_a0142'));
    expect(stored).toMatchObject({ lifecycle: 'claimed_done', claim: { by: agent } });
    expect(test.itemEvents()).toHaveLength(2);
  });

  it('AC-03-02 a claim without evidence for a required requirement fails with E_EVIDENCE_MISSING', async () => {
    const test = await startTestCore({ seed: true });
    open.push(test);
    const cli = await test.connect();
    const error = await rejection(cli.call('items.claim', { ref: 'A-0142', evidence: [] }));
    expect(error.code).toBe('E_EVIDENCE_MISSING');
    expect(error.help).toEqual(['03 §9.2', 'er1']);
    const stored = test.core.store.read((tx) => tx.get('action_items', 'act_a0142'));
    expect(stored?.lifecycle).toBe('waiting');
    expect(test.itemEvents()).toEqual([]);
  });
});
