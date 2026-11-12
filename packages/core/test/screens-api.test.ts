/**
 * The local API methods the screens of 09 P1-11 call, over the workspace store seeded from the
 * fixtures: the review queue (AC-03-09, owner decision Q5), the Goals tab (AC-03-10, Q2), the
 * Workspace pseudo-workstream (AC-03-11, Q4), the meeting runner with capture, read-back and
 * the daily start's attention list (Q6, Q7), and Settings → Agent access.
 */
import {
  checkWorkspaceWorkstream,
  createWorkspaceWorkstream,
  verifiedShare,
  workspaceWorkstreamOf,
} from '@cc/domain';
import { extendHorizon } from '@cc/rhythm';
import type { ActionItem, DomainEvent, Goal, MeetingSeries, Risk } from '@cc/schemas';
import { FakeTimerClock } from '@cc/test-kit';
import { afterEach, describe, expect, it } from 'vitest';

import { domainContext } from '../src/domain.js';
import { storeRhythmStore } from '../src/rhythm-store.js';
import { harness, scenarioPlacement, seriesById } from '../../rhythm/test/harness.ts';
import { rejection, startTestCore, type TestCore } from './helpers.js';

let open: TestCore[] = [];
afterEach(async () => {
  for (const test of open) await test.dispose();
  open = [];
});

/** A-0142 claimable with a note: its one requirement also accepts a note. */
const noteAccepted = (item: ActionItem): ActionItem => ({
  ...item,
  lifecycle: 'in_progress',
  waitingOn: undefined,
  evidenceRequirements: item.evidenceRequirements.map((requirement) => ({
    ...requirement,
    acceptedKinds: ['connector_record', 'note'],
  })),
});

async function core(now: string, seed: boolean | ((item: ActionItem) => ActionItem) = true) {
  const test = await startTestCore({ seed, clock: new FakeTimerClock(now) });
  open.push(test);
  const user = <T>(method: string, params: unknown = {}) =>
    test.core.callAsUser(method, params) as Promise<T>;
  return { test, user };
}

interface Review {
  item: ActionItem;
  evidence: { kind: string; requirementId?: string }[];
  review: {
    confirm: { enabled: boolean; reason?: string };
    attest: { enabled: boolean };
    reject: { enabled: boolean };
    notCheckable: string[];
  };
}

