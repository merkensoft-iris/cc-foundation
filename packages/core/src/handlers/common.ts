/**
 * What every store-backed handler shares: who may see which workstream (07 §5, C-03-03),
 * resolving refs, persons and limits, and the display state and local time of 07 §4.3.
 */
import { isPastDue, localDate, localDateTime } from '@cc/domain';
import type { ActionItem, Person, Workspace, Workstream } from '@cc/schemas';
import type { ReadTx, StoreRecords, TableName } from '@cc/store';

import type { HandlerContext } from '../dispatch.js';
import { CoreError } from '../errors.js';
import type { PrincipalSummary } from '../principals.js';

/** A row without the store's `version` column, for records whose schema has none. */
export function withoutVersion<T extends object>(row: T & { version?: number }): T {
  const record = { ...row } as Record<string, unknown>;
  delete record['version'];
  return record as T;
}

/** Lists default to 50 entries (07 §4.1 rule 2). */
export const DEFAULT_LIMIT = 50;

export function limitOf(params: { limit?: number | undefined }): number {
  return params.limit ?? DEFAULT_LIMIT;
}

/**
 * Whether the caller sees a workstream: the user sees all; an agent principal sees the
 * workstreams of its filter, and a sensitive workstream only with `sensitiveAccess` (07 §5).
 */
export function seesWorkstream(
  principal: PrincipalSummary | undefined,
  workstream: Pick<Workstream, 'id' | 'privacy'> | undefined,
): boolean {
  if (principal === undefined) return true;
  if (workstream === undefined) return false;
  if (principal.workstreamFilter !== 'all' && !principal.workstreamFilter.includes(workstream.id)) {
    return false;
  }
  return workstream.privacy !== 'sensitive' || principal.sensitiveAccess;
}

/** A visibility check over one read transaction, caching the workstreams it looks up. */
export class Visibility {
  readonly #tx: ReadTx;
  readonly #principal: PrincipalSummary | undefined;
  readonly #cache = new Map<string, boolean>();

  constructor(tx: ReadTx, context: HandlerContext) {
    this.#tx = tx;
    this.#principal = context.principal;
  }

