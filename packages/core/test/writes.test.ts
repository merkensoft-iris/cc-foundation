/**
 * The write methods over the reference workspace in the profile's store, through the domain
 * (P1-03): drafts, health, evidence, decisions, issues and measure values. "Now" is
 * 2026-11-13 09:02 in Asia/Kolkata (07 §4.3).
 */
import { FakeTimerClock } from '@cc/test-kit';
import { afterEach, describe, expect, it } from 'vitest';

import { periodStart } from '../src/handlers/writes.js';
import { rejection, sentMessage, startTestCore, type TestCore } from './helpers.js';

const NOW = '2026-11-13T03:32:00Z';

let open: TestCore[] = [];
afterEach(async () => {
  for (const test of open) await test.dispose();
  open = [];
});

async function start(): Promise<TestCore> {
  const test = await startTestCore({ seed: true, clock: new FakeTimerClock(NOW) });
  open.push(test);
  return test;
}

interface Item {
  ref: string;
  lifecycle: string;
  health: string;
  version: number;
  createdBy: unknown;
  due: { date: string; timeZone: string };
  evidenceRequirements: { id: string; description: string; required: boolean }[];
}

const DRAFT = {
  workstream: 'alderwick',
  title: 'Send the audit checklist to the new lead',
  due: '2026-11-20',
  doneMeans: 'The checklist is sent from the Alderwick mailbox.',
  evidence: ['The sent message'],
};

describe('items.create (03 §7, 07 §4.2)', () => {
  it('creates a draft with the next ref, from an agent or the user, with one event each', async () => {
    const test = await start();
    const cli = await test.connect();
    const agent = { kind: 'agent', principalId: cli.principal.id };
    const created = await cli.call<{ status: string; item: Item }>('items.create', DRAFT);
    expect(created).toMatchObject({
      status: 'ok',
      item: {
        ref: 'A-0143',
        lifecycle: 'draft',
        createdBy: agent,
        due: { date: '2026-11-20', timeZone: 'Asia/Kolkata' },
        evidenceRequirements: [{ id: 'er1', description: 'The sent message', required: true }],
      },
    });
    // From the app the item is a draft too: the schema creates drafts for the user to accept.
    // The reference counter says A-0144 is next, but A-0144 exists: the ref skips it.
    const byUser = (await test.core.callAsUser('items.create', {
      ...DRAFT,
      owner: 'Client contact',
    })) as {
      item: Item & { ownerId: string };
    };
    expect(byUser.item).toMatchObject({ ref: 'A-0145', lifecycle: 'draft' });
    expect(byUser.item.ownerId).toBe('per_client');
    expect(test.itemEvents().map((event) => [event.type, event.actor])).toEqual([
      ['action_item.created', agent],
      ['action_item.created', { kind: 'user' }],
    ]);
    // The workspace counter moved in the same transactions (03 §5.1).
    const workspace = test.core.store.read((tx) => tx.get('workspace', 'wsp_main'));
    expect(workspace?.counters.A).toBe(146);
  });

  it('refuses a workstream the agent cannot see, a meeting that is not stored, and a principal without items:write', async () => {
    const test = await start();
    const cli = await test.connect();
    const hidden = await rejection(
      cli.call('items.create', { ...DRAFT, workstream: 'private-project' }),
    );
    expect(hidden.code).toBe('E_NOT_FOUND');
    const meeting = await rejection(cli.call('items.create', { ...DRAFT, meeting: 'M-0031' }));
    expect(meeting.code).toBe('E_NOT_FOUND');
    await test.core.principals.create(
      { kind: 'user' },
      { name: 'reader', kind: 'mcp_client', scopes: ['read'] },
    );
    const reader = await test.connect('reader');
    expect((await rejection(reader.call('items.create', DRAFT))).code).toBe('E_FORBIDDEN');
    expect(test.itemEvents()).toEqual([]);
  });
});