describe('the review queue (03 §9.2, owner decision Q5)', () => {
  it('AC-03-09 a claim whose only evidence for a required requirement is a note: Confirm disabled with its reason, Attest enabled; attesting records method attested, which the verified share leaves out', async () => {
    const { test, user } = await core('2026-11-12T05:30:00Z', noteAccepted);
    await user('items.claim', {
      ref: 'A-0142',
      evidence: [{ kind: 'note', text: 'Sent from my phone', requirementId: 'er1' }],
    });

    const queued = await user<Review>('items.review', { ref: 'A-0142' });
    expect(queued.item.lifecycle).toBe('claimed_done');
    expect(queued.evidence).toMatchObject([{ kind: 'note', requirementId: 'er1' }]);
    expect(queued.review.confirm.enabled).toBe(false);
    expect(queued.review.confirm.reason).toMatch(/No checkable evidence for er1/);
    expect(queued.review.attest.enabled).toBe(true);
    expect(queued.review.notCheckable).toEqual(['er1']);

    // Confirm stays refused at the API too, whatever the screen shows.
    const refused = await rejection(user('items.confirm', { ref: 'A-0142' }));
    expect(refused.code).toBe('E_INVARIANT');

    const attested = await user<{ item: ActionItem }>('items.attest', {
      ref: 'A-0142',
      note: 'Checked the sent folder myself',
    });
    expect(attested.item.lifecycle).toBe('verified_done');
    expect(attested.item.verification?.method).toBe('attested');
    const share = verifiedShare(
      [attested.item],
      { start: '2026-11-01', end: '2026-11-30' },
      '2026-11-12T05:30:00Z',
    );
    expect(share).toMatchObject({ auto: 0, confirmed: 0, attested: 1 });
    expect(share.share.numerator).toBe(0);
    expect(test.itemEvents().at(-1)).toMatchObject({
      type: 'action_item.verified',
      actor: { kind: 'user' },
    });
  });

  it('Confirm is enabled with checkable evidence; accept, reject and every review action are refused to agents (04 §4.3)', async () => {
    const { test, user } = await core('2026-11-12T05:30:00Z', noteAccepted);
    await user('items.claim', {
      ref: 'A-0142',
      evidence: [
        {
          kind: 'connector_record',
          binding: 'gmail-alderwick',
          recordType: 'message',
          externalId: 'msg-1',
          requirementId: 'er1',
        },
      ],
    });
    const queued = await user<Review>('items.review', { ref: 'A-0142' });
    expect(queued.review.confirm).toEqual({ enabled: true });

    const cli = await test.connect('cli-default');
    for (const method of ['items.confirm', 'items.attest', 'items.reject', 'items.accept']) {
      const refused = await rejection(cli.call(method, { ref: 'A-0142', note: 'n', reason: 'r' }));
      expect(refused.code, method).toBe('E_HUMAN_REQUIRED');
      expect(refused.help.join('\n'), method).toContain('commandcenter://items/A-0142');
    }

    const rejected = await user<{ item: ActionItem }>('items.reject', {
      ref: 'A-0142',
      reason: 'The message went to the wrong address',
    });
    expect(rejected.item).toMatchObject({ lifecycle: 'in_progress', health: 'at_risk' });
  });

  it('accepting a draft opens it; accepting it again is a no-op', async () => {
    const { user } = await core('2026-11-12T05:30:00Z');
    const draft = await user<{ item: ActionItem }>('items.create', {
      workstream: 'alderwick',
      title: 'Send the revised proposal',
      due: '2026-11-20',
      doneMeans: 'The lead has the proposal',
      evidence: ['The sent message'],
    });
    expect(draft.item.lifecycle).toBe('draft');
    const accepted = await user<{ status: string; item: ActionItem }>('items.accept', {
      ref: draft.item.ref,
    });
    expect(accepted).toMatchObject({ status: 'ok', item: { lifecycle: 'open' } });
    const again = await user<{ status: string }>('items.accept', { ref: draft.item.ref });
    expect(again.status).toBe('no-op');
  });
});

describe('the Goals tab (03 §5.3, owner decision Q2)', () => {
  it("AC-03-10 changing a goal's title and target outside any meeting writes one goal.updated event with the changed fields before and after, and the goal's history lists it", async () => {
    const { test, user } = await core('2026-11-12T05:30:00Z');
    const goals = await user<{ goals: { ref: string }[] }>('goals.list', { period: 'current' });
    const ref = goals.goals[0]?.ref ?? 'G-0001';
    const { goal } = await user<{ goal: Goal }>('goals.get', { ref });
    const before = await user<{ events: DomainEvent[] }>('goals.history', { ref });

    const target = { from: 0, to: 12, unit: 'clients', by: goal.period.end };
    const updated = await user<{ status: string; goal: Goal }>('goals.update', {
      ref,
      title: 'Sign twelve retainer clients',
      target,
      version: goal.version,
    });
    expect(updated.status).toBe('ok');
    expect(updated.goal).toMatchObject({ title: 'Sign twelve retainer clients', target });

    const events = test.core.store
      .read((tx) => tx.events())
      .filter((event) => event.type === 'goal.updated');
    expect(events).toHaveLength(1);
    const [event] = events as [DomainEvent];
    expect(event.actor).toEqual({ kind: 'user' });
    expect(event.before).toEqual({
      title: goal.title,
      ...(goal.target === undefined ? {} : { target: goal.target }),
    });
    expect(event.after).toEqual({ title: 'Sign twelve retainer clients', target });
    // No meeting caused it.
    expect(event.correlationId).toBeUndefined();

    const history = await user<{ events: DomainEvent[] }>('goals.history', { ref });
    expect(history.events).toHaveLength(before.events.length + 1);
    expect(history.events.at(-1)).toMatchObject({ type: 'goal.updated', after: event.after });

    // The same values again change nothing; a stale version conflicts; an agent is refused.
    const again = await user<{ status: string }>('goals.update', {
      ref,
      title: 'Sign twelve retainer clients',
    });
    expect(again.status).toBe('no-op');
    expect((await rejection(user('goals.update', { ref, title: 'x', version: 1 }))).code).toBe(
      'E_CONFLICT',
    );
    const cli = await test.connect('cli-default');
    expect((await rejection(cli.call('goals.update', { ref, title: 'x' }))).code).toBe(
      'E_HUMAN_REQUIRED',
    );
  });

  it('a health change off track needs its note (INV-03-03)', async () => {
    const { user } = await core('2026-11-12T05:30:00Z');
    const goals = await user<{ goals: { ref: string }[] }>('goals.list', { period: 'current' });
    const ref = goals.goals[0]?.ref ?? 'G-0001';
    const refused = await rejection(user('goals.update', { ref, health: { value: 'off_track' } }));
    expect(refused.code).toBe('E_INVARIANT');
    const done = await user<{ goal: Goal }>('goals.update', {
      ref,
      health: { value: 'off_track', note: 'Two clients paused' },
    });
    expect(done.goal).toMatchObject({ health: 'off_track', healthNote: 'Two clients paused' });
  });
});

