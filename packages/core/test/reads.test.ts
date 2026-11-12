/**
 * The read methods over the reference workspace (fixtures/records, 03 §13) in the profile's
 * store, called by the user (the app path) and by agent principals over the socket. "Now"
 * is 2026-11-13 09:02 in Asia/Kolkata, the 07 §4.3 example.
 */
import fs from 'node:fs';
import path from 'node:path';

import { FakeTimerClock } from '@cc/test-kit';
import { afterEach, describe, expect, it } from 'vitest';

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

/** A principal scoped to Alderwick only, with read. */
async function alderwickOnly(test: TestCore) {
  await test.core.principals.create(
    { kind: 'user' },
    { name: 'ald-reader', kind: 'mcp_client', scopes: ['read'], workstreamFilter: ['ws_ald'] },
  );
  return test.connect('ald-reader');
}

type Rows<K extends string> = Record<K, { ref: string }[]> & { total: number };
const refs = (rows: { ref: string }[]) => rows.map((row) => row.ref);

describe('items.list and items.get (04 §4.1, 07 §4.2)', () => {
  it('C-03-03 items.list and items.get never return records of a sensitive workstream to an agent principal whose scope excludes it', async () => {
    const test = await start();
    const cli = await test.connect();
    // cli-default sees all workstreams but has no sensitiveAccess (07 §5).
    const agent = await cli.call<Rows<'items'>>('items.list', {});
    expect(refs(agent.items)).toEqual(['A-0142', 'A-0144', 'A-0160']);
    expect(agent.total).toBe(3);
    const error = await rejection(cli.call('items.get', { ref: 'A-0152' }));
    expect(error.code).toBe('E_NOT_FOUND');
    expect((await rejection(cli.call('items.get', { ref: 'act_a0152' }))).code).toBe('E_NOT_FOUND');

    // The user sees the sensitive item; so does a principal granted sensitiveAccess.
    const user = (await test.core.callAsUser('items.list', {})) as Rows<'items'>;
    expect(refs(user.items)).toEqual(['A-0142', 'A-0144', 'A-0160', 'A-0152']);
    await test.core.principals.update({ kind: 'user' }, 'cli-default', { sensitiveAccess: true });
    expect((await cli.call<Rows<'items'>>('items.list', {})).total).toBe(4);
  });

  it('a workstream filter limits every list and get to its workstreams (07 §5)', async () => {
    const test = await start();
    const reader = await alderwickOnly(test);
    expect(refs((await reader.call<Rows<'items'>>('items.list', {})).items)).toEqual([
      'A-0142',
      'A-0160',
    ]);
    expect((await rejection(reader.call('items.get', { ref: 'A-0144' }))).code).toBe('E_NOT_FOUND');
    const workstreams = await reader.call<{ workstreams: { slug: string }[] }>(
      'workstreams.list',
      {},
    );
    expect(workstreams.workstreams.map((w) => w.slug)).toEqual(['alderwick']);
    expect(
      (await rejection(reader.call('items.list', { workstream: 'private-project' }))).code,
    ).toBe('E_NOT_FOUND');
    const measures = await reader.call<Rows<'measures'>>('measures.list', {});
    expect(refs(measures.measures)).toEqual(['K-0003', 'K-0006']);
    const goals = await reader.call<Rows<'goals'>>('goals.list', {});
    expect(refs(goals.goals)).toEqual(['G-0004']);
  });

  it('filters by state, workstream, owner, health and due date, with the optional fields and the display state', async () => {
    const test = await start();
    const list = (params: object) =>
      test.core.callAsUser('items.list', params) as Promise<
        Rows<'items'> & { items: Record<string, unknown>[] }
      >;
    expect((await list({ state: 'waiting' })).items.map((i) => i['ref'])).toEqual([
      'A-0142',
      'A-0144',
    ]);
    expect((await list({ workstream: 'alderwick' })).total).toBe(2);
    expect((await list({ owner: 'me' })).total).toBe(3);
    expect((await list({ owner: 'Client contact' })).items.map((i) => i['ref'])).toEqual([
      'A-0152',
    ]);
    expect((await list({ dueBefore: '2026-11-19' })).total).toBe(2);
    expect((await list({ health: 'off_track' })).total).toBe(0);
    expect((await list({ limit: 1 })).items).toHaveLength(1);
    expect((await list({ limit: 1 })).total).toBe(4);
    // A-0142 was due 2026-11-12 and is not claimed: overdue, and listed first (07 §4.3).
    const [first] = (await list({ fields: ['owner', 'health', 'carry', 'workstream'] })).items;
    expect(first).toEqual({
      ref: 'A-0142',
      title: 'Send revised proposal with phased pricing to the consulting lead',
      due: '2026-11-12',
      state: 'overdue',
      owner: 'self',
      health: 'on_track',
      carry: 0,
      workstream: 'alderwick',
    });
    expect((await rejection(list({ owner: 'nobody' }))).code).toBe('E_NOT_FOUND');
  });

  it('items.get returns the full record by ref or ID', async () => {
    const test = await start();
    const cli = await test.connect();
    const byRef = await cli.call<{ item: { id: string } }>('items.get', { ref: 'A-0142' });
    const byId = await cli.call<{ item: { ref: string } }>('items.get', { ref: 'act_a0142' });
    expect(byRef.item.id).toBe('act_a0142');
    expect(byId.item.ref).toBe('A-0142');
    expect((await rejection(cli.call('items.get', { ref: 'A-9999' }))).code).toBe('E_NOT_FOUND');
  });
});

