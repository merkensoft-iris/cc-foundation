/**
 * P1-15, the reference scenario end to end (09 §6.1; 08 §8 item 3): `cc:seed` seeds the
 * scenario on Wed 2026-11-04, then the fake clock runs through Fri 2026-12-04. The rhythm jobs
 * run at their spec times on the way (`RhythmJobs`); the user acts through the UI's path
 * (`callAsUser`, 04 §4.3 rule 1) and the scenario's agent through the local API socket, so
 * human-only operations stay out of the agent's reach.
 *
 * The timeline, all times IST (Asia/Kolkata):
 *
 * | When | What happens | Criteria |
 * |---|---|---|
 * | Wed 11-04 09:40 | `cc:seed`: onboarding commit, the agent principal, the worked examples | AC-01-01, AC-01-06, AC-02-01, AC-01-05, AC-03-11 |
 * | Mon 11-09 | first daily start: pre-read, start, capture, dismiss, close; the unheld shutdown is missed | 02 §5.7 (Q6, Q7), 02 §4.2 |
 * | Tue 11-10 | the agent claims A-0144 and cannot confirm it | AC-03-02 |
 * | Fri 11-13 15:00 | first weekly review: the agent cannot decide D-0008; an item captured, read back, closed | C-02-04 |
 * | Mon 11-16 | the user edits a goal on the Goals tab, and rejects the A-0144 claim | AC-03-10, AC-03-05 |
 * | Thu 11-19 | the agent claims A-0160 with a note only; the user attests | AC-03-09 |
 * | Fri 11-20 15:00 | weekly review: A-0144 on the action review, A-0142 carried once | AC-03-05, AC-02-05 |
 * | Mon 11-23 | the agent claims A-0144 again with checkable evidence; the user confirms | 03 §9.2 |
 * | Fri 11-27 15:00 | monthly review absorbs the weekly one: 15:00-17:00; A-0142 carried twice, E2 issue | AC-02-02, AC-02-05 |
 * | Fri 12-04 15:00 | weekly review lists the E2 issue | AC-02-05 |
 * | Fri 12-04 18:00 | export and re-preview of the answers; month metrics | AC-01-09, AC-03-08 |
 *
 * A second run (`the user who misses two weekly reviews`) leaves the 11-13 and 11-20 reviews
 * unheld: one rhythm escalation (AC-02-07), on the next daily start's attention list.
 *
 * Checks of steps not yet built are pending at the point in the timeline where they belong,
 * one per criterion, so the step that builds them enables them in place: P1-13 (MCP relay,
 * AC-07-03), P1-14 (hooks, AC-07-05, AC-07-06) and P1-17 (backups, AC-04-10 to AC-04-12).
 * `cc:trace` does not count a pending test. Two more wait for work no P1 step names yet: the
 * calendar mapping validator (AC-02-12), and a way for the user to open a proposed decision,
 * without which D-0008 cannot be decided (`meetings.capture` takes only notes and items).
 *
 * The scenario stands in for the 03 §13 records with what P1's API can create: A-0142, A-0144
 * and A-0160 (created and accepted), D-0008 (proposed by the agent) and R-0002 (on the
 * Workspace pseudo-workstream). Each gets the next free ref; `s.ref('A-0142')` names it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createProfileDir,
  readOnboardingProfile,
  readScenario,
  seedScenario,
  type ProfileDir,
  type Scenario,
} from '@cc/test-kit';
import { expand } from '@cc/rhythm';

/** A real core composing the whole rhythm and a month of jobs; slow runners need time. */
const SLOW_MS = 120_000;

type Meeting = { ref: string; title: string; start: string; end: string; state: string };
type Section = {
  sectionId: string;
  workstreamId?: string;
  absorbedFrom?: string;
  title: string;
  type: string;
  timeboxMinutes: number;
  rows: { ref: string; title: string; flags: string[] }[];
};
type MeetingView = {
  meeting: {
    ref: string;
    state: string;
    scheduledStart: string;
    scheduledEnd: string;
    preread?: unknown;
  };
  title: string;
  sections: Section[];
  readBack: { ref: string; owner: string; state: string }[];
};
type Item = {
  ref: string;
  lifecycle: string;
  health: string;
  carryCount: number;
  escalationLevel: number;
  links: { issueIds: string[] };
  verification?: { method: string };
};

