/**
 * `cc-axi mcp`, the stdio MCP relay (04 §8, 07 §7, 09 P1-13), against the real core service
 * in headless mode: the 14 tools, their TOON results and errors, the connector tools' empty
 * results, the app-not-running behaviour, and AC-07-03.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { storeRhythmStore } from '@cc/core';
import { extendHorizon } from '@cc/rhythm';
import { MCP_TOOLS, MCP_TOOLS_BUDGET_BYTES, mcpToolList, type MeetingSeries } from '@cc/schemas';
import { createProfileDir, type ProfileDir } from '@cc/test-kit';

import { harness, scenarioPlacement, seriesById } from '../../../packages/rhythm/test/harness.ts';
import { humanOnlyMethodOf } from '../src/mcp/relay.js';
import { cli } from './support/run.ts';
import { startTestCore, type TestCore } from './support/core.ts';
import { spawnRelay, startRelay, type McpClient } from './support/mcp.ts';

const GENERATED = fileURLToPath(
  new URL('../../../packages/schemas/mcp/tools.json', import.meta.url),
);

/** The tools of the 07 §7 table, in its order. */
const TABLE = [
  'cc_home',
  'cc_search',
  'cc_list',
  'cc_get',
  'cc_create_action',
  'cc_update_action',
  'cc_claim',
  'cc_attach_evidence',
  'cc_propose_decision',
  'cc_meeting_capture',
  'cc_record_measure',
  'cc_connector_actions',
  'cc_connector_invoke',
  'cc_confirmation_status',
];

let profile: ProfileDir;
let core: TestCore;
const relays: McpClient[] = [];

function relay(principal = 'claude-code', env: NodeJS.ProcessEnv = {}): McpClient {
  const started = startRelay(profile.path, principal, env);
  relays.push(started);
  return started;
}

beforeEach(async () => {
  profile = createProfileDir();
  core = await startTestCore({ profileDir: profile.path });
});

afterEach(async () => {
  for (const open of relays.splice(0)) await open.close();
  await core.close();
  profile.cleanup();
});

/** The weekly CEO review series and its instances (02 §8.1), as the rhythm engine writes them. */
function withMeetings(): void {
  const store = core.core.store;
  const series: MeetingSeries[] = [seriesById('ser_ceo_weekly')];
  store.command({ actor: { kind: 'user' } }, (tx) => {
    for (const record of series) {
      tx.insert('meeting_series', record);
      tx.event({
        type: 'meeting_series.created',
        entity: { kind: 'meeting_series', id: record.id },
      });
    }
  });
  extendHorizon(storeRhythmStore(store), harness('2026-11-04T04:10:00Z').ctx, scenarioPlacement());
}