describe('items.update (07 §4.2, 03 §7 health rules)', () => {
  it('sets health with a note; the same again is a no-op; only the user lowers health', async () => {
    const test = await start();
    const cli = await test.connect();
    const set = (health: object, version?: number) =>
      cli.call<{ status: string; item: Item }>('items.update', {
        ref: 'A-0160',
        health,
        ...(version === undefined ? {} : { version }),
      });
    const first = await set({ value: 'at_risk', note: 'The scheduler is down' });
    expect(first).toMatchObject({ status: 'ok', item: { health: 'at_risk' } });
    expect((await set({ value: 'at_risk', note: 'The scheduler is down' })).status).toBe('no-op');
    // INV-03-03: off_track needs a note.
    const noNote = await rejection(set({ value: 'off_track' }));
    expect(noNote.code).toBe('E_INVARIANT');
    expect(noNote.help[0]).toBe('INV-03-03');
    // Health rule 3: an agent does not lower health back to on_track.
    expect((await rejection(set({ value: 'on_track' }))).code).toBe('E_INVARIANT');
    const lowered = (await test.core.callAsUser('items.update', {
      ref: 'A-0160',
      health: { value: 'on_track' },
    })) as { item: Item };
    expect(lowered.item.health).toBe('on_track');
    // A stale version fails E_CONFLICT (03 §12).
    const stale = await rejection(set({ value: 'at_risk', note: 'again' }, first.item.version));
    expect(stale.code).toBe('E_CONFLICT');
  });

  it('C-03-04 records a proposed due date in the item’s history and leaves the item unchanged (owner decision, 12 Nov 2026)', async () => {
    const test = await start();
    const cli = await test.connect();
    const before = await cli.call<{ item: Item }>('items.get', { ref: 'A-0160' });
    const propose = () =>
      cli.call<{ status: string; item: Item }>('items.update', {
        ref: 'A-0160',
        proposeDue: { date: '2026-11-26', reason: 'The client moved the launch' },
      });
    const proposed = await propose();
    expect(proposed.status).toBe('ok');
    // The item keeps its due date and version: re-planning stays the user's, in the app.
    expect(proposed.item).toEqual(before.item);
    const history = await cli.call<{
      events: { type: string; actor: unknown; after: unknown }[];
    }>('items.history', { ref: 'A-0160' });
    expect(history.events.at(-1)).toMatchObject({
      type: 'action_item.due_proposed',
      actor: { kind: 'agent', principalId: cli.principal.id },
      after: {
        due: before.item.due.date,
        proposedDue: { date: '2026-11-26', timeZone: before.item.due.timeZone },
        reason: 'The client moved the launch',
      },
    });
    // The same proposal again records nothing; so does proposing the date it already has.
    expect((await propose()).status).toBe('no-op');
    const current = await cli.call<{ status: string }>('items.update', {
      ref: 'A-0160',
      proposeDue: { date: before.item.due.date, reason: 'No change' },
    });
    expect(current.status).toBe('no-op');
    expect(test.itemEvents().map((event) => event.type)).toEqual(['action_item.due_proposed']);
    // A principal without items:write cannot propose.
    await test.core.principals.create(
      { kind: 'user' },
      { name: 'reader', kind: 'mcp_client', scopes: ['read'] },
    );
    const reader = await test.connect('reader');
    const refused = await rejection(
      reader.call('items.update', {
        ref: 'A-0160',
        proposeDue: { date: '2026-11-27', reason: 'Later' },
      }),
    );
    expect(refused.code).toBe('E_FORBIDDEN');
  });
});

describe('evidence.add (07 §4.2 items attach)', () => {
  it('attaches evidence once; a claim can then use it without new evidence (C-03-01)', async () => {
    const test = await start();
    const cli = await test.connect();
    const added = await cli.call<{ status: string; evidence: { id: string } }>('evidence.add', {
      ref: 'A-0142',
      evidence: sentMessage(),
    });
    expect(added.status).toBe('ok');
    const again = await cli.call<{ status: string; evidence: { id: string } }>('evidence.add', {
      ref: 'A-0142',
      evidence: sentMessage(),
    });
    expect(again).toEqual({ status: 'no-op', evidence: added.evidence });
    const claimed = await cli.call<{ item: Item }>('items.claim', { ref: 'A-0142', evidence: [] });
    expect(claimed.item.lifecycle).toBe('claimed_done');
    // A requirement that does not accept the kind is refused (03 §9.1).
    const wrong = await rejection(
      cli.call('evidence.add', {
        ref: 'A-0160',
        evidence: { kind: 'note', text: 'posted', requirementId: 'nope' },
      }),
    );
    expect(wrong.code).toBe('E_INVARIANT');
  });
});

