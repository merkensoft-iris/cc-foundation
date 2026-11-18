/**
 * The retention rule of the local set and the off-machine copies (04 §9.1 rules 4 and 5):
 * 7 daily and 4 weekly archives by default.
 *
 * Daily: the newest archive of each of the `daily` most recent days that have one. Weekly:
 * among the archives older than the oldest daily day, the newest of each of the `weekly` most
 * recent ISO weeks (Monday to Sunday) that have one. The two never overlap, so a full set is
 * `daily + weekly` archives covering about five weeks. Days and weeks are the workspace's
 * local calendar.
 */

export interface Retention {
  readonly daily: number;
  readonly weekly: number;
}

export const DEFAULT_RETENTION: Retention = { daily: 7, weekly: 4 };

export interface Dated {
  readonly id: string;
  /** RFC 3339 UTC. */
  readonly at: string;
}

export interface Kept {
  readonly daily: readonly string[];
  readonly weekly: readonly string[];
}

/** `YYYY-MM-DD` of `at` in `timeZone`. */
export function localDay(at: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(at));
}

/** The Monday that starts the ISO week of a `YYYY-MM-DD` day. */
export function weekOf(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const back = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - back);
  return date.toISOString().slice(0, 10);
}

/** Which archives the rule keeps; every other one is pruned. */
export function selectKept(
  archives: readonly Dated[],
  retention: Retention,
  timeZone: string,
): Kept {
  const newestFirst = [...archives].sort((a, b) =>
    a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1,
  );
  const days = new Map<string, string>();
  for (const archive of newestFirst) {
    const day = localDay(archive.at, timeZone);
    if (days.has(day)) continue;
    if (days.size === retention.daily) break;
    days.set(day, archive.id);
  }
  const daily = [...days.values()];
  const oldestDaily = [...days.keys()].at(-1);
  const weeks = new Map<string, string>();
  for (const archive of newestFirst) {
    const day = localDay(archive.at, timeZone);
    if (oldestDaily !== undefined && day >= oldestDaily) continue;
    const week = weekOf(day);
    if (weeks.has(week)) continue;
    if (weeks.size === retention.weekly) break;
    weeks.set(week, archive.id);
  }
  return { daily, weekly: [...weeks.values()] };
}