describe('the Workspace pseudo-workstream (03 §5.2, owner decision Q4)', () => {
  it('AC-03-11 a committed workspace has exactly one workstream of kind workspace; a risk can be recorded on it; it has no framework instance and no meeting series, and creating a second one fails', async () => {
    const { test, user } = await core('2026-11-12T05:30:00Z');
    const store = test.core.store;
    const workstreams = store.read((tx) => tx.list('workstreams'));
    const series = store.read((tx) => tx.list('meeting_series'));
    expect(workstreams.filter((w) => w.kind === 'workspace')).toHaveLength(1);
    expect(checkWorkspaceWorkstream(workstreams, series)).toEqual([]);
    const workspace = workspaceWorkstreamOf(workstreams);
    expect(workspace?.frameworkInstanceId).toBeUndefined();
    expect(series.filter((s) => s.workstreamIds.includes(workspace?.id as never))).toEqual([]);

    const recorded = await user<{ status: string; risk: Risk }>('risks.record', {
      workstream: 'workspace',
      description: 'The laptop holding the only copy of the workspace fails',
      trigger: 'No backup succeeded for 72 hours',
    });
    expect(recorded).toMatchObject({ status: 'ok', risk: { workstreamId: workspace?.id } });
    const listed = await user<{ risks: { ref: string; workstream: string }[] }>('risks.list', {
      workstream: 'workspace',
    });
    expect(listed.risks.every((risk) => risk.workstream === 'workspace')).toBe(true);
    expect(listed.risks.map((risk) => risk.ref)).toContain(recorded.risk.ref);

    // A second one is refused, in the domain and so in the store's command.
    expect(() =>
      test.core.records.command({ kind: 'user' }, (view) => {
        const outcome = createWorkspaceWorkstream(
          domainContext(view, test.core.clock),
          { actor: { kind: 'user' } },
          view.tx.list('workstreams'),
          { timeZone: 'Asia/Kolkata' },
        );
        return { result: outcome.record, changes: outcome.changes };
      }),
    ).toThrow(/already has its workspace workstream/);
    expect(
      store.read((tx) => tx.list('workstreams')).filter((w) => w.kind === 'workspace'),
    ).toHaveLength(1);
  });

  it('the onboarding commit creates it once, with no framework instance, when there is none', async () => {
    const { test } = await core('2026-11-12T05:30:00Z');
    const store = test.core.store;
    // A profile from before Q4: its one workstream of kind workspace is turned into a project.
    store.command({ actor: { kind: 'user' } }, (tx) => {
      const existing = tx.list('workstreams').find((w) => w.kind === 'workspace');
      if (existing === undefined) return;
      tx.update(
        'workstreams',
        { ...existing, kind: 'project', slug: 'shared', version: existing.version + 1 },
        existing.version,
      );
      tx.event({ type: 'workstream.updated', entity: { kind: 'workstream', id: existing.id } });
    });
    const created = test.core.records.command({ kind: 'user' }, (view) => {
      const outcome = createWorkspaceWorkstream(
        domainContext(view, test.core.clock),
        { actor: { kind: 'user' } },
        view.tx.list('workstreams'),
        { timeZone: 'Asia/Kolkata' },
      );
      return { result: outcome.record, changes: outcome.changes };
    });
    expect(created).toMatchObject({ slug: 'workspace', name: 'Workspace', kind: 'workspace' });
    const after = store.read((tx) => tx.list('workstreams'));
    expect(checkWorkspaceWorkstream(after)).toEqual([]);
    expect(
      store
        .read((tx) => tx.events())
        .filter((event) => event.type === 'workstream.created')
        .at(-1),
    ).toMatchObject({ entity: { kind: 'workstream', id: created.id } });
  });
});

