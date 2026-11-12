/**
 * Writes and their domain events. INV-03-09: every write appends exactly one DomainEvent, in
 * the same transaction. A command returns its writes as `Change`s, one event per changed
 * record, and the core service commits them together (03 §12 rule 4).
 */
import type { Actor, DomainEvent } from '@cc/schemas';

import type { DomainContext } from './context.js';

const AUDIT_FIELDS = new Set(['createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'version']);

/** The audit fields of 03 §3. */
export interface Audited {
  readonly createdAt: string;
  readonly createdBy: Actor;
  readonly updatedAt: string;
  readonly updatedBy: Actor;
  readonly version: number;
}

/**
 * The entity kinds the domain and the rhythm engine write, as `DomainEvent.entity.kind` and the
 * event type prefix.
 */
export type EntityKind =
  | 'action_item'
  | 'decision'
  | 'issue'
  | 'risk'
  | 'evidence'
  | 'goal'
  | 'measure_value'
  | 'meeting_series'
  | 'meeting_instance'
  | 'workstream';

export interface Change<T = unknown> {
  readonly kind: EntityKind;
  readonly record: T;
  readonly event: DomainEvent;
}

/** A command's result. `no-op` writes nothing (C-03-01); `record` is the main record. */
export interface Outcome<T> {
  readonly status: 'ok' | 'no-op';
  readonly record: T;
  readonly changes: readonly Change[];
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The top-level fields that differ, audit fields left out: the event's `before` and `after`. */
export function changedFields(
  before: object | undefined,
  after: object,
): { before?: Record<string, unknown>; after: Record<string, unknown> } {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  const out: { before: Record<string, unknown>; after: Record<string, unknown> } = {
    before: {},
    after: {},
  };
  for (const key of keys) {
    if (AUDIT_FIELDS.has(key) || equal(b[key], a[key])) continue;
    if (key in b) out.before[key] = b[key];
    if (key in a) out.after[key] = a[key];
  }
  return before === undefined ? { after: out.after } : out;
}

/** The audit fields of a new record. */
export function created(ctx: DomainContext, actor: Actor): Audited {
  const now = ctx.clock.now();
  return { createdAt: now, createdBy: actor, updatedAt: now, updatedBy: actor, version: 1 };
}

/** The record with its audit fields advanced: one more version, by this actor, now. */
export function touched<T extends Audited>(ctx: DomainContext, record: T, actor: Actor): T {
  return { ...record, updatedAt: ctx.clock.now(), updatedBy: actor, version: record.version + 1 };
}

export interface EventSpec {
  readonly kind: EntityKind;
  readonly verb: string;
  readonly entity: { readonly id: string; readonly ref?: string };
  readonly before: object | undefined;
  readonly after: object;
  readonly actor: Actor;
  /** Extra fields for the event's `after`, such as a reason that has no field of its own. */
  readonly extra?: Record<string, unknown>;
  readonly correlationId?: string;
}

/** One write and its one event (INV-03-09). */
export function change<T extends object>(
  ctx: DomainContext,
  spec: EventSpec & { after: T },
): Change<T> {
  const fields = changedFields(spec.before, spec.after);
  const event: DomainEvent = {
    id: ctx.ids.id('evt'),
    at: ctx.clock.now(),
    actor: spec.actor,
    type: `${spec.kind}.${spec.verb}`,
    entity: {
      kind: spec.kind,
      id: spec.entity.id,
      ...(spec.entity.ref === undefined ? {} : { ref: spec.entity.ref }),
    },
    ...(fields.before === undefined ? {} : { before: fields.before }),
    after: { ...fields.after, ...spec.extra },
    ...(spec.correlationId === undefined ? {} : { correlationId: spec.correlationId }),
  };
  return { kind: spec.kind, record: spec.after, event };
}

/** Removes optional keys whose value is undefined (exactOptionalPropertyTypes). */
export function omitKeys<T extends object, K extends keyof T>(record: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...record };
  for (const key of keys) delete copy[key];
  return copy;
}
