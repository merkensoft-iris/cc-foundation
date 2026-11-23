/**
 * Names for the local API results the screens read. Each is the result type of the typed client
 * in `@cc/ui-sdk/v1`, which `pnpm cc:gen` generates from @cc/schemas (ADR 0008 decision 1), so
 * no shape here is copied by hand; records are the types of @cc/schemas. Both are imported as
 * types only: the renderer loads no package code at run time (rule D3).
 */
import type { Assert, GrantOnlyScope, ListsAll, Result, Scope } from '@cc/ui-sdk/v1';

export type {
  ActionItem,
  BackupRecord,
  BackupStatus,
  Decision,
  DomainEvent,
  Evidence,
  Goal,
  ItemSummary,
  Risk,
} from '@cc/schemas';

export type HomeResult = Result<'home.get'>;
export type ItemsListResult = Result<'items.list'>;
export type ItemReview = Result<'items.review'>;
export type ReviewOptions = ItemReview['review'];
export type HistoryResult = Result<'items.history'>;
export type DecisionRow = Result<'decisions.list'>['decisions'][number];
export type IssueRow = Result<'issues.list'>['issues'][number];
export type RiskRow = Result<'risks.list'>['risks'][number];
export type WorkstreamRow = Result<'workstreams.list'>['workstreams'][number];
export type MeasureRow = Result<'measures.list'>['measures'][number];
export type GoalRow = Result<'goals.list'>['goals'][number];
export type MeetingsListResult = Result<'meetings.list'>;
export type MeetingRow = MeetingsListResult['meetings'][number];
export type MeetingView = Result<'meetings.get'>;
export type MeetingSectionView = MeetingView['sections'][number];
export type ReadBackLine = MeetingView['readBack'][number];
export type PrincipalRow = Result<'principals.list'>['principals'][number];

/**
 * The scopes of 07 §5, in its order. `@cc/ui-sdk/v1` has the same lists (`SCOPES`,
 * `GRANT_ONLY_SCOPES`); the renderer keeps its own until it is bundled (P1-25), and
 * `ScopesListed` stops it compiling when a scope of @cc/schemas is missing.
 */
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
 * The scopes no agent has by default (07 §5 rule 3): `GrantOnlyScope` of @cc/schemas, the list
 * the core checks. Granting one is confirmed in the app shell's window (C-04-12).
 */
export const GRANT_ONLY_SCOPES = [
  'connectors:invoke',
  'discovery:request',
  'requests:propose',
  'onboarding:apply',
] as const satisfies readonly GrantOnlyScope[];
export type ScopesListed = [
  Assert<ListsAll<Scope, typeof SCOPES>>,
  Assert<ListsAll<GrantOnlyScope, typeof GRANT_ONLY_SCOPES>>,
];
