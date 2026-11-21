/**
 * The principal scopes of 07 §5, for a UI that shows or edits agent access. The lists are
 * checked against @cc/schemas when this package compiles (`ListsAll`) and by its tests, so a
 * scope added to the schemas cannot be missing here; the package loads no @cc/schemas code at
 * run time (rule D3).
 */
import type { GrantOnlyScope, Scope } from '@cc/schemas';

export type { GrantOnlyScope, Scope };

/** `true` only when `List` names every member of `Union`. */
export type ListsAll<Union, List extends readonly Union[]> = [
  Exclude<Union, List[number]>,
] extends [never]
  ? true
  : false;

/** The scopes, in the order of 07 §5. */
export const SCOPES = [
  'read',
  'items:write',
  'items:claim',
  'decisions:propose',
  'meetings:capture',
  'measures:write',
  'connectors:read',
  'connectors:invoke',
  'sessions:read',
  'discovery:request',
  'requests:propose',
  'onboarding:apply',
] as const satisfies readonly Scope[];

/**
 * The scopes no agent has by default (07 §5 rule 3); granting one is confirmed in the app
 * shell's window, not on a screen (04 §4.3 rule 4, C-04-12).
 */
export const GRANT_ONLY_SCOPES = [
  'connectors:invoke',
  'discovery:request',
  'requests:propose',
  'onboarding:apply',
] as const satisfies readonly GrantOnlyScope[];

/** Compiles only when `T` is `true`. */
export type Assert<T extends true> = T;

/** Fails to compile when either list misses a scope of @cc/schemas. */
export type ScopeListsComplete = [
  Assert<ListsAll<Scope, typeof SCOPES>>,
  Assert<ListsAll<GrantOnlyScope, typeof GRANT_ONLY_SCOPES>>,
];