/** The CEO review and daily-start series with their instances, on the seeded store. */
function withMeetings(test: TestCore, ids: readonly string[]): void {
  const store = test.core.store;
  const series: MeetingSeries[] = ids.map((id) => seriesById(id));
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

interface MeetingGet {
  meeting: { ref: string; state: string };
  workstreams: { id: string; slug: string; name: string }[];
  title: string;
  sections: {
    sectionId: string;
    title: string;
    type: string;
    timeboxMinutes: number;
    allowedOutputs: string[];
    rows: { ref: string; title: string }[];
  }[];
  readBack: { ref: string; kind: string }[];
}

describe('the Meetings screen (02 §4.7, §5.7, §6)', () => {
  it('lists this week, runs a meeting: start, capture an item and a note, read back, close', async () => {
    const { test, user } = await core('2026-11-13T09:00:00Z');
    withMeetings(test, ['ser_ceo_weekly']);
    const week = await user<{
      from: string;
      to: string;
      meetings: { ref: string; title: string }[];
    }>('meetings.list');
    expect(week).toMatchObject({ from: '2026-11-09', to: '2026-11-15' });
    expect(week.meetings.length).toBeGreaterThan(0);
    const ref = week.meetings[0]?.ref ?? '';

    const home = await user<{ today: { ref: string; time: string; title: string }[] }>('home.get');
    expect(home.today).toEqual([expect.objectContaining({ ref, title: week.meetings[0]?.title })]);

    const started = await user<{ meeting: { state: string } }>('meetings.start', { ref });
    expect(started.meeting.state).toBe('in_progress');
    const runner = await user<MeetingGet>('meetings.get', { ref });
    expect(runner.sections.length).toBeGreaterThan(1);
    expect(runner.workstreams.map((w) => w.slug)).toEqual(['alderwick', 'quillmarsh']);
    expect(runner.sections.every((s) => s.title.length > 0 && s.timeboxMinutes >= 0)).toBe(true);
    const capturing = runner.sections.find(
      (s) => s.allowedOutputs.includes('action_item') && s.allowedOutputs.includes('note'),
    );
    if (capturing === undefined) throw new Error('no section takes items and notes');
    const sectionKey = { sectionId: capturing.sectionId };
    const withRow = runner.sections.find((s) => s.sectionId === capturing.sectionId) as {
      workstreamId?: string;
    };
    const key =
      withRow.workstreamId === undefined
        ? sectionKey
        : { ...sectionKey, workstreamId: withRow.workstreamId };
    await user('meetings.capture', {
      ref,
      section: key,
      output: {
        kind: 'action_item',
        title: 'Send the renewal terms',
        due: '2026-11-20',
        doneMeans: 'The client has the terms',
        workstream: 'alderwick',
      },
    });
    await user('meetings.capture', {
      ref,
      section: key,
      output: { kind: 'note', text: 'Good week' },
    });
    const readBack = await user<MeetingGet>('meetings.get', { ref });
    expect(readBack.readBack).toEqual([expect.objectContaining({ kind: 'action_item' })]);

    const cli = await test.connect('cli-default');
    expect((await rejection(cli.call('meetings.confirm', { ref }))).code).toBe('E_HUMAN_REQUIRED');

    const confirmed = await user<{ accepted: string[] }>('meetings.confirm', { ref });
    expect(confirmed.accepted).toHaveLength(1);
    const closed = await user<{ meeting: { state: string } }>('meetings.close', { ref });
    expect(closed.meeting.state).toBe('completed');
  });

  it('the daily start lists attention entries in fixed order; dismissing one snoozes it to tomorrow and an agent may not dismiss (Q6)', async () => {
    const { test, user } = await core('2026-11-12T02:00:00Z');
    withMeetings(test, ['ser_ceo_weekly', 'ser_daily_start']);
    const week = await user<{
      meetings: { ref: string; agendaTemplateId: string; start: string }[];
    }>('meetings.list', { from: '2026-11-13', to: '2026-11-13' });
    const daily = week.meetings.find((m) => m.agendaTemplateId.includes('daily-start'));
    if (daily === undefined) throw new Error('no daily start on 2026-11-13');
    await user('meetings.start', { ref: daily.ref });
    const before = await user<MeetingGet>('meetings.get', { ref: daily.ref });
    const attention = before.sections.find((s) => s.type === 'attention');
    expect(attention?.rows.length).toBeGreaterThan(0);
    const entry = attention?.rows[0]?.ref ?? '';

    const cli = await test.connect('cli-default');
    const scoped = await rejection(cli.call('meetings.dismiss', { ref: daily.ref, entry }));
    expect(['E_FORBIDDEN', 'E_NOT_FOUND']).toContain(scoped.code);

    const dismissed = await user<{ status: string; until: string }>('meetings.dismiss', {
      ref: daily.ref,
      entry,
    });
    expect(dismissed).toEqual({ status: 'ok', until: '2026-11-14' });
    const after = await user<MeetingGet>('meetings.get', { ref: daily.ref });
    expect(
      after.sections.find((s) => s.type === 'attention')?.rows.map((r) => r.ref),
    ).not.toContain(entry);
    const again = await user<{ status: string }>('meetings.dismiss', { ref: daily.ref, entry });
    expect(again.status).toBe('no-op');
    expect(
      test.core.store
        .read((tx) => tx.events())
        .filter((event) => event.type === 'meeting_instance.attention_dismissed'),
    ).toHaveLength(1);
  });
});

describe('Settings → Agent access (07 §5)', () => {
  it('lists principals without tokens; adding, changing and revoking are human-only', async () => {
    const { test, user } = await core('2026-11-12T05:30:00Z');
    const listed = await user<{ principals: Record<string, unknown>[] }>('principals.list');
    expect(listed.principals.map((p) => p.name)).toContain('cli-default');
    for (const principal of listed.principals) expect(principal).not.toHaveProperty('tokenPath');

    const created = await user<{ principal: { name: string }; tokenPath: string }>(
      'principals.create',
      { name: 'claude-code', kind: 'mcp_client', scopes: ['read', 'items:write'] },
    );
    expect(created.principal.name).toBe('claude-code');
    expect(created.tokenPath).toMatch(/claude-code\.token$/);
    const updated = await user<{ principal: { scopes: string[] } }>('principals.update', {
      name: 'claude-code',
      scopes: ['read'],
    });
    expect(updated.principal.scopes).toEqual(['read']);
    const revoked = await user<{ principal: { revokedAt?: string } }>('principals.revoke', {
      name: 'claude-code',
    });
    expect(revoked.principal.revokedAt).toBeDefined();

    const cli = await test.connect('cli-default');
    for (const method of ['principals.create', 'principals.update', 'principals.revoke']) {
      const refused = await rejection(
        cli.call(method, { name: 'grok-cc', kind: 'cli', scopes: ['read'] }),
      );
      expect(refused.code, method).toBe('E_HUMAN_REQUIRED');
    }
  });
});