describe(
  'AC-07-03 a Claude Code session with the MCP server registered',
  { timeout: 60_000 },
  () => {
    it("AC-07-03 lists today's items, creates a draft item, and its attempt to confirm a claim returns E_HUMAN_REQUIRED with a deep link", async () => {
      // The registered command, started as its own process: cc-axi mcp --principal claude-code.
      const session = spawnRelay(profile.path, 'claude-code');
      relays.push(session);
      const hello = await session.initialize();
      expect(hello.result).toMatchObject({
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'command-center' },
      });
      const listed = await session.request('tools/list');
      expect((listed.result?.['tools'] as { name: string }[]).map((tool) => tool.name)).toEqual(
        TABLE,
      );

      // Today's items: the home view, and the active items due by today.
      const home = await session.call('cc_home');
      expect(home.isError).toBe(false);
      expect(home.output['items']).toEqual([
        expect.objectContaining({ ref: 'A-0162', state: 'overdue' }),
        expect.objectContaining({ ref: 'A-0142', state: 'overdue' }),
        expect.objectContaining({ ref: 'A-0150', state: 'open' }),
      ]);
      const today = await session.call('cc_list', { type: 'items', due_before: '2026-11-14' });
      expect(today.isError).toBe(false);
      expect(today.output['count']).toBe('2 of 2 active items due before 2026-11-14');

      // A draft item, recorded as the claude-code principal.
      const created = await session.call('cc_create_action', {
        workstream: 'alderwick',
        title: 'Send the signed SOW to the consulting lead',
        due: '2026-11-20',
        done_means: 'The signed SOW is in the client folder',
      });
      expect(created.isError).toBe(false);
      expect(created.output).toMatchObject({ status: 'ok', item: { state: 'draft' } });
      const ref = (created.output['item'] as { ref: string }).ref;
      const event = core.events().find((entry) => entry.type === 'action_item.created');
      expect(event?.actor).toEqual({ kind: 'agent', principalId: expect.stringMatching(/^agt_/) });
      const drafted = await cli(profile.path, ['items', 'view', ref]);
      expect(drafted.output['item']).toMatchObject({ ref, state: 'draft' });

      // It claims an item, then tries to confirm the claim itself.
      const claimed = await session.call('cc_claim', {
        ref: 'A-0150',
        evidence: ['https://example.com/notes/onboarding-checklist'],
      });
      expect(claimed.output).toMatchObject({ status: 'ok' });
      const confirm = await session.call('cc_confirm_claim', { ref: 'A-0150' });
      expect(confirm.isError).toBe(true);
      expect(confirm.output['code']).toBe('E_HUMAN_REQUIRED');
      expect(confirm.output['help']).toContain('Do this in the app: commandcenter://items/A-0150');
      // The refusal came from the core's gate, and the claim is still waiting for the user.
      expect(core.calls).toContain('items.confirm');
      const after = await cli(profile.path, ['items', 'view', 'A-0150']);
      expect(after.output['item']).toMatchObject({ state: 'claimed_done' });

      expect(await session.close()).toBe(0);
    });

    it('AC-07-03 every human-only attempt by tool name is refused with E_HUMAN_REQUIRED and a deep link (AC-04-04)', async () => {
      const session = relay();
      await session.initialize();
      const cases: [string, Record<string, unknown>, string][] = [
        ['cc_confirm', { ref: 'A-0163' }, 'commandcenter://items/A-0163'],
        ['cc_attest_claim', { ref: 'A-0163' }, 'commandcenter://items/A-0163'],
        ['cc_reject_claim', { ref: 'A-0163' }, 'commandcenter://items/A-0163'],
        ['cc_accept_draft', { ref: 'A-0163' }, 'commandcenter://items/A-0163'],
        ['cc_drop_item', { ref: 'A-0163' }, 'commandcenter://items/A-0163'],
        ['cc_approve_confirmation', { id: 'cfm_7q2' }, 'commandcenter://confirmations/cfm_7q2'],
        ['cc_deny', { id: 'cfm_7q2' }, 'commandcenter://confirmations/cfm_7q2'],
        ['cc_open_decision', { ref: 'D-0008' }, 'commandcenter://'],
        ['cc_decide', { ref: 'D-0008' }, 'commandcenter://'],
      ];
      for (const [name, args, link] of cases) {
        const answer = await session.call(name, args);
        expect(answer.isError, name).toBe(true);
        expect(answer.output['code'], name).toBe('E_HUMAN_REQUIRED');
        expect((answer.output['help'] as string[]).join('\n'), name).toContain(link);
      }
      expect(humanOnlyMethodOf('cc_confirm_read_back')).toBe('meetings.confirm');
      expect(humanOnlyMethodOf('cc_approve_request')).toBe('requests.approve');
      expect(humanOnlyMethodOf('cc_open_decision')).toBe('decisions.open');
      expect(humanOnlyMethodOf('cc_list')).toBeUndefined();
    });
  },
);

