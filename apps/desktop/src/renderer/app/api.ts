/**
 * The local API results the screens read (packages/schemas/api/<method>.json). Records are the
 * types of @cc/schemas, imported as types only: the renderer loads no package code at run time
 * (rule D3).
 */
import type {
  ActionItem,
  AgentPrincipal,
  Decision,
  DomainEvent,
  Evidence,
  Goal,
  ItemSummary,
  MeetingInstance,
  Risk,
} from '@cc/schemas';

export type { ActionItem, Decision, DomainEvent, Evidence, Goal, ItemSummary, Risk };

export interface HomeResult {
  readonly workspace: string;
  readonly now: string;
  readonly today: readonly { ref: string; time: string; title: string }[];
  readonly attention: {
    readonly overdue: number;
    readonly atRisk: number;
    readonly awaitingReview: number;
    readonly confirmationsPending: number;
    readonly sessionsNeedingYou: number;
  };
  readonly items: readonly ItemSummary[];
  readonly counts: { readonly dueSoon: number; readonly open: number };
}

export interface ItemsListResult {
  readonly items: readonly ItemSummary[];
  readonly total: number;
}

export interface ReviewOptions {
  readonly confirm: { readonly enabled: boolean; readonly reason?: string };
  readonly attest: { readonly enabled: boolean };
  readonly reject: { readonly enabled: boolean };
  readonly notCheckable: readonly string[];
}

export interface ItemReview {
  readonly item: ActionItem;
  readonly evidence: readonly Evidence[];
  readonly review: ReviewOptions;
}

export interface HistoryResult {
  readonly events: readonly DomainEvent[];
  readonly total: number;
}

export interface DecisionRow {
  readonly ref: string;
  readonly question: string;
  readonly status: Decision['status'];
  readonly dueBy?: string;
}

export interface IssueRow {
  readonly ref: string;
  readonly title: string;
  readonly status: 'open' | 'resolved' | 'dropped';
  readonly rank?: number;
}

export interface RiskRow {
  readonly ref: string;
  readonly description: string;
  readonly trigger: string;
  readonly status: Risk['status'];
  readonly workstream: string;
}

export interface WorkstreamRow {
  readonly slug: string;
  readonly name: string;
  readonly kind: string;
  readonly status: string;
}

export interface MeasureRow {
  readonly ref: string;
  readonly name: string;
  readonly unit: string;
  readonly target: unknown;
  readonly latest?: { periodStart: string; value: number | boolean; normal: boolean | null };
}

export interface GoalRow {
  readonly ref: string;
  readonly title: string;
  readonly kind: string;
  readonly status: string;
  readonly health: string;
}

export interface MeetingRow {
  readonly ref: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly state: MeetingInstance['state'];
  readonly agendaTemplateId: string;
}

export interface MeetingsListResult {
  readonly from: string;
  readonly to: string;
  readonly timeZone: string;
  readonly meetings: readonly MeetingRow[];
  readonly total: number;
}

export interface MeetingSectionView {
  readonly sectionId: string;
  readonly workstreamId?: string;
  readonly absorbedFrom?: string;
  readonly title: string;
  readonly type: string;
  readonly timeboxMinutes: number;
  readonly status: 'pending' | 'done' | 'skipped';
  readonly allowedOutputs: readonly string[];
  readonly rows: readonly { ref: string; title: string; flags: readonly string[] }[];
}

export interface ReadBackLine {
  readonly kind: 'action_item' | 'decision';
  readonly ref: string;
  readonly owner: string;
  readonly ownerPresent: boolean;
  readonly deliverable: string;
  readonly due?: string;
  readonly doneMeans?: string;
  readonly state: string;
}

export interface MeetingView {
  readonly meeting: MeetingInstance;
  readonly title: string;
  readonly agendaTemplateId: string;
  readonly timeZone: string;
  readonly sections: readonly MeetingSectionView[];
  readonly readBack: readonly ReadBackLine[];
}

export type PrincipalRow = Pick<
  AgentPrincipal,
  'name' | 'kind' | 'scopes' | 'workstreamFilter' | 'sensitiveAccess' | 'lastUsedAt' | 'revokedAt'
>;

/** The scopes of 07 §5, in its order. */
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
] as const;