async function rejection(
  promise: Promise<unknown>,
): Promise<{ code: string; message: string; help: string[] }> {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string; help: string[] };
  }
  throw new Error('expected a rejection');
}

/** The scenario's helpers over the API: meetings by local time and title, items by ref. */
function helpers(s: Scenario) {
  const meeting = async (local: string, title: string): Promise<Meeting> => {
    const date = local.slice(0, 10);
    const { meetings } = await s.user<{ meetings: Meeting[] }>('meetings.list', {
      from: date,
      to: date,
    });
    const found = meetings.find((m) => m.title === title && m.start === s.instant(local));
    if (found === undefined)
      throw new Error(`no ${title} at ${local}: ${JSON.stringify(meetings)}`);
    return found;
  };
  const view = (ref: string) => s.user<MeetingView>('meetings.get', { ref });
  const item = async (plays: string) =>
    (await s.user<{ item: Item }>('items.get', { ref: s.ref(plays) })).item;
  const workstreamId = async (slug: string) =>
    (await s.user<{ workstream: { id: string } }>('workstreams.get', { workstream: slug }))
      .workstream.id;
  /** Holds a review: start, read-back, close, each as the user. */
  const hold = async (ref: string, endLocal: string) => {
    await s.user('meetings.start', { ref });
    await s.user('meetings.confirm', { ref });
    await s.advanceTo(endLocal);
    return s.user<{ status: string; carried: string[]; meeting: { state: string } }>(
      'meetings.close',
      { ref },
    );
  };
  return { meeting, view, item, workstreamId, hold };
}

