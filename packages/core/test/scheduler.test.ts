import { FakeTimerClock } from '@cc/test-kit';
import { describe, expect, it } from 'vitest';

import { Scheduler } from '../src/scheduler.js';

const START = '2026-11-04T00:00:00Z';

describe('Scheduler on an injected clock (09 P1-04)', () => {
  it('runs a repeating job once per interval, only when the fake clock moves', async () => {
    const clock = new FakeTimerClock(START);
    const scheduler = new Scheduler({ clock });
    const runs: string[] = [];
    scheduler.every('tick', 60_000, (dueAt) => {
      runs.push(dueAt.toISOString());
    });

    await clock.advance(59_999);
    expect(runs).toEqual([]);
    await clock.advance(1);
    await clock.advance(120_000);
    expect(runs).toEqual([
      '2026-11-04T00:01:00.000Z',
      '2026-11-04T00:02:00.000Z',
      '2026-11-04T00:03:00.000Z',
    ]);
    expect(scheduler.status('tick')).toMatchObject({
      runs: 3,
      failures: 0,
      skipped: 0,
      nextDueAt: new Date('2026-11-04T00:04:00Z'),
    });
    await scheduler.stop();
    expect(clock.pending).toBe(0);
  });

  it('runs at once with immediate, and a one-off job at its instant', async () => {
    const clock = new FakeTimerClock(START);
    const scheduler = new Scheduler({ clock });
    const runs: string[] = [];
    scheduler.every('now', 3_600_000, () => void runs.push('now'), { immediate: true });
    scheduler.at('once', new Date('2026-11-04T00:30:00Z'), (dueAt) => {
      runs.push(`once ${dueAt.toISOString()}`);
    });
    await clock.advance(0);
    expect(runs).toEqual(['now']);
    await clock.advanceTo('2026-11-04T00:30:00Z');
    expect(runs).toEqual(['now', 'once 2026-11-04T00:30:00.000Z']);
    expect(scheduler.status('once')).toBeUndefined();
    await scheduler.stop();
  });

  it('never overlaps runs of one job: a tick during a run is skipped, not queued', async () => {
    const clock = new FakeTimerClock(START);
    const scheduler = new Scheduler({ clock });
    let release: () => void = () => undefined;
    let started = 0;
    scheduler.every('slow', 1_000, async () => {
      started += 1;
      await new Promise<void>((resolve) => (release = resolve));
    });
    await clock.advance(1_000);
    expect(started).toBe(1);
    await clock.advance(3_000);
    expect(started).toBe(1);
    expect(scheduler.status('slow')).toMatchObject({ skipped: 3, running: true });
    release();
    await clock.advance(1_000);
    expect(started).toBe(2);
    release();
    await scheduler.stop();
  });

  it('records a failing run and keeps the schedule', async () => {
    const clock = new FakeTimerClock(START);
    const scheduler = new Scheduler({ clock });
    let calls = 0;
    scheduler.every('flaky', 1_000, () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
    });
    await clock.advance(1_000);
    expect(scheduler.status('flaky')).toMatchObject({ failures: 1, lastError: 'boom' });
    await clock.advance(1_000);
    expect(scheduler.status('flaky')).toMatchObject({ runs: 2, failures: 1 });
    expect(scheduler.status('flaky')?.lastError).toBeUndefined();
    await scheduler.stop();
  });

  it('keeps a fixed rate: ticks missed while suspended collapse into one run', async () => {
    const clock = new FakeTimerClock(START);
    const scheduler = new Scheduler({ clock });
    const runs: string[] = [];
    scheduler.every('rate', 60_000, (dueAt) => void runs.push(dueAt.toISOString()));
    // A suspended process: the timer fires late, once.
    await clock.advance(60_000 * 5 + 30_000);
    expect(runs).toHaveLength(5);
    const lateClock = new FakeTimerClock(START);
    const late = new Scheduler({
      clock: {
        now: () => lateClock.now(),
        // Deliver every timer 5.5 intervals late, as after a laptop sleep.
        setTimeout: (callback, ms) => lateClock.setTimeout(callback, ms + 330_000),
        clearTimeout: (handle) => lateClock.clearTimeout(handle),
      },
    });
    const lateRuns: string[] = [];
    late.every('rate', 60_000, (dueAt) => void lateRuns.push(dueAt.toISOString()));
    await lateClock.advance(390_000);
    expect(lateRuns).toEqual(['2026-11-04T00:01:00.000Z']);
    expect(late.status('rate')?.nextDueAt).toEqual(new Date('2026-11-04T00:07:00Z'));
    await scheduler.stop();
    await late.stop();
  });

  it('cancels a job and refuses duplicate names and bad intervals', async () => {
    const clock = new FakeTimerClock(START);
    const scheduler = new Scheduler({ clock });
    let calls = 0;
    scheduler.every('job', 1_000, () => void (calls += 1));
    expect(() => scheduler.every('job', 1_000, () => undefined)).toThrow(/already scheduled/);
    expect(() => scheduler.every('bad', 0, () => undefined)).toThrow(RangeError);
    scheduler.cancel('job');
    await clock.advance(5_000);
    expect(calls).toBe(0);
    expect(scheduler.names()).toEqual([]);
    await scheduler.stop();
    expect(() => scheduler.at('late', clock.now(), () => undefined)).toThrow(/stopped/);
  });

  it('stop waits for the runs in progress', async () => {
    const clock = new FakeTimerClock(START);
    const scheduler = new Scheduler({ clock });
    let finished = false;
    scheduler.every('work', 1_000, async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      finished = true;
    });
    await clock.advance(1_000);
    await scheduler.stop();
    expect(finished).toBe(true);
  });
});