describe('cc-axi mcp: the protocol (04 §8)', () => {
  it('answers initialize with the asked protocol version it speaks, else its newest; ping; unknown methods', async () => {
    const session = relay();
    const client = { capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } };
    const asked = await session.request('initialize', { protocolVersion: '2024-11-05', ...client });
    expect(asked.result?.['protocolVersion']).toBe('2024-11-05');
    const unknown = await session.request('initialize', {
      protocolVersion: '1999-01-01',
      ...client,
    });
    expect(unknown.result?.['protocolVersion']).toBe(LATEST_PROTOCOL_VERSION);
    expect((await session.request('ping')).result).toEqual({});
    expect((await session.request('resources/list')).error).toMatchObject({ code: -32601 });
    expect((await session.request('prompts/list')).error).toMatchObject({ code: -32601 });
    // A line that is not JSON is dropped, and the relay keeps serving.
    session.send('{not json');
    expect((await session.request('ping')).result).toEqual({});
  });

  it('serves the generated tools/list within 12 KB, one sentence per tool, tools only (C-07-06)', async () => {
    const session = relay();
    await session.initialize();
    const tools = (await session.request('tools/list')).result?.['tools'] as {
      name: string;
      description: string;
      inputSchema: { type: string };
    }[];
    expect(tools).toEqual(mcpToolList());
    const generated = JSON.parse(readFileSync(GENERATED, 'utf8')) as { tools: unknown };
    expect(generated.tools).toEqual(tools);
    expect(Buffer.byteLength(JSON.stringify({ tools }))).toBeLessThanOrEqual(
      MCP_TOOLS_BUDGET_BYTES,
    );
    for (const tool of tools) {
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.description, tool.name).toMatch(/^[A-Z][^.]*(?:\.[a-z_][^.]*)*\.$/);
    }
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual(TABLE);
  });

  it('lists tools without the app and answers every call E_APP_NOT_RUNNING, then reconnects (04 §8 rule 2)', async () => {
    await core.close();
    const session = relay();
    await session.initialize();
    expect((await session.request('tools/list')).result?.['tools']).toHaveLength(14);
    const down = await session.call('cc_home');
    expect(down.isError).toBe(true);
    expect(down.output).toMatchObject({
      code: 'E_APP_NOT_RUNNING',
      help: ['Open Command Center, then retry'],
    });
    // The same profile again: its store already holds the records and the principals.
    core = await startTestCore({ profileDir: profile.path, data: null, principals: [] });
    const up = await session.call('cc_list', { type: 'workstreams' });
    expect(up.isError).toBe(false);
  });
});