describe(
  'P1-15 the reference scenario, seeded 2026-11-04, through 2026-12-04',
  { timeout: SLOW_MS },
  () => {
    let profile: ProfileDir;
    let s: Scenario;
    let h: ReturnType<typeof helpers>;

    beforeAll(async () => {
      profile = createProfileDir();
      s = await seedScenario({ profileDir: profile.path });
      h = helpers(s);
    }, SLOW_MS);

    afterAll(async () => {
      await s?.stop();
      profile?.cleanup();
    });

    // Wed 2026-11-04 09:40: cc:seed

    describe('Wed 2026-11-04: the seed', () => {
      it.todo(
        'AC-04-12 a profile directory inside a fixture sync root refuses to open the store and exits with help to move it (P1-17)',
      );

      it('AC-01-01 the recommender on the seeded core returns the 01 §7.2 templates, modes, packs and fired rules', async () => {
        const { recommendations } = await s.user<{
          recommendations: {
            workstreamKey: string;
            templateId: string;
            mode: string;
            packIds: string[];
            firedRules: string[];
            privacy: string;
            aiDataPolicy: string;
          }[];
        }>('onboarding.recommend', { profile: readOnboardingProfile(readScenario()) });
        expect(
          recommendations.map((r) => [
            r.workstreamKey,
            r.templateId,
            r.mode,
            r.firedRules,
            r.privacy,
            r.aiDataPolicy,
          ]),
        ).toEqual([
          [
            'alderwick',
            'eos-lite',
            'solo',
            ['R8', 'M2', 'M5', 'M6', 'M7', 'M8'],
            'normal',
            'allow',
          ],
          ['quillmarsh', 'eos-lite', 'solo', ['R8', 'M2', 'M6', 'M7', 'M8'], 'normal', 'allow'],
        ]);
      });

      it('AC-01-06 the seed committed onboarding in one transaction, and no calendar event exists', async () => {
        expect(await s.user('onboarding.status')).toMatchObject({
          state: 'committed',
          committedAt: '2026-11-04T04:10:00.000Z',
        });
        const events = s.core.store.read((tx) => tx.events());
        const commit = events.filter((e) => e.correlationId === 'onboarding.commit');
        expect(commit.length).toBeGreaterThan(100);
        const first = events.findIndex((e) => e.correlationId === 'onboarding.commit');
        expect(
          events
            .slice(first, first + commit.length)
            .every((e) => e.correlationId === 'onboarding.commit'),
        ).toBe(true);
        // Only planned or absorbed instances: no series has a calendar, and nothing was exported.
        const states = s.core.store.read((tx) => tx.list('meeting_instances').map((m) => m.state));
        expect(new Set(states)).toEqual(new Set(['planned', 'absorbed']));
        expect(
          s.core.store
            .read((tx) => tx.list('meeting_series'))
            .every((series) => series.calendars.length === 0),
        ).toBe(true);
      });

      it('AC-02-01 the daily and weekly series hold instances from 2026-11-09 to 2027-02-05, as many as their RRULE expansion, and materialising again changes nothing', async () => {
        const series = s.core.store.read((tx) => tx.list('meeting_series'));
        const instances = s.core.store.read((tx) => tx.list('meeting_instances'));
        for (const one of series.filter((x) => x.cadence === 'daily' || x.cadence === 'weekly')) {
          const own = instances
            .filter((i) => i.seriesId === one.id)
            .map((i) => i.scheduledStart)
            .sort();
          const local = (instant: string | undefined) =>
            instant === undefined
              ? undefined
              : new Date(Date.parse(instant) + 330 * 60_000).toISOString().slice(0, 10);
          expect(local(own[0]), one.name).toBe(
            one.name === 'Weekly CEO review' ? '2026-11-13' : '2026-11-09',
          );
          expect(local(own.at(-1)), one.name).toBe(
            one.name === 'Weekly CEO review' ? '2027-02-05' : '2027-02-05',
          );
          const expansion = expand(
            one,
            s.instant('2026-11-09T00:00'),
            s.instant('2027-02-06T00:00'),
          );
          expect(own.length, one.name).toBe(expansion.occurrences.length);
        }
        expect(s.jobs.extendHorizon()).toEqual([]);
      });

      it('AC-01-05 no composed series overlaps a hard protected block in any week from 2026-11-09 to 2027-02-05, expanding every RRULE', async () => {
        // The blocks live in the committed answers (01 §9.1), which the placement rules read.
        const answers = s.core.store.read((tx) => tx.list('onboarding'))[0]?.profile;
        const series = s.core.store.read((tx) => tx.list('meeting_series'));
        const from = s.instant('2026-11-09T00:00');
        const to = s.instant('2027-02-06T00:00');
        const hard = (answers?.workspace.protectedBlocks ?? []).filter(
          (block) => block.policy === 'hard',
        );
        expect(hard.map((block) => block.id).sort()).toEqual(['pb_break', 'pb_evening']);
        const blocks = hard.flatMap((block) =>
          expand(
            {
              rrule: block.rrule,
              dtstart: '2026-11-09T00:00',
              timeZone: block.timeZone,
            },
            from,
            to,
          ).occurrences.map(({ start }) => ({
            id: block.id,
            start,
            end: new Date(Date.parse(start) + block.durationMinutes * 60_000).toISOString(),
          })),
        );
        expect(blocks.length).toBeGreaterThan(100);
        let checked = 0;
        for (const one of series) {
          for (const { start } of expand(one, from, to).occurrences) {
            const end = Date.parse(start) + one.durationMinutes * 60_000;
            const clash = blocks.find(
              (b) => Date.parse(b.start) < end && Date.parse(start) < Date.parse(b.end),
            );
            expect(clash, `${one.name} at ${start}`).toBeUndefined();
            checked += 1;
          }
        }
        expect(checked).toBeGreaterThan(130);
      });

      it('AC-03-11 the committed workspace has exactly one Workspace workstream, with no framework instance or series, and R-0002 is recorded on it', async () => {
        const { workstreams } = await s.user<{ workstreams: { slug: string; kind: string }[] }>(
          'workstreams.list',
        );
        expect(workstreams.filter((w) => w.kind === 'workspace').map((w) => w.slug)).toEqual([
          'workspace',
        ]);
        const workspaceId = await h.workstreamId('workspace');
        const series = s.core.store.read((tx) => tx.list('meeting_series'));
        expect(series.some((one) => one.workstreamIds.includes(workspaceId as never))).toBe(false);
        const frameworks = s.core.store.read((tx) => tx.list('framework_instances'));
        expect(frameworks.some((f) => f.workstreamId === workspaceId)).toBe(false);
        const { risk } = await s.user<{ risk: { workstreamId: string; status: string } }>(
          'risks.get',
          { ref: s.ref('R-0002') },
        );
        expect(risk).toMatchObject({ workstreamId: workspaceId, status: 'watching' });
      });

      it.todo(
        'AC-02-12 a calendar mapping route whose binding does not implement calendar@1, or a series with no primary target, fails validation with E_INVARIANT and writes nothing (no P1 step builds the 02 §9.6 rule 4 validator yet)',
      );

      it.todo(
        'AC-07-05 cc-axi setup hooks --agents claude-code,codex,opencode --scope project run twice leaves one hook per agent (P1-14)',
      );
    });

    // Week 1: Mon 2026-11-09 to Fri 2026-11-13

    describe('week 1: the first daily start and the first weekly review', () => {
      it('Mon 2026-11-09 the daily start is prepared at 08:30 by the pre-read job; the user runs it, captures an item and dismisses an attention entry until tomorrow', async () => {
        const runs = await s.advanceTo('2026-11-09T08:30');
        const daily = await h.meeting('2026-11-09T09:00', 'Daily start');
        expect(runs).toContainEqual(
          expect.objectContaining({
            job: 'preread',
            refs: [daily.ref],
            at: s.instant('2026-11-09T08:30'),
          }),
        );
        expect(daily.state).toBe('prepared');

        await s.advanceTo('2026-11-09T09:00');
        await s.user('meetings.start', { ref: daily.ref });
        const started = await h.view(daily.ref);
        const attention = started.sections.find((section) => section.type === 'attention');
        const entry = attention?.rows[0]?.ref;
        expect(entry).toBeDefined();
        expect(await s.user('meetings.dismiss', { ref: daily.ref, entry })).toEqual({
          status: 'ok',
          until: '2026-11-10',
        });
        await s.user('meetings.capture', {
          ref: daily.ref,
          section: { sectionId: 'top_three' },
          output: {
            kind: 'action_item',
            title: 'Draft the phase-one report outline for the client',
            due: '2026-11-12',
            doneMeans: 'The outline is in the client folder with every section named.',
            workstream: 'alderwick',
          },
        });
        await s.user('meetings.confirm', { ref: daily.ref });
        await s.advanceTo('2026-11-09T09:10');
        const closed = await s.user<{ meeting: { state: string } }>('meetings.close', {
          ref: daily.ref,
        });
        expect(closed.meeting.state).toBe('completed');

        // The unheld daily shutdown is missed at its end plus grace; a daily series raises no rhythm escalation.
        const later = await s.advanceTo('2026-11-09T18:30');
        const shutdown = await h.meeting('2026-11-09T17:20', 'Daily shutdown');
        expect(later).toContainEqual(
          expect.objectContaining({ job: 'missed', refs: [shutdown.ref], issues: [] }),
        );
      });

      it('AC-03-02 Tue 2026-11-10 the agent claims A-0144 with evidence; its confirm request fails with E_HUMAN_REQUIRED naming the deep link that opens the item', async () => {
        await s.advanceTo('2026-11-10T11:00');
        const ref = s.ref('A-0144');
        const claimed = await s.agent<{ item: Item }>('items.claim', {
          ref,
          evidence: [
            {
              kind: 'url',
              url: 'https://example.invalid/quillmarsh/site/pull/12',
              requirementId: 'er1',
            },
            {
              kind: 'url',
              url: 'https://example.invalid/quillmarsh/contact',
              requirementId: 'er2',
            },
          ],
          note: 'The form handler was fixed and a test message went through.',
        });
        expect(claimed.item.lifecycle).toBe('claimed_done');
        const refused = await rejection(s.agent('items.confirm', { ref }));
        expect(refused.code).toBe('E_HUMAN_REQUIRED');
        expect(refused.help.join('\n')).toContain(`commandcenter://items/${ref}`);
      });

      it.todo(
        "AC-07-03 a Claude Code session with the MCP server registered lists today's items, creates a draft item, and its confirm attempt returns E_HUMAN_REQUIRED with a deep link (P1-13)",
      );

      it.todo(
        "AC-07-06 in a directory listed in Quillmarsh's repoPaths, the session-start hook shows Quillmarsh's top items only, never an item of a sensitive workstream (P1-14)",
      );

      it.todo(
        'Fri 2026-11-13 the user opens D-0008 onto the review and decides it (needs a P1 path from proposed to open: meetings.capture takes only notes and action items, and no method opens a proposed decision)',
      );

      it('Fri 2026-11-13 the first weekly review: only the user can decide D-0008, a new item is captured and read back, and the close does not carry A-0142 due that day', async () => {
        const weekly = await h.meeting('2026-11-13T15:00', 'Weekly CEO review');
        await s.advanceTo('2026-11-13T15:00');
        await s.user('meetings.start', { ref: weekly.ref });

        // Deciding is human-only (04 §4.3): the agent that proposed D-0008 cannot decide it.
        const decision = s.ref('D-0008');
        const agentDecides = await rejection(
          s.agent('decisions.decide', { ref: decision, text: 'Built-in', why: 'Fewer tools' }),
        );
        expect(agentDecides.code).toBe('E_HUMAN_REQUIRED');
        expect(agentDecides.help.join('\n')).toContain('commandcenter://');

        await s.agent('meetings.capture', {
          ref: weekly.ref,
          section: { sectionId: 'issues' },
          output: {
            kind: 'action_item',
            title: 'Set up the posting calendar for weeks 48 to 50',
            due: '2026-11-18',
            doneMeans:
              'Each Alderwick and Quillmarsh post for weeks 48 to 50 has a date in the calendar.',
            workstream: 'alderwick',
          },
        });
        // C-02-04: the meeting cannot close before its read-back.
        const early = await rejection(s.user('meetings.close', { ref: weekly.ref }));
        expect(early.code).toBe('E_INVARIANT');
        const { readBack } = await h.view(weekly.ref);
        expect(readBack).toHaveLength(1);
        expect(readBack[0]).toMatchObject({ owner: 'self', state: 'draft' });
        const confirmed = await s.user<{ accepted: string[] }>('meetings.confirm', {
          ref: weekly.ref,
        });
        expect(confirmed.accepted).toEqual([readBack[0]?.ref]);

        await s.advanceTo('2026-11-13T16:00');
        const closed = await s.user<{ carried: string[]; meeting: { state: string } }>(
          'meetings.close',
          { ref: weekly.ref },
        );
        expect(closed.meeting.state).toBe('completed');
        expect(closed.carried).not.toContain(s.ref('A-0142'));
        expect((await h.item('A-0142')).carryCount).toBe(0);
      });
    });

    // Week 2: Mon 2026-11-16 to Fri 2026-11-20

    describe('week 2: goals, the review queue and the first carry', () => {
      it("AC-03-10 Mon 2026-11-16 changing a goal's title and target on the Goals tab writes one goal.updated event with before and after, and its history lists it", async () => {
        await s.advanceTo('2026-11-16T11:00');
        const { goals } = await s.user<{
          goals: { ref: string; title: string; target?: unknown; version: number }[];
        }>('goals.list', {});
        const goal = goals[0];
        expect(goal).toBeDefined();
        const ref = goal?.ref ?? '';
        const title = `${goal?.title ?? 'Goal'} (two pilots signed)`;
        const target = { from: 0, to: 2, unit: 'pilots', by: '2026-12-31' };
        await s.user('goals.update', { ref, title, target, version: goal?.version });
        const { events } = await s.user<{
          events: {
            type: string;
            before?: Record<string, unknown>;
            after?: Record<string, unknown>;
          }[];
        }>('goals.history', { ref });
        const updated = events.filter((e) => e.type === 'goal.updated');
        expect(updated).toHaveLength(1);
        expect(updated[0]?.before).toMatchObject({ title: goal?.title });
        expect(updated[0]?.after).toMatchObject({ title, target });
      });

      it('AC-03-05 Mon 2026-11-16 rejecting the claim moves A-0144 to in_progress at_risk, and the 2026-11-20 weekly action review lists it', async () => {
        await s.advanceTo('2026-11-16T12:00');
        const ref = s.ref('A-0144');
        const { item } = await s.user<{ item: Item }>('items.reject', {
          ref,
          reason: 'The test submission shows no confirmation page yet.',
        });
        expect(item).toMatchObject({ lifecycle: 'in_progress', health: 'at_risk' });

        await s.advanceTo('2026-11-19T15:00');
        const weekly = await h.meeting('2026-11-20T15:00', 'Weekly CEO review');
        expect(weekly.state).toBe('prepared');
        const quillmarsh = await h.workstreamId('quillmarsh');
        const review = (await h.view(weekly.ref)).sections.find(
          (section) => section.sectionId === 'action_review' && section.workstreamId === quillmarsh,
        );
        expect(review?.rows.map((row) => row.ref)).toContain(ref);
      });

      it('AC-03-09 Thu 2026-11-19 a claim of A-0160 backed only by a note: Confirm is disabled with its reason, Attest is enabled, and attesting records method attested', async () => {
        await s.advanceTo('2026-11-19T18:30');
        const ref = s.ref('A-0160');
        await s.agent('items.claim', {
          ref,
          evidence: [
            {
              kind: 'note',
              text: 'Three posts are scheduled from the approved drafts.',
              requirementId: 'er1',
            },
          ],
        });
        const { review } = await s.user<{
          review: { confirm: { enabled: boolean; reason?: string }; attest: { enabled: boolean } };
        }>('items.review', { ref });
        expect(review.confirm.enabled).toBe(false);
        expect(review.confirm.reason).toMatch(/only a note/);
        expect(review.attest.enabled).toBe(true);
        expect((await rejection(s.user('items.confirm', { ref }))).code).toBe('E_INVARIANT');
        const { item } = await s.user<{ item: Item }>('items.attest', {
          ref,
          note: 'Seen in the LinkedIn scheduler: three posts queued for 11-19 to 11-26.',
        });
        expect(item.verification?.method).toBe('attested');
      });

      it('AC-02-05 Fri 2026-11-20 A-0142, due 2026-11-13 and still open, has carryCount 1 after the weekly review', async () => {
        const weekly = await h.meeting('2026-11-20T15:00', 'Weekly CEO review');
        await s.advanceTo('2026-11-20T15:00');
        const closed = await h.hold(weekly.ref, '2026-11-20T16:00');
        expect(closed.carried).toContain(s.ref('A-0142'));
        expect(await h.item('A-0142')).toMatchObject({ carryCount: 1, lifecycle: 'open' });
      });
    });

    // Weeks 3 and 4: the monthly absorption on 2026-11-27, then 2026-12-04

    describe('weeks 3 and 4: the monthly absorption and the E2 escalation', () => {
      it.todo(
        'AC-04-11 corrupting the newest off-machine archive makes the next restore test fail: backup state failing, one notification, an attention item in the daily start; "last good backup" shows the previous archive (P1-17)',
      );

      it('Mon 2026-11-23 the agent claims A-0144 again with checkable evidence, and the user confirms it from the review queue', async () => {
        await s.advanceTo('2026-11-23T10:00');
        const ref = s.ref('A-0144');
        await s.agent('items.claim', {
          ref,
          evidence: [
            {
              kind: 'url',
              url: 'https://example.invalid/quillmarsh/site/pull/14',
              requirementId: 'er1',
            },
            {
              kind: 'url',
              url: 'https://example.invalid/quillmarsh/contact?sent=1',
              requirementId: 'er2',
            },
          ],
          note: 'The confirmation page now shows after a test submission.',
        });
        const queue = await s.user<{ review: { confirm: { enabled: boolean } } }>('items.review', {
          ref,
        });
        expect(queue.review.confirm.enabled).toBe(true);
        const { item } = await s.user<{ item: Item }>('items.confirm', { ref });
        expect(item.lifecycle).toBe('verified_done');
        expect(item.verification?.method).toBe('confirmed');
      });

      it('AC-02-02 Fri 2026-11-27 the weekly review is absorbed by the monthly review of the same date, which runs 15:00-17:00 IST and begins with the weekly backbone sections', async () => {
        await s.advanceTo('2026-11-26T15:00');
        const date = '2026-11-27';
        const { meetings } = await s.user<{ meetings: Meeting[] }>('meetings.list', {
          from: date,
          to: date,
        });
        const weekly = meetings.find((m) => m.title === 'Weekly CEO review');
        const monthly = meetings.find((m) => m.title === 'Monthly review');
        expect(weekly?.state).toBe('absorbed');
        expect(monthly).toMatchObject({
          state: 'prepared',
          start: s.instant('2026-11-27T15:00'),
          end: s.instant('2026-11-27T17:00'),
        });
        const { sections } = await h.view(monthly?.ref ?? '');
        const absorbed = sections.filter((section) => section.absorbedFrom !== undefined);
        expect(absorbed.length).toBeGreaterThan(0);
        // The absorbed weekly backbone comes first, then the monthly review's own sections.
        expect(
          sections.slice(0, absorbed.length).every((section) => section.absorbedFrom !== undefined),
        ).toBe(true);
        expect(absorbed.map((section) => section.sectionId)).toEqual(
          expect.arrayContaining(['scorecard', 'goals_review', 'action_review', 'issues']),
        );
        expect(absorbed.reduce((sum, section) => sum + section.timeboxMinutes, 0)).toBe(30);
      });

      it('AC-02-05 the 2026-11-27 monthly review carries A-0142 a second time, and its close raises an E2 issue', async () => {
        const monthly = await h.meeting('2026-11-27T15:00', 'Monthly review');
        await s.advanceTo('2026-11-27T15:00');
        const closed = await h.hold(monthly.ref, '2026-11-27T17:00');
        expect(closed.carried).toContain(s.ref('A-0142'));
        const item = await h.item('A-0142');
        expect(item).toMatchObject({ carryCount: 2, escalationLevel: 2 });
        expect(item.links.issueIds).toHaveLength(1);
        // The nightly runs after it raise no second issue.
        const nights = await s.advanceTo('2026-12-03T23:59');
        expect(
          nights.filter((run) => run.job === 'escalation').flatMap((run) => run.issues),
        ).toEqual([]);
      });

      it("AC-02-05 Fri 2026-12-04 the E2 issue is on the weekly review's agenda, and the scenario ends with the review held", async () => {
        const weekly = await h.meeting('2026-12-04T15:00', 'Weekly CEO review');
        await s.advanceTo('2026-12-04T15:00');
        const item = await h.item('A-0142');
        const issueId = item.links.issueIds[0];
        const { issue } = await s.user<{ issue: { ref: string; status: string } }>('issues.get', {
          ref: issueId,
        });
        expect(issue.status).toBe('open');
        const listed = (await h.view(weekly.ref)).sections
          .filter((section) => section.sectionId === 'issues')
          .flatMap((section) => section.rows.map((row) => row.ref));
        expect(listed).toContain(issue?.ref);
        const closed = await h.hold(weekly.ref, '2026-12-04T16:00');
        expect(closed.meeting.state).toBe('completed');
      });

      it('AC-01-09 Fri 2026-12-04 exporting the answers gives a file with no secret or app-only answer, and previewing it on a fresh profile composes the same framework instances and series', async () => {
        await s.advanceTo('2026-12-04T18:00');
        const exported = await s.user<{ profile: Record<string, unknown> }>(
          'onboarding.export',
          {},
        );
        const text = JSON.stringify(exported.profile);
        expect(text).not.toMatch(/passphrase|token|cc_canary/i);
        const fresh = createProfileDir();
        const other = await seedFreshPreview(fresh, exported.profile);
        try {
          const mine = await s.user<{ preview: Preview }>('onboarding.preview', {
            profile: readOnboardingProfile(readScenario()),
          });
          expect(shape(other)).toEqual(shape(mine.preview));
        } finally {
          fresh.cleanup();
        }
      });

      it.todo(
        'AC-04-10 with a folder destination and a passphrase set, scheduled backups write one archive locally and one to the folder with no canary title in plain bytes and no workspace.db or -wal file in the folder; 7 daily and 4 weekly kept over a simulated 60 days (P1-17)',
      );
    });
  },
);

