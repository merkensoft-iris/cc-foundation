/**
 * What every domain command is given. The domain is pure (D4, 08 §4.2): the clock, the ID
 * source and the read-only view of other records are passed in, never reached for.
 */
import type {
  ActionItem,
  Actor,
  HumanRefKind,
  ID_PREFIXES,
  Person,
  Scope,
  Workstream,
} from '@cc/schemas';

import type { Violation } from './errors.js';
import type { PersonId, WorkstreamId } from './types.js';

/** The injected clock. `now()` is an RFC 3339 UTC timestamp, e.g. "2026-11-13T09:30:00Z". */
export interface Clock {
  now(): string;
}

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

/** The injected ID source: `<prefix>_<ULID>` IDs and the workspace's HumanRef counters. */
export interface IdSource {
  id<P extends IdPrefix>(prefix: P): `${P}_${string}`;
  /** The next HumanRef of a kind, e.g. "A-0143"; the store advances the counter. */
  ref(kind: HumanRefKind): string;
}

/**
 * A framework validator (INV-03-12), such as eos-lite E-4. It runs on every write that touches
 * an item of a workstream on that framework and returns the rules the item breaks.
 */
export type FrameworkValidator = (item: ActionItem, now: string) => readonly Violation[];

/** Read-only lookups a command checks references against. The core backs them by the store. */
export interface Registry {
  /** The workspace's self person (`Workspace.selfPersonId`): default owner, reviewer, decider. */
  readonly selfPersonId: PersonId;
  person(id: PersonId): Person | undefined;
  workstream(id: WorkstreamId): Workstream | undefined;
  /** Whether the bound connector's installed manifest has this action (INV-03-08). */
  connectorHasAction(bindingId: string, action: string): boolean;
  /** The framework validators for a workstream's framework instance (INV-03-12). */
  validators(workstreamId: WorkstreamId): readonly FrameworkValidator[];
}

export interface DomainContext {
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly registry: Registry;
}

/**
 * Who is calling. `scopes` are the agent principal's scopes (07 §5); they matter only for
 * actors of kind `agent`.
 */
export interface Caller {
  readonly actor: Actor;
  readonly scopes?: readonly Scope[];
}

export function isUser(caller: Caller): boolean {
  return caller.actor.kind === 'user';
}

export function hasScope(caller: Caller, scope: Scope): boolean {
  return caller.actor.kind === 'agent' && (caller.scopes ?? []).includes(scope);
}

export function isSystem(caller: Caller, ...components: string[]): boolean {
  return (
    caller.actor.kind === 'system' &&
    (components.length === 0 || components.includes(caller.actor.component))
  );
}