  /** Whether the caller sees records of this workstream. */
  workstream(id: string): boolean {
    let seen = this.#cache.get(id);
    if (seen === undefined) {
      seen = seesWorkstream(this.#principal, this.#tx.get('workstreams', id));
      this.#cache.set(id, seen);
    }
    return seen;
  }

  /** Whether the caller sees a record of one or more workstreams (any of them). */
  record(record: { workstreamId: string } | { workstreamIds: readonly string[] }): boolean {
    return 'workstreamId' in record
      ? this.workstream(record.workstreamId)
      : record.workstreamIds.some((id) => this.workstream(id));
  }

  /** Whether the caller sees every record of the workspace (an export, C-03-06). */
  get everything(): boolean {
    const principal = this.#principal;
    return (
      principal === undefined || (principal.workstreamFilter === 'all' && principal.sensitiveAccess)
    );
  }
}

type RefTable = 'action_items' | 'decisions' | 'issues' | 'measures' | 'goals';

const NOUN: Record<RefTable, { noun: string; list: string }> = {
  action_items: { noun: 'action item', list: 'cc-axi items list' },
  decisions: { noun: 'decision', list: 'cc-axi decisions list' },
  issues: { noun: 'issue', list: 'cc-axi issues list' },
  measures: { noun: 'measure', list: 'cc-axi measures list' },
  goals: { noun: 'goal', list: 'cc-axi goals list' },
};

export function notFound(noun: string, ref: string, list: string): CoreError {
  return new CoreError('E_NOT_FOUND', `no ${noun} ${ref}`, [`Run \`${list}\` to find one`]);
}

/**
 * A record by HumanRef (`A-0142`) or ID (`act_…`) that the caller may see; one it may not
 * see is reported as not found, so its existence does not leak (07 §5).
 */
export function findByRef<K extends RefTable>(
  tx: ReadTx,
  visibility: Visibility,
  table: K,
  ref: string,
): StoreRecords[K] {
  const found = /^[A-Z]-\d+$/.test(ref)
    ? tx.list(table).find((record) => (record as { ref: string }).ref === ref)
    : tx.get(table, ref);
  if (found === undefined || !visibility.record(found as never)) {
    throw notFound(NOUN[table].noun, ref, NOUN[table].list);
  }
  return found;
}

/** A workstream by slug or `ws_` ID that the caller may see. */
export function findWorkstream(tx: ReadTx, visibility: Visibility, ref: string): Workstream {
  const found = ref.startsWith('ws_')
    ? tx.get('workstreams', ref)
    : tx.list('workstreams').find((workstream) => workstream.slug === ref);
  if (found === undefined || !visibility.workstream(found.id)) {
    throw notFound('workstream', ref, 'cc-axi workstreams list');
  }
  return found;
}

/** The workspace record; a profile that has none is not set up yet. */
export function workspaceOf(tx: ReadTx): Workspace {
  const workspace = tx.list('workspace', { limit: 1 })[0];
  if (workspace === undefined) {
    throw new CoreError('E_NOT_FOUND', 'this profile has no workspace yet', [
      'Set up the workspace in the app first',
    ]);
  }
  return workspace;
}

/** A person by `me`, a `per_` ID or a display name (the `PersonRef` of the API). */
export function findPerson(tx: ReadTx, ref: string): Person {
  const found =
    ref === 'me'
      ? tx.get('persons', workspaceOf(tx).selfPersonId)
      : ref.startsWith('per_')
        ? tx.get('persons', ref)
        : tx.list('persons').find((person) => person.displayName === ref);
  if (found === undefined) {
    throw new CoreError('E_NOT_FOUND', `no person ${ref}`, [
      'Use `me`, a per_ ID or a display name',
    ]);
  }
  return found;
}

/** Lifecycles that are not `overdue` once past due: claimed or closed (07 §4.3). */
const NEVER_OVERDUE: ReadonlySet<ActionItem['lifecycle']> = new Set([
  'claimed_done',
  'verified_done',
  'dropped',
]);

/** Closed lifecycles; `active` is every other one (`items.list --state active`). */
export const CLOSED: ReadonlySet<ActionItem['lifecycle']> = new Set(['verified_done', 'dropped']);

/** The display state of 07 §4.3: `overdue` when past due and not claimed, else the lifecycle. */
export function displayState(item: ActionItem, now: string): ActionItem['lifecycle'] | 'overdue' {
  return !NEVER_OVERDUE.has(item.lifecycle) && isPastDue(item.due, now)
    ? 'overdue'
    : item.lifecycle;
}

/** Overdue first, then by due date, then by ref (07 §4.3, the home view's order). */
export function byUrgency(now: string): (a: ActionItem, b: ActionItem) => number {
  return (a, b) =>
    Number(displayState(b, now) === 'overdue') - Number(displayState(a, now) === 'overdue') ||
    a.due.date.localeCompare(b.due.date) ||
    a.ref.localeCompare(b.ref);
}

/** `instant` as local time in `timeZone` with its UTC offset: 2026-11-13T09:02:00+05:30. */
export function localWithOffset(instant: Date, timeZone: string): string {
  const local = localDateTime(instant.toISOString(), timeZone);
  const whole = new Date(Math.floor(instant.getTime() / 1000) * 1000);
  const minutes = Math.round((Date.parse(`${local}Z`) - whole.getTime()) / 60_000);
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${local}${offset}`;
}

/** Today's date in `timeZone`, and the date `days` later. */
export function localToday(instant: Date, timeZone: string, days = 0): string {
  return localDate(new Date(instant.getTime() + days * 86_400_000).toISOString(), timeZone);
}

/** The table a search type reads (03 §12 `fts_items`). Meetings arrive with P1-07/P1-08. */
export const SEARCH_TABLES: Record<'items' | 'decisions' | 'issues', TableName> = {
  items: 'action_items',
  decisions: 'decisions',
  issues: 'issues',
};
