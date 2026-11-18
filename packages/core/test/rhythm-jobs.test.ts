/**
 * The rhythm jobs on the core's scheduler (rhythm-jobs.ts; 02 §4.1 rule 2, §4.2 rule 2, §4.7,
 * §7.2 rule 1): the core plans them itself, so moving a fake clock prepares, misses and extends
 * with no test code calling a job. The scenario (packages/test-kit/test/scenario) runs them
 * through a month; these check the planning on its own.
 *
 * The answers are the reference scenario's (Alderwick and Quillmarsh, Asia/Kolkata), committed
 * on Wed 2026-11-04 09:40 IST; the rhythm starts Mon 2026-11-09, and its daily start is
 * prepared at 08:30 IST and missed, when never started, at 10:10 IST.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { MeetingInstance } from '@cc/schemas';
import {
  createProfileDir,
  FakeTimerClock,
  readOnboardingProfile,
  readScenario,
  type ProfileDir,
} from '@cc/test-kit';

import { RHYTHM_MEETINGS_JOB, RHYTHM_NIGHTLY_JOB, type RhythmRun } from '../src/rhythm-jobs.js';
import { startCore, type CoreService } from '../src/service.js';

/** Wed 2026-11-04 09:40 IST. */
const SEEDED = '2026-11-04T04:10:00Z';
/** Mon 2026-11-09 08:30 IST: the first daily start's pre-read. */
const FIRST_PREREAD = '2026-11-09T03:00:00.000Z';

const profiles: ProfileDir[] = [];
const cores: CoreService[] = [];
afterEach(async () => {
  for (const core of cores.splice(0)) await core.stop();
  for (const profile of profiles.splice(0)) profile.cleanup();
});

async function start(
  at: string,
  profile?: ProfileDir,
): Promise<{ core: CoreService; clock: FakeTimerClock; runs: RhythmRun[]; profile: ProfileDir }> {
  const dir = profile ?? createProfileDir();
  if (profile === undefined) profiles.push(dir);
  const clock = new FakeTimerClock(at);
  const runs: RhythmRun[] = [];
  const core = await startCore({
    userData: dir.path,
    clock,
    env: {},
    onRhythmRun: (run) => void runs.push(run),
  });
  cores.push(core);
  return { core, clock, runs, profile: dir };
}

async function commit(core: CoreService): Promise<void> {
  await core.callAsUser('onboarding.apply', {
    profile: readOnboardingProfile(readScenario('reference')),
  });
}

function dueOf(core: CoreService, job: string): string | undefined {
  return core.scheduler.status(job)?.nextDueAt?.toISOString();
}

function dailyStart(core: CoreService, date: string): MeetingInstance {
  const found = core.store.read((tx) => {
    const series = tx.list('meeting_series').find((s) => s.name === 'Daily start');
    return tx
      .list('meeting_instances')
      .find((i) => i.seriesId === series?.id && i.occurrenceStart.startsWith(date));
  });
  if (found === undefined) throw new Error(`no daily start on ${date}`);
  return found;
}

