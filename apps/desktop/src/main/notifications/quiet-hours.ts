/**
 * When notifications are muted (02 §10 rule 4): during quiet hours, and during `hard`
 * protected blocks. `soft` blocks do not mute.
 *
 * Quiet hours are wall-clock ranges in the workspace time zone; a range whose end is not
 * after its start wraps past midnight (`23:30`-`08:00`). A protected block repeats by its
 * RRULE in its own time zone and lasts `durationMinutes`.
 *
 * Times are read with the built-in Intl time-zone data, as `@cc/domain` does. A wall time in
 * a daylight-saving gap moves forward past the gap, and one in an overlap takes the earlier
 * instant (RFC 5545 §3.3.5, ADR 0001 decision 7, `compatible`).
 *
 * Protected blocks are expanded by `@cc/rhythm`'s `blockIntervals` (09 P1-07, ADR 0001), the
 * same expansion placement uses, so a block mutes exactly when it keeps meetings out. A block
 * whose rule is outside the ADR 0001 subset is reported by `unsupportedBlocks` and does not
 * mute.
 */
import { blockIntervals } from '@cc/rhythm';
import { parseRRule, type ProtectedBlock } from '@cc/schemas';

import type { NotificationPolicy } from '../../shared/protocol.js';

/** A muted interval, in epoch milliseconds, end exclusive. */
export interface MuteWindow {
  readonly start: number;
  readonly end: number;
  /** `quiet-hours` or the protected block's ID. */
  readonly source: string;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// --- Time zones ---------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, format);
  }
  return format;
}

interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

function wallTime(epochMs: number, timeZone: string): WallTime & { second: number } {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts['year'] ?? 0,
    month: parts['month'] ?? 0,
    day: parts['day'] ?? 0,
    hour: parts['hour'] ?? 0,
    minute: parts['minute'] ?? 0,
    second: parts['second'] ?? 0,
  };
}

/** The zone's offset from UTC at an instant, in milliseconds. */
function offsetAt(epochMs: number, timeZone: string): number {
  const whole = Math.floor(epochMs / 1000) * 1000;
  const wall = wallTime(whole, timeZone);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - whole;
}

/** The instant of a wall-clock time in a zone (`compatible` disambiguation). */
export function zonedInstant(wall: WallTime, timeZone: string): number {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const before = offsetAt(asUtc - DAY, timeZone);
  const after = offsetAt(asUtc + DAY, timeZone);
  const valid = [before, after]
    .map((offset) => asUtc - offset)
    .filter((instant) => asUtc - offsetAt(instant, timeZone) === instant)
    .sort((a, b) => a - b);
  // In an overlap both are valid: take the earlier. In a gap neither is: shift forward,
  // reading the wall time with the offset from before the transition.
  return valid[0] ?? asUtc - before;
}

/** The local calendar date of an instant in a zone, as a UTC-midnight day number. */
function localDay(epochMs: number, timeZone: string): number {
  const wall = wallTime(epochMs, timeZone);
  return Date.UTC(wall.year, wall.month - 1, wall.day) / DAY;
}

function dateOfDay(day: number): { year: number; month: number; day: number } {
  const date = new Date(day * DAY);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function parseLocalTime(time: string): { hour: number; minute: number } | undefined {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(time);
  if (match === null) return undefined;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

// --- Protected blocks ----------------------------------------------------------------------

function hardBlocks(policy: NotificationPolicy): ProtectedBlock[] {
  return policy.protectedBlocks.filter((block) => block.policy === 'hard');
}

/** The `hard` blocks whose rule is outside the ADR 0001 subset (they do not mute). */
export function unsupportedBlocks(policy: NotificationPolicy): ProtectedBlock[] {
  return hardBlocks(policy).filter((block) => !parseRRule(block.rrule).ok);
}

/** Block occurrences by policy, then block ID and UTC day; a new policy starts afresh. */
const blockCache = new WeakMap<NotificationPolicy, Map<string, readonly MuteWindow[]>>();
const BLOCK_CACHE_DAYS = 512;

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The occurrences of a `hard` block that touch one UTC day (the day number since the epoch). */
function blockWindows(
  policy: NotificationPolicy,
  block: ProtectedBlock,
  day: number,
): readonly MuteWindow[] {
  if (block.durationMinutes <= 0 || !parseRRule(block.rrule).ok) return [];
  let cache = blockCache.get(policy);
  if (cache === undefined) {
    cache = new Map();
    blockCache.set(policy, cache);
  }
  const key = `${block.id}@${day}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let windows: MuteWindow[];
  try {
    windows = blockIntervals([block], iso(day * DAY), iso((day + 1) * DAY)).map((interval) => ({
      start: Date.parse(interval.start),
      end: Date.parse(interval.end),
      source: block.id,
    }));
  } catch {
    // An unknown time zone: the block cannot be placed, so it does not mute either.
    windows = [];
  }
  if (cache.size >= BLOCK_CACHE_DAYS) cache.clear();
  cache.set(key, windows);
  return windows;
}

// --- Windows ------------------------------------------------------------------------------

/** The mute windows around `at`: quiet hours of the days either side, and block occurrences touching it. */
function windowsNear(policy: NotificationPolicy, at: number): MuteWindow[] {
  const windows: MuteWindow[] = [];

  const quietDay = localDay(at, policy.timeZone);
  for (let day = quietDay - 1; day <= quietDay + 1; day += 1) {
    const date = dateOfDay(day);
    for (const range of policy.quietHours) {
      const start = parseLocalTime(range.start);
      const end = parseLocalTime(range.end);
      if (start === undefined || end === undefined) continue;
      const startMinutes = start.hour * 60 + start.minute;
      const endMinutes = end.hour * 60 + end.minute;
      if (startMinutes === endMinutes) continue;
      const endDate = endMinutes > startMinutes ? date : dateOfDay(day + 1);
      windows.push({
        start: zonedInstant({ ...date, ...start }, policy.timeZone),
        end: zonedInstant({ ...endDate, ...end }, policy.timeZone),
        source: 'quiet-hours',
      });
    }
  }

  const day = Math.floor(at / DAY);
  for (const block of hardBlocks(policy)) {
    for (const window of blockWindows(policy, block, day)) windows.push(window);
  }
  return windows;
}

/** The mute windows that contain `at`. */
export function windowsAt(policy: NotificationPolicy, at: number): MuteWindow[] {
  return windowsNear(policy, at).filter((window) => window.start <= at && at < window.end);
}

/**
 * When the mute that covers `at` ends, following windows that touch or overlap; `undefined`
 * when `at` is not muted. A notification due at `at` is delivered at this instant.
 */
export function mutedUntil(policy: NotificationPolicy | undefined, at: number): number | undefined {
  if (policy === undefined) return undefined;
  let until: number | undefined;
  let probe = at;
  // Each step moves past at least one window; 64 steps is far beyond any real policy.
  for (let step = 0; step < 64; step += 1) {
    const covering = windowsAt(policy, probe);
    if (covering.length === 0) return until;
    until = Math.max(...covering.map((window) => window.end));
    probe = until;
  }
  return until;
}