describe('home.get (07 §4.3)', () => {
  it('gives the local time, attention counts and the 3 most urgent items, overdue first', async () => {
    const test = await start();
    const cli = await test.connect();
    const home = await cli.call<Record<string, unknown>>('home.get', {});
    expect(home).toEqual({
      workspace: 'main',
      now: '2026-11-13T09:02:00+05:30',
      today: [],
      attention: {
        overdue: 1,
        atRisk: 0,
        awaitingReview: 0,
        confirmationsPending: 1,
        sessionsNeedingYou: 0,
      },
      items: [
        expect.objectContaining({ ref: 'A-0142', state: 'overdue' }),
        expect.objectContaining({ ref: 'A-0144', state: 'waiting' }),
        expect.objectContaining({ ref: 'A-0160', state: 'in_progress' }),
      ],
      counts: { dueSoon: 3, open: 3 },
    });
    // One workstream only.
    const ald = await cli.call<{ counts: { open: number } }>('home.get', {
      workstream: 'alderwick',
    });
    expect(ald.counts.open).toBe(2);
  });

  it('a claimed item leaves the due-soon list and waits for review', async () => {
    const test = await start();
    const cli = await test.connect();
    await cli.call('items.claim', { ref: 'A-0142', evidence: [sentMessage()] });
    const home = await cli.call<{
      attention: { awaitingReview: number; overdue: number };
      counts: { dueSoon: number };
    }>('home.get', {});
    expect(home.attention).toMatchObject({ awaitingReview: 1, overdue: 0 });
    expect(home.counts.dueSoon).toBe(2);
  });
});

describe('items.history (C-03-04)', () => {
  it('C-03-04 lists an item’s events and its evidence’s, oldest first, with their actors', async () => {
    const test = await start();
    const cli = await test.connect();
    await cli.call('items.claim', { ref: 'A-0142', evidence: [sentMessage()] });
    const history = await cli.call<{
      events: { type: string; actor: { kind: string } }[];
      total: number;
    }>('items.history', { ref: 'A-0142' });
    expect(history.events.map((event) => [event.type, event.actor.kind])).toEqual([
      ['action_item.created', 'user'],
      ['evidence.added', 'agent'],
      ['action_item.claimed', 'agent'],
    ]);
    expect(history.total).toBe(3);
    const limited = await cli.call<{ events: unknown[]; total: number }>('items.history', {
      ref: 'A-0142',
      limit: 1,
    });
    expect(limited).toMatchObject({ total: 3 });
    expect(limited.events).toHaveLength(1);
    expect((await rejection(cli.call('items.history', { ref: 'A-0152' }))).code).toBe(
      'E_NOT_FOUND',
    );
  });
});

describe('search.query (03 §12 fts_items)', () => {
  it('finds items, decisions and issues by text, and never a record the caller may not see', async () => {
    const test = await start();
    const cli = await test.connect();
    const proposal = await cli.call<{ hits: { type: string; ref: string }[]; total: number }>(
      'search.query',
      { text: 'proposal' },
    );
    expect(proposal.hits.map((hit) => [hit.type, hit.ref])).toContainEqual(['items', 'A-0142']);
    const scheduler = await cli.call<{ hits: { type: string; ref: string }[] }>('search.query', {
      text: 'scheduler',
      types: ['decisions'],
    });
    expect(scheduler.hits.map((hit) => [hit.type, hit.ref])).toEqual([['decisions', 'D-0008']]);
    // The seed files A-0152 under the synthetic sensitive project (helpers.ts).
    const statement = await cli.call<{ total: number }>('search.query', { text: 'statement' });
    expect(statement.total).toBe(0);
    const asUser = (await test.core.callAsUser('search.query', { text: 'statement' })) as {
      hits: { ref: string }[];
    };
    expect(refs(asUser.hits)).toContain('A-0152');
  });
});