describe('cc-axi mcp: the tools (07 §7)', () => {
  it('returns the same TOON text as the CLI command', async () => {
    const session = relay('cli-default');
    await session.initialize();
    const pairs: [string, Record<string, unknown>, string[]][] = [
      [
        'cc_list',
        { type: 'items', fields: ['owner', 'health'], limit: 3 },
        ['items', 'list', '--fields', 'owner,health', '--limit', '3'],
      ],
      ['cc_get', { ref: 'A-0161' }, ['items', 'view', 'A-0161']],
      ['cc_get', { ref: 'A-0161', full: true }, ['items', 'view', 'A-0161', '--full']],
      [
        'cc_search',
        { text: 'proposal', types: ['items', 'decisions'] },
        ['search', 'proposal', '--types', 'items,decisions'],
      ],
      ['cc_list', { type: 'decisions', status: 'open' }, ['decisions', 'list', '--status', 'open']],
      ['cc_list', { type: 'goals', period: 'current' }, ['goals', 'list', '--period', 'current']],
      ['cc_get', { ref: 'I-0012' }, ['issues', 'view', 'I-0012']],
      ['cc_get', { ref: 'quillmarsh', type: 'workstreams' }, ['workstreams', 'view', 'quillmarsh']],
    ];
    for (const [name, args, argv] of pairs) {
      const tool = await session.call(name, args);
      const command = await cli(profile.path, argv);
      expect(tool.text, name).toBe(command.stdout.trimEnd());
    }
  });

  it('creates, updates, claims, attaches, proposes and records through the CLI handlers', async () => {
    const session = relay();
    await session.initialize();
    const update = await session.call('cc_update_action', {
      ref: 'A-0150',
      health: 'at_risk',
      note: 'Two steps moved',
    });
    expect(update.output).toMatchObject({ status: 'ok' });
    expect(
      (
        await session.call('cc_update_action', {
          ref: 'A-0150',
          health: 'at_risk',
          note: 'Two steps moved',
        })
      ).output,
    ).toMatchObject({ status: 'no-op' });
    const proposal = await session.call('cc_update_action', {
      ref: 'A-0150',
      propose_due: '2026-11-25',
      reason: 'The client moved the kickoff',
    });
    expect(proposal.output).toMatchObject({ status: 'ok' });
    const attach = await session.call('cc_attach_evidence', {
      ref: 'A-0142',
      evidence: 'record:gmail-alderwick/message/m-1',
      requirement: 'er1',
    });
    expect(attach.output).toMatchObject({ status: 'ok' });
    const decision = await session.call('cc_propose_decision', {
      workstream: 'alderwick',
      question: 'Do we offer phased pricing?',
      options: ['Yes', 'No'],
    });
    expect(decision.output).toMatchObject({
      status: 'ok',
      decision: { status: 'proposed', options: 2 },
    });
    // claude-code has no measures:write (07 §5): the core refuses it.
    const measure = await session.call('cc_record_measure', { ref: 'K-0003', value: 4 });
    expect(measure.output).toMatchObject({ code: 'E_FORBIDDEN' });
    const byCli = relay('cli-default');
    await byCli.initialize();
    const recorded = await byCli.call('cc_record_measure', {
      ref: 'K-0003',
      value: 4,
      period: '2026-11-09',
    });
    expect(recorded.output).toMatchObject({ status: 'ok', value: { measure: 'K-0003', value: 4 } });
  });

  it('shows measures, goals and decisions by ref (cc_get infers the type)', async () => {
    const session = relay();
    await session.initialize();
    expect((await session.call('cc_get', { ref: 'K-0003' })).output['measure']).toMatchObject({
      ref: 'K-0003',
      workstreams: 'alderwick',
      source: 'manual',
    });
    const goals = await session.call('cc_list', { type: 'goals' });
    const goalRef = (goals.output['goals'] as { ref: string }[])[0]?.ref ?? '';
    const goal = await session.call('cc_get', { ref: goalRef });
    expect(goal.isError).toBe(false);
    expect(goal.output['goal']).toMatchObject({ ref: goalRef });
    expect(
      (await session.call('cc_get', { ref: 'D-0008', full: true })).output['decision'],
    ).toMatchObject({ ref: 'D-0008' });
    const unknown = await session.call('cc_get', { ref: 'alderwick' });
    expect(unknown.output).toMatchObject({ code: 'E_USAGE' });
  });

  it('refuses arguments a type does not take, invalid arguments and unknown tools with E_USAGE', async () => {
    const session = relay();
    await session.initialize();
    const filter = await session.call('cc_list', { type: 'workstreams', owner: 'me' });
    expect(filter.output).toMatchObject({
      error: 'cc_list with type workstreams does not take owner',
      code: 'E_USAGE',
      help: ['cc_list with type workstreams takes: limit'],
    });
    const invalid = await session.call('cc_create_action', { workstream: 'alderwick', title: 'x' });
    expect(invalid.isError).toBe(true);
    expect(invalid.output['code']).toBe('E_USAGE');
    expect(String(invalid.output['error'])).toContain('due');
    const state = await session.call('cc_list', { type: 'items', state: 'finished' });
    expect(state.output).toMatchObject({ code: 'E_USAGE' });
    const unknown = await session.call('cc_frobnicate');
    expect(unknown.output).toMatchObject({ code: 'E_USAGE', error: 'unknown tool cc_frobnicate' });
    // A read-only principal reads but cannot draft (07 §5).
    const reader = relay('read-only');
    await reader.initialize();
    expect((await reader.call('cc_home')).isError).toBe(false);
    expect(
      (
        await reader.call('cc_create_action', {
          workstream: 'alderwick',
          title: 'Send it',
          due: '2026-11-20',
          done_means: 'Sent',
        })
      ).output,
    ).toMatchObject({ code: 'E_FORBIDDEN' });
  });

  it('lists meetings, shows one, and captures a note and a draft item while it runs', async () => {
    withMeetings();
    const session = relay();
    await session.initialize();
    const week = await session.call('cc_list', { type: 'meetings' });
    expect(week.isError).toBe(false);
    const rows = week.output['meetings'] as { ref: string; meeting: string; start: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(String(week.output['count'])).toMatch(
      /^\d+ of \d+ meetings this week \(2026-11-09 to 2026-11-15\)$/,
    );
    const today = await session.call('cc_list', { type: 'meetings', range: 'today' });
    expect(today.isError).toBe(false);
    const ref = rows[0]!.ref;
    // Capture needs the meeting in progress; only the user starts one (02 §4.2).
    const early = await session.call('cc_meeting_capture', {
      ref,
      section: 'checkin',
      note: 'Too early',
    });
    expect(early.isError).toBe(true);
    await core.core.dispatcher.call({ kind: 'user' }, 'meetings.start', { ref });
    const view = await session.call('cc_get', { ref });
    expect(view.output['meeting']).toMatchObject({ ref, time_zone: 'Asia/Kolkata' });
    const sections = view.output['sections'] as {
      section: string;
      workstream: string | null;
      outputs: string;
    }[];
    const target = sections.find(
      (section) => section.outputs.includes('action_item') && section.workstream !== null,
    );
    expect(target).toBeDefined();
    // A per-workstream section repeats; the capture names the workstream (02 §4.4).
    const ambiguous = await session.call('cc_meeting_capture', {
      ref,
      section: target!.section,
      note: 'x',
    });
    expect(ambiguous.output).toMatchObject({ code: 'E_USAGE' });
    expect(String((ambiguous.output['help'] as string[])[0])).toContain(target!.workstream!);

    // A section's allowed outputs are the core's rule (02 §5): the scorecard takes no notes.
    const refused = await session.call('cc_meeting_capture', {
      ref,
      section: target!.section,
      workstream: target!.workstream,
      note: 'The lead asked for phased pricing',
    });
    expect(refused.output).toMatchObject({ code: 'E_INVARIANT' });
    const notes = sections.find((section) => section.outputs.split(',').includes('note'));
    expect(notes).toBeDefined();
    const note = await session.call('cc_meeting_capture', {
      ref,
      section: notes!.section,
      ...(notes!.workstream === null ? {} : { workstream: notes!.workstream }),
      note: 'The lead asked for phased pricing',
    });
    expect(note.output).toMatchObject({ status: 'ok', captured: { meeting: ref, output: 'note' } });
    const item = await session.call('cc_meeting_capture', {
      ref,
      section: target!.section,
      workstream: target!.workstream,
      action: 'Send the phased pricing sheet',
      due: '2026-11-18',
      done_means: 'The sheet is in the client folder',
    });
    expect(item.output).toMatchObject({ status: 'ok', captured: { output: 'draft action item' } });
    const both = await session.call('cc_meeting_capture', {
      ref,
      section: target!.section,
      note: 'x',
      action: 'y',
    });
    expect(both.output).toMatchObject({ code: 'E_USAGE' });
    const missing = await session.call('cc_meeting_capture', {
      ref,
      section: 'no-such-section',
      note: 'x',
    });
    expect(missing.output).toMatchObject({ code: 'E_USAGE' });
  });

  it('the connector tools return definitive empty results until P2 (09 P1-13)', async () => {
    const session = relay();
    await session.initialize();
    const actions = await session.call('cc_connector_actions');
    expect(actions.isError).toBe(false);
    expect(actions.output).toEqual({
      actions: '0 connector actions',
      help: ['No connector is installed until phase 2 (P2-02)'],
    });
    const one = await session.call('cc_connector_actions', { binding: 'gmail-alderwick' });
    expect(one.output['actions']).toBe('0 connector actions for binding gmail-alderwick');
    const invoke = await session.call('cc_connector_invoke', {
      binding: 'gmail-alderwick',
      action: 'send_draft',
      input: { draftId: 'd-1' },
    });
    expect(invoke.isError).toBe(true);
    expect(invoke.output).toMatchObject({
      code: 'E_NOT_FOUND',
      error: 'no connector action send_draft on binding gmail-alderwick',
    });
    // read-only lacks connectors:read (07 §5).
    const reader = relay('read-only');
    await reader.initialize();
    expect((await reader.call('cc_connector_actions')).output).toMatchObject({
      code: 'E_FORBIDDEN',
    });
  });

  it('shows a confirmation and waits for its decision; an unknown one is E_NOT_FOUND', async () => {
    const session = relay();
    await session.initialize();
    const missing = await session.call('cc_confirmation_status', { id: 'cfm_7q2' });
    expect(missing.output).toMatchObject({ code: 'E_NOT_FOUND' });

    // Nothing creates confirmations before P2-01; this row stands in for the first one.
    const store = core.core.store;
    const doc = {
      createdAt: '2026-11-13T03:00:00Z',
      expiresAt: '2026-11-14T03:00:00Z',
      requestedBy: { kind: 'user' },
      subject: {
        kind: 'connector_action',
        bindingId: 'bnd_gmail_ald',
        action: 'send_draft',
        risk: 'send_publish',
      },
      payloadPreview: 'To: the consulting lead. Subject: Revised proposal.',
      payloadHash: 'a'.repeat(64),
      status: 'pending',
    };
    const at = '2026-11-13T03:00:00Z';
    const row = {
      id: 'cfm_7q2',
      doc,
      createdAt: at,
      createdBy: { kind: 'user' as const },
      updatedAt: at,
      updatedBy: { kind: 'user' as const },
      version: 1,
    };
    store.command({ actor: { kind: 'user' } }, (tx) => {
      tx.insert('confirmations', row);
      tx.event({ type: 'confirmation.created', entity: { kind: 'confirmation', id: row.id } });
    });
    const pending = await session.call('cc_confirmation_status', { id: 'cfm_7q2' });
    expect(pending.output).toEqual({
      confirmation: {
        id: 'cfm_7q2',
        status: 'pending',
        subject: 'send_draft on bnd_gmail_ald (send_publish)',
        expires: '2026-11-14T03:00:00Z',
        preview: 'To: the consulting lead. Subject: Revised proposal.',
      },
      help: ['Approve or deny it in the app: commandcenter://confirmations/cfm_7q2'],
    });
    const timedOut = await session.call('cc_confirmation_status', { id: 'cfm_7q2', wait: 1 });
    expect(timedOut.output['confirmation']).toMatchObject({ status: 'pending', timed_out: true });

    const waiting = session.call('cc_confirmation_status', { id: 'cfm_7q2', wait: 30 });
    setTimeout(() => {
      store.command({ actor: { kind: 'user' } }, (tx) => {
        tx.update(
          'confirmations',
          { ...row, doc: { ...doc, status: 'approved', decidedAt: '2026-11-13T03:40:00Z' } },
          1,
        );
        tx.event({ type: 'confirmation.approved', entity: { kind: 'confirmation', id: row.id } });
      });
    }, 300);
    const decided = await waiting;
    expect(decided.output).toEqual({
      confirmation: expect.objectContaining({ status: 'approved', timed_out: false }),
    });
  });
});