type Preview = {
  frameworkInstances: {
    workstream: string;
    templateId: string;
    mode: string;
    packs: string[];
    firedRules: string[];
  }[];
  series: { name: string; rrule: string; durationMinutes: number; workstreams: string[] }[];
};

function shape(preview: Preview) {
  return {
    frameworks: preview.frameworkInstances.map((f) => [
      f.workstream,
      f.templateId,
      f.mode,
      f.packs,
      f.firedRules,
    ]),
    series: preview.series.map((one) => [
      one.name,
      one.rrule,
      one.durationMinutes,
      one.workstreams,
    ]),
  };
}

async function seedFreshPreview(
  profile: ProfileDir,
  answers: Record<string, unknown>,
): Promise<Preview> {
  const { startHeadless } = await import('@cc/core/headless');
  const { FakeTimerClock } = await import('@cc/test-kit');
  const core = await startHeadless({
    profileDir: profile.path,
    clock: new FakeTimerClock('2026-12-04T12:30:00Z'),
    env: {},
  });
  try {
    return (
      (await core.callAsUser('onboarding.preview', { profile: answers })) as { preview: Preview }
    ).preview;
  } finally {
    await core.stop();
  }
}

describe('P1-15 the user who misses two weekly reviews', { timeout: SLOW_MS }, () => {
  it("AC-02-07 the unheld 2026-11-13 and 2026-11-20 weekly reviews raise exactly one rhythm escalation with the three options, on the next daily start's attention list and the next review's agenda", async () => {
    const profile = createProfileDir();
    const s = await seedScenario({ profileDir: profile.path });
    try {
      const runs = await s.advanceTo('2026-11-23T08:30');
      const escalations = runs.flatMap((run) => run.issues);
      expect(escalations).toHaveLength(1);
      const [ref] = escalations;
      const { issue } = await s.user<{ issue: { title: string; raisedFrom: { kind: string } } }>(
        'issues.get',
        { ref },
      );
      expect(issue.raisedFrom.kind).toBe('rhythm');
      expect(issue.title).toMatch(
        /Reschedule the series, change the rhythm, or pause the workstream/,
      );
      const missed = runs.filter((run) => run.job === 'missed').flatMap((run) => run.refs);
      const h = helpers(s);
      for (const local of ['2026-11-13T15:00', '2026-11-20T15:00']) {
        expect(missed).toContain((await h.meeting(local, 'Weekly CEO review')).ref);
      }
      // The next daily start's attention list shows it in the escalations category, ahead of
      // today's meetings (02 §5.7 rule 1).
      const daily = await h.meeting('2026-11-23T09:00', 'Daily start');
      expect(daily.state).toBe('prepared');
      const entries = (await h.view(daily.ref)).sections
        .filter((section) => section.type === 'attention')
        .flatMap((section) => section.rows.map((row) => row.ref));
      expect(entries[0]).toBe(ref);
      // The next review's issues section lists it: the monthly review that absorbs 11-27's weekly.
      await s.advanceTo('2026-11-26T15:00');
      const monthly = await h.meeting('2026-11-27T15:00', 'Monthly review');
      const listed = (await h.view(monthly.ref)).sections
        .filter((section) => section.sectionId === 'issues')
        .flatMap((section) => section.rows.map((row) => row.ref));
      expect(listed).toContain(ref);
      // While it is open, further misses raise no second one (02 §4.2 rule 3).
      const later = await s.advanceTo('2026-12-04T18:00');
      expect(later.flatMap((run) => run.issues)).toEqual([]);
    } finally {
      await s.stop();
      profile.cleanup();
    }
  });
});