describe('decisions, issues, measures, goals and workstreams (07 §4.2)', () => {
  it('lists and gets each with its summary fields', async () => {
    const test = await start();
    const cli = await test.connect();
    expect(await cli.call('decisions.list', {})).toEqual({
      decisions: [
        expect.objectContaining({ ref: 'D-0008', status: 'open', question: expect.any(String) }),
      ],
      total: 1,
    });
    expect((await cli.call<Rows<'decisions'>>('decisions.list', { status: 'decided' })).total).toBe(
      0,
    );
    expect(
      (await cli.call<{ decision: { id: string } }>('decisions.get', { ref: 'D-0008' })).decision
        .id,
    ).toMatch(/^dec_/);

    expect(await cli.call('issues.list', { status: 'resolved' })).toEqual({
      issues: [expect.objectContaining({ ref: 'I-0012', status: 'resolved' })],
      total: 1,
    });
    expect((await cli.call<Rows<'issues'>>('issues.list', { status: 'open' })).total).toBe(0);
    expect(
      (await cli.call<{ issue: { ref: string } }>('issues.get', { ref: 'I-0012' })).issue.ref,
    ).toBe('I-0012');

    const measures = await cli.call<{
      measures: { ref: string; latest?: { periodStart: string } }[];
    }>('measures.list', {});
    expect(measures.measures.find((m) => m.ref === 'K-0003')?.latest).toMatchObject({
      periodStart: '2026-11-09',
    });
    expect(
      (await cli.call<{ measure: { ref: string } }>('measures.get', { ref: 'K-0006' })).measure.ref,
    ).toBe('K-0006');

    // G-0002 is the client engagement's (sensitive); G-0004's 2026-Q4 period holds 2026-11-13.
    expect(refs((await cli.call<Rows<'goals'>>('goals.list', {})).goals)).toEqual(['G-0004']);
    expect((await cli.call<Rows<'goals'>>('goals.list', { period: 'previous' })).total).toBe(0);
    expect((await rejection(cli.call('goals.get', { ref: 'G-0002' }))).code).toBe('E_NOT_FOUND');

    const workstreams = await cli.call<{ workstreams: { slug: string }[]; total: number }>(
      'workstreams.list',
      {},
    );
    expect(workstreams.workstreams.map((w) => w.slug)).toEqual([
      'alderwick',
      'quillmarsh',
      'workspace',
    ]);
    expect(
      (
        await cli.call<{ workstream: { id: string } }>('workstreams.get', {
          workstream: 'alderwick',
        })
      ).workstream.id,
    ).toBe('ws_ald');
    expect(
      (await rejection(cli.call('workstreams.get', { workstream: 'private-project' }))).code,
    ).toBe('E_NOT_FOUND');
  });

  it('a principal without the read scope gets E_FORBIDDEN on every read', async () => {
    const test = await start();
    await test.core.principals.create(
      { kind: 'user' },
      { name: 'claim-only', kind: 'external_framework', scopes: ['items:claim'] },
    );
    const client = await test.connect('claim-only');
    for (const method of ['home.get', 'items.list', 'decisions.list', 'workstreams.list']) {
      expect((await rejection(client.call(method, {}))).code, method).toBe('E_FORBIDDEN');
    }
  });
});

describe('export.run (03 §12 point 6, C-03-06)', () => {
  it('C-03-06 exports every table and the manifest for the user, and refuses a principal that does not see every record', async () => {
    const test = await start();
    const out = path.join(test.profile.path, 'export');
    const result = (await test.core.callAsUser('export.run', { out })) as {
      out: string;
      manifest: string;
      tables: number;
    };
    expect(result.out).toBe(out);
    expect(result.tables).toBeGreaterThan(10);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, result.manifest), 'utf8')) as {
      tables: { table: string; rows: number }[];
    };
    expect(manifest.tables.find((t) => t.table === 'action_items')?.rows).toBe(4);
    // Tokens are files, never in the export.
    const token = fs.readFileSync(
      path.join(test.core.userData, 'run', 'tokens', 'cli-default.token'),
      'utf8',
    );
    for (const file of fs.readdirSync(path.join(out, 'tables'))) {
      expect(fs.readFileSync(path.join(out, 'tables', file), 'utf8')).not.toContain(token.trim());
    }

    const cli = await test.connect();
    const refused = await rejection(cli.call('export.run', { out: path.join(out, '2') }));
    expect(refused.code).toBe('E_FORBIDDEN');
    expect(fs.existsSync(path.join(out, '2'))).toBe(false);
    expect((await rejection(test.core.callAsUser('export.run', { out: 'relative' }))).code).toBe(
      'E_USAGE',
    );
  });
});
