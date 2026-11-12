import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  mergeNotifications,
  NotificationCenter,
  type ShownNotification,
} from '../src/main/notifications/center.js';
import {
  mutedUntil,
  unsupportedBlocks,
  zonedInstant,
} from '../src/main/notifications/quiet-hours.js';
import type { NotificationPolicy, PushRequest } from '../src/shared/protocol.js';
import { timerClock } from './fakes.js';

/** The reference scenario's workspace (01 §7.1): IST, the 18:00-23:00 hard block. */
function scenarioPolicy(): NotificationPolicy {
  const file = fileURLToPath(
    new URL('../../../fixtures/onboarding/scenario.json', import.meta.url),
  );
  const { workspace } = JSON.parse(readFileSync(file, 'utf8')) as {
    workspace: NotificationPolicy;
  };
  return {
    timeZone: workspace.timeZone,
    quietHours: workspace.quietHours,
    protectedBlocks: workspace.protectedBlocks,
  };
}

const IST = 'Asia/Kolkata';
const istParts = new Intl.DateTimeFormat('en-US', {
  timeZone: IST,
  weekday: 'short',
  hour: 'numeric',
  minute: 'numeric',
  hourCycle: 'h23',
});

function ist(instant: Date): { weekday: string; minutes: number } {
  const parts = Object.fromEntries(
    istParts.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return {
    weekday: parts['weekday'] ?? '',
    minutes: Number(parts['hour']) * 60 + Number(parts['minute']),
  };
}

const reminder = (id: string, title = `Reminder ${id}`): PushRequest => ({
  id,
  kind: 'meeting_reminder',
  title,
  link: `commandcenter://meeting/ins_${id}`,
});

function harness(start: string, policy: NotificationPolicy | null = scenarioPolicy()) {
  const clock = timerClock(start);
  const shown: { at: Date; notification: ShownNotification }[] = [];
  const center = new NotificationCenter({
    clock,
    ...(policy === null ? {} : { policy }),
    show: (notification) => shown.push({ at: clock.now(), notification }),
  });
  return { clock, shown, center };
}

describe('notifications with quiet hours (02 §10)', () => {
  it('AC-02-09 no notification is delivered between 18:00 and 23:00 IST on weekdays', () => {
    // Two weeks of the reference scenario, a reminder every 10 minutes.
    const { clock, shown, center } = harness('2026-11-08T18:30:00Z');
    const end = Date.parse('2026-11-22T18:30:00Z');
    const pushed: string[] = [];
    for (let at = clock.now().getTime(), n = 0; at < end; at += 10 * 60_000, n += 1) {
      clock.advanceTo(at);
      pushed.push(`r${n}`);
      center.push(reminder(`r${n}`));
    }
    clock.advanceTo(end + 24 * 3_600_000);

    const weekdays = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
    for (const { at } of shown) {
      const local = ist(at);
      const inEveningBlock =
        weekdays.has(local.weekday) && local.minutes >= 18 * 60 && local.minutes < 23 * 60;
      expect(inEveningBlock, `delivered at ${at.toISOString()}`).toBe(false);
      // Nor in quiet hours (23:30-08:00) or the weekday afternoon break (14:00-15:00), 02 §10 rule 4.
      const inQuietHours = local.minutes >= 23 * 60 + 30 || local.minutes < 8 * 60;
      const inNap =
        weekdays.has(local.weekday) && local.minutes >= 14 * 60 && local.minutes < 15 * 60;
      expect(inQuietHours || inNap, `delivered at ${at.toISOString()}`).toBe(false);
    }
    // Nothing is lost: every reminder is delivered, alone or merged.
    expect(shown.flatMap(({ notification }) => notification.ids).sort()).toEqual(pushed.sort());
    // Each weekday evening's 30 reminders (18:00 to 22:50) arrive at 23:00 IST, as one.
    // (The afternoon break block and the 23:30-08:00 quiet hours give merged notifications too.)
    const atEleven = shown.filter(
      ({ at, notification }) => ist(at).minutes === 23 * 60 && notification.ids.length > 1,
    );
    expect(atEleven).toHaveLength(10);
    for (const { at, notification } of atEleven) {
      expect(weekdays.has(ist(at).weekday)).toBe(true);
      expect(notification.ids).toHaveLength(30);
    }
  }, 30_000); // A two-week sweep: allow for a loaded CI runner.

  it('AC-02-09 a reminder due in that window is delivered at 23:00 as part of one merged notification', () => {
    // Fri 2026-11-13 19:15 IST (13:45Z): inside the Evening block.
    const { clock, shown, center } = harness('2026-11-13T13:45:00Z');
    expect(center.push(reminder('weekly', 'Weekly CEO review pre-read'))).toBe('held');
    clock.advanceTo('2026-11-13T16:10:00Z'); // 21:40 IST
    expect(
      center.push({
        id: 'cfm_7q2',
        kind: 'confirmation_waiting',
        title: 'A send is waiting for your confirmation',
        link: 'commandcenter://confirmations/cfm_7q2',
      }),
    ).toBe('held');
    clock.advanceTo('2026-11-13T17:29:59Z'); // 22:59:59 IST
    expect(shown).toHaveLength(0);

    clock.advanceTo('2026-11-13T17:30:00Z'); // 23:00 IST
    expect(shown).toHaveLength(1);
    const [delivered] = shown;
    expect(delivered?.at.toISOString()).toBe('2026-11-13T17:30:00.000Z');
    expect(delivered?.notification.ids).toEqual(['weekly', 'cfm_7q2']);
    expect(delivered?.notification.body).toContain('Weekly CEO review pre-read');
    expect(delivered?.notification.body).toContain('A send is waiting for your confirmation');
    // Mixed links: the merged notification opens Home.
    expect(delivered?.notification.link).toBe('commandcenter://');
    clock.advanceTo('2026-11-14T17:30:00Z');
    expect(shown).toHaveLength(1);
  });

  it('shows a notification at once outside quiet time', () => {
    // Fri 11:00 IST.
    const { shown, center } = harness('2026-11-13T05:30:00Z');
    expect(center.push(reminder('a'))).toBe('shown');
    expect(shown).toHaveLength(1);
    expect(shown[0]?.notification).toMatchObject({
      title: 'Reminder a',
      link: 'commandcenter://meeting/ins_a',
      ids: ['a'],
    });
  });

  it('does not mute weekend evenings: the block is weekdays only', () => {
    // Sat 2026-11-14 20:00 IST.
    const { shown, center } = harness('2026-11-14T14:30:00Z');
    expect(center.push(reminder('sat'))).toBe('shown');
    expect(shown).toHaveLength(1);
  });

  it('holds through quiet hours that wrap past midnight (23:30-08:00) and delivers at 08:00', () => {
    // Sat 2026-11-14 01:00 IST.
    const { clock, shown, center } = harness('2026-11-13T19:30:00Z');
    center.push(reminder('night'));
    clock.advanceTo('2026-11-14T02:29:00Z');
    expect(shown).toHaveLength(0);
    clock.advanceTo('2026-11-14T02:30:00Z'); // 08:00 IST
    expect(shown.map(({ at }) => at.toISOString())).toEqual(['2026-11-14T02:30:00.000Z']);
  });

  it('follows windows that touch: a block ending where quiet hours begin', () => {
    const policy: NotificationPolicy = {
      timeZone: IST,
      quietHours: [{ start: '23:00', end: '08:00' }],
      protectedBlocks: scenarioPolicy().protectedBlocks,
    };
    // Fri 19:00 IST: the block, then quiet hours, so 08:00 Saturday.
    expect(new Date(mutedUntil(policy, Date.parse('2026-11-13T13:30:00Z')) ?? 0)).toEqual(
      new Date('2026-11-14T02:30:00Z'),
    );
  });

  it('ignores soft protected blocks', () => {
    // Fri 10:00 IST is inside the soft "Deep block A" (09:45-12:45).
    expect(mutedUntil(scenarioPolicy(), Date.parse('2026-11-13T04:30:00Z'))).toBeUndefined();
  });

  it('mutes during a short hard block and delivers when it ends', () => {
    // Fri 14:20 IST, inside the afternoon break (14:00-15:00).
    const { clock, shown, center } = harness('2026-11-13T08:50:00Z');
    center.push(reminder('break'));
    clock.advanceTo('2026-11-13T09:30:00Z');
    expect(shown.map(({ at }) => at.toISOString())).toEqual(['2026-11-13T09:30:00.000Z']);
  });

  it('replaces a held push with the same ID', () => {
    const { clock, shown, center } = harness('2026-11-13T13:45:00Z');
    center.push(reminder('x', 'first'));
    center.push(reminder('y'));
    center.push(reminder('x', 'second'));
    clock.advanceTo('2026-11-13T17:30:00Z');
    expect(shown).toHaveLength(1);
    expect(shown[0]?.notification.ids).toEqual(['y', 'x']);
    expect(shown[0]?.notification.body).toContain('second');
    expect(shown[0]?.notification.body).not.toContain('first');
  });

  it('refuses kinds that are never pushed (02 §10 rule 3)', () => {
    const { shown, center } = harness('2026-11-13T05:30:00Z');
    const progress = { id: 'p', kind: 'sync_succeeded', title: 'Synced' } as unknown as PushRequest;
    expect(center.push(progress)).toBe('refused');
    expect(shown).toHaveLength(0);
  });

  it('applies a new policy to held pushes at once', () => {
    const { shown, center } = harness('2026-11-13T13:45:00Z');
    center.push(reminder('held'));
    expect(shown).toHaveLength(0);
    center.setPolicy({ timeZone: IST, quietHours: [], protectedBlocks: [] });
    expect(shown).toHaveLength(1);
  });

  it('shows everything at once with no policy yet', () => {
    const { shown, center } = harness('2026-11-13T13:45:00Z', null);
    expect(center.push(reminder('early'))).toBe('shown');
    expect(shown).toHaveLength(1);
  });

  it('drops held pushes when disposed', () => {
    const { clock, shown, center } = harness('2026-11-13T13:45:00Z');
    center.push(reminder('gone'));
    center.dispose();
    clock.advanceTo('2026-11-14T00:00:00Z');
    expect(shown).toHaveLength(0);
    expect(clock.pending).toBe(0);
  });

  it('lists at most five titles in a merged notification', () => {
    const merged = mergeNotifications(
      Array.from({ length: 7 }, (_, n) => reminder(`m${n}`, `Title ${n}`)),
    );
    expect(merged.title).toBe('7 notifications held during quiet time');
    expect(merged.body.split('\n')).toEqual([
      '• Title 0',
      '• Title 1',
      '• Title 2',
      '• Title 3',
      '• Title 4',
      'and 2 more',
    ]);
  });
});

describe('quiet-hours time zone handling', () => {
  it('reads wall times across a daylight-saving gap and overlap (compatible)', () => {
    const ny = 'America/New_York';
    // 2026-03-08 02:30 does not exist in New York: it moves forward to 03:30 EDT.
    expect(
      new Date(
        zonedInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, ny),
      ).toISOString(),
    ).toBe('2026-03-08T07:30:00.000Z');
    // 2026-11-01 01:30 happens twice: the earlier (EDT) instant.
    expect(
      new Date(
        zonedInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, ny),
      ).toISOString(),
    ).toBe('2026-11-01T05:30:00.000Z');
  });

  it('keeps quiet hours on the wall clock across a transition', () => {
    const policy: NotificationPolicy = {
      timeZone: 'America/New_York',
      quietHours: [{ start: '22:00', end: '07:00' }],
      protectedBlocks: [],
    };
    // Sat 2026-10-31 23:00 EDT: quiet until Sun 07:00 EST, which is 12:00Z after fall-back.
    expect(new Date(mutedUntil(policy, Date.parse('2026-11-01T03:00:00Z')) ?? 0)).toEqual(
      new Date('2026-11-01T12:00:00Z'),
    );
  });

  it('expands block rules with @cc/rhythm and reports rules outside the ADR 0001 subset', () => {
    const block = (id: string, rrule: string) => ({
      id,
      label: id,
      rrule,
      timeZone: IST,
      durationMinutes: 60,
      policy: 'hard' as const,
    });
    const policy: NotificationPolicy = {
      timeZone: IST,
      quietHours: [],
      protectedBlocks: [
        block('pb_month_end', 'FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=9;BYMINUTE=0'),
        block('pb_hourly', 'FREQ=HOURLY;BYMINUTE=0'),
      ],
    };
    expect(unsupportedBlocks(policy).map(({ id }) => id)).toEqual(['pb_hourly']);
    // Fri 2026-11-27 09:30 IST is in the last-Friday block; the Friday before is not.
    expect(new Date(mutedUntil(policy, Date.parse('2026-11-27T04:00:00Z')) ?? 0)).toEqual(
      new Date('2026-11-27T04:30:00Z'),
    );
    expect(mutedUntil(policy, Date.parse('2026-11-20T04:00:00Z'))).toBeUndefined();
  });
});