describe('decisions.propose and issues.raise (03 §10, §11)', () => {
  it('proposes a decision only with decisions:propose; the decider is a person', async () => {
    const test = await start();
    const cli = await test.connect();
    // cli-default lacks decisions:propose (07 §5 table).
    const refused = await rejection(
      cli.call('decisions.propose', { workstream: 'alderwick', question: 'Which CRM?' }),
    );
    expect(refused.code).toBe('E_FORBIDDEN');
    await test.core.principals.create(
      { kind: 'user' },
      { name: 'claude-code', kind: 'mcp_client', scopes: ['read', 'decisions:propose'] },
    );
    const mcp = await test.connect('claude-code');
    const proposed = await mcp.call<{
      status: string;
      decision: { ref: string; status: string; deciderId: string; options: { text: string }[] };
    }>('decisions.propose', {
      workstream: 'alderwick',
      question: 'Which CRM should Alderwick use?',
      options: ['Keep the spreadsheet', 'A hosted CRM'],
      dueBy: '2026-11-20',
    });
    expect(proposed).toMatchObject({
      status: 'ok',
      decision: { ref: 'D-0009', status: 'proposed', deciderId: 'per_self' },
    });
    expect(proposed.decision.options.map((option) => option.text)).toEqual([
      'Keep the spreadsheet',
      'A hosted CRM',
    ]);
  });

  it('raises an issue with items:write', async () => {
    const test = await start();
    const cli = await test.connect();
    const raised = await cli.call<{ status: string; issue: { ref: string; status: string } }>(
      'issues.raise',
      { workstream: 'alderwick', title: 'The posting scheduler keeps failing' },
    );
    expect(raised).toMatchObject({ status: 'ok', issue: { ref: 'I-0013', status: 'open' } });
    const stored = test.core.store.read((tx) => tx.list('issues')).map((issue) => issue.ref);
    expect(stored).toContain('I-0013');
    // The same open issue again is a no-op (07 §4.4).
    const again = await cli.call<{ status: string; issue: { ref: string } }>('issues.raise', {
      workstream: 'alderwick',
      title: 'The posting scheduler keeps failing',
    });
    expect(again).toMatchObject({ status: 'no-op', issue: { ref: 'I-0013' } });
  });
});

describe('measures.record (03 §5.4)', () => {
  it('records a manual value for the period that holds the date, replacing the period’s value', async () => {
    const test = await start();
    await test.core.principals.update({ kind: 'user' }, 'cli-default', {
      scopes: ['read', 'measures:write'],
    });
    const cli = await test.connect();
    // K-0003 is weekly; 2026-11-13 is in the week of Monday 2026-11-09, which has a value.
    const recorded = await cli.call<{
      status: string;
      value: { id: string; periodStart: string; value: number; normal: boolean | null };
    }>('measures.record', { ref: 'K-0003', value: 2 });
    expect(recorded).toMatchObject({
      status: 'ok',
      value: { id: 'mv_k0003_2026w46', periodStart: '2026-11-09', value: 2, normal: null },
    });
    expect(
      (await cli.call<{ status: string }>('measures.record', { ref: 'K-0003', value: 2 })).status,
    ).toBe('no-op');
    const next = await cli.call<{ value: { periodStart: string } }>('measures.record', {
      ref: 'K-0003',
      value: 1,
      period: '2026-11-17',
    });
    expect(next.value.periodStart).toBe('2026-11-16');
    const history = test.core.store.read((tx) => tx.history('measure_value', 'mv_k0003_2026w46'));
    expect(history.map((event) => event.type)).toEqual([
      'measure_value.created',
      'measure_value.recorded',
    ]);

    // K-0006 is derived: its values are computed, not recorded by hand.
    const derived = await rejection(cli.call('measures.record', { ref: 'K-0006', value: 80 }));
    expect(derived.code).toBe('E_INVARIANT');
    expect(
      (await rejection(cli.call('measures.record', { ref: 'K-0003', value: true }))).code,
    ).toBe('E_USAGE');
  });

  it('maps a date to the start of its period', () => {
    expect(periodStart('daily', '2026-11-13')).toBe('2026-11-13');
    expect(periodStart('weekly', '2026-11-13')).toBe('2026-11-09');
    expect(periodStart('weekly', '2026-11-09')).toBe('2026-11-09');
    expect(periodStart('weekly', '2026-11-15')).toBe('2026-11-09');
    expect(periodStart('monthly', '2026-11-13')).toBe('2026-11-01');
    expect(periodStart('quarterly', '2026-11-13')).toBe('2026-10-01');
    expect(periodStart('quarterly', '2027-02-28')).toBe('2027-01-01');
  });
});