describe('the rhythm jobs on the core scheduler (02 §4.1 rule 2, §4.2 rule 2, §4.7, §7.2 rule 1)', () => {
  it('a fresh core plans the nightly run at 00:05 UTC and no meeting run; the onboarding commit replans both in the workspace zone', async () => {
    const { core } = await start(SEEDED);
    expect(dueOf(core, RHYTHM_NIGHTLY_JOB)).toBe('2026-11-05T00:05:00.000Z');
    expect(core.scheduler.status(RHYTHM_MEETINGS_JOB)).toMatchObject({ runs: 0 });
    expect(dueOf(core, RHYTHM_MEETINGS_JOB)).toBeUndefined();

    await commit(core);
    // Thu 2026-11-05 00:05 IST.
    expect(dueOf(core, RHYTHM_NIGHTLY_JOB)).toBe('2026-11-04T18:35:00.000Z');
    expect(dueOf(core, RHYTHM_MEETINGS_JOB)).toBe(FIRST_PREREAD);
  });

  it('moving the clock prepares the daily start at start − lead and marks it missed at end + grace, each reported once at its own time', async () => {
    const { core, clock, runs } = await start(SEEDED);
    await commit(core);
    await clock.advanceTo('2026-11-09T05:00:00Z');
    const daily = dailyStart(core, '2026-11-09');
    const ofDaily = runs.filter((run) => run.refs.includes(daily.ref));
    expect(ofDaily.map(({ at, job }) => ({ at, job }))).toEqual([
      { at: '2026-11-09T03:00:00Z', job: 'preread' },
      { at: '2026-11-09T04:40:00Z', job: 'missed' },
    ]);
    expect(daily).toMatchObject({ state: 'missed' });
    expect(daily.preread).toBeDefined();
    // The five nightly runs, 00:05 IST Thu 11-05 to Mon 11-09, ran and found nothing to add.
    expect(core.scheduler.status(RHYTHM_NIGHTLY_JOB)).toMatchObject({ runs: 5, failures: 0 });
    expect(core.scheduler.status(RHYTHM_MEETINGS_JOB)?.failures).toBe(0);
  });

  it('a started meeting is not missed: its due time passes with nothing to do', async () => {
    const { core, clock, runs } = await start(SEEDED);
    await commit(core);
    await clock.advanceTo('2026-11-09T03:30:00Z');
    const { ref } = dailyStart(core, '2026-11-09');
    await core.callAsUser('meetings.start', { ref });
    await clock.advanceTo('2026-11-09T05:00:00Z');
    expect(dailyStart(core, '2026-11-09').state).toBe('in_progress');
    expect(runs.filter((run) => run.job === 'missed' && run.refs.includes(ref))).toEqual([]);
  });

  it('times that passed while the app was closed run at start: a meeting still to come is prepared, one past its grace is missed', async () => {
    const first = await start(SEEDED);
    await commit(first.core);
    await first.core.stop();

    // Reopened Mon 2026-11-09 08:50 IST: the daily start's pre-read time has passed.
    const reopened = await start('2026-11-09T03:20:00Z', first.profile);
    expect(dueOf(reopened.core, RHYTHM_MEETINGS_JOB)).toBe('2026-11-09T03:20:00.000Z');
    await reopened.clock.advance(0);
    expect(dailyStart(reopened.core, '2026-11-09').state).toBe('prepared');
    await reopened.core.stop();

    // Reopened Tue 2026-11-10 12:00 IST: Monday's meetings and Tuesday's daily start are past.
    const later = await start('2026-11-10T06:30:00Z', first.profile);
    await later.clock.advance(0);
    const missed = later.runs.filter((run) => run.job === 'missed').flatMap((run) => run.refs);
    expect(missed).toContain(dailyStart(later.core, '2026-11-10').ref);
    expect(dailyStart(later.core, '2026-11-10').state).toBe('missed');
    expect(later.runs.every((run) => run.at === '2026-11-10T06:30:00Z')).toBe(true);
  });

  it('the nightly run at 00:05 in the workspace zone extends the horizon by the day that came into it', async () => {
    const { core, clock, runs } = await start(SEEDED);
    await commit(core);
    // Tue 2026-11-10 00:05 IST: the first night after the rhythm started moves the horizon a day.
    await clock.advanceTo('2026-11-09T18:35:00Z');
    const horizon = runs.filter((run) => run.job === 'horizon');
    expect(horizon).toHaveLength(1);
    expect(horizon[0]?.at).toBe('2026-11-09T18:35:00Z');
    expect(horizon[0]?.refs.length).toBeGreaterThan(0);
    expect(dueOf(core, RHYTHM_NIGHTLY_JOB)).toBe('2026-11-10T18:35:00.000Z');
  });
});
