/**
 * What the invariant validators read: a framework instance and the records it governs, as
 * plain views. The store, domain and rhythm packages own the records; the caller (core)
 * assembles this snapshot, so the validators stay pure (D4). A collection the caller leaves
 * out is not checked: the meeting-time invariants (E-5, E-6, X-5) need the meeting's
 * outputs, which only exist while a meeting runs.
 */
import type { ActionItem, FrameworkInstance, Goal, Issue, Measure } from '@cc/schemas';

/** The parts of a FrameworkInstance the validators read. */
export type InstanceView = Pick<
  FrameworkInstance,
  'templateId' | 'templateVersion' | 'mode' | 'goalModel' | 'packIds' | 'parameters'
> &
  Partial<Pick<FrameworkInstance, 'id' | 'workstreamId' | 'forkedFrom'>>;

/** Agenda section types of 02 §3. */
export type AgendaSectionType =
  | 'attention'
  | 'check_in'
  | 'scorecard'
  | 'goals_review'
  | 'action_review'
  | 'headlines'
  | 'issues'
  | 'decision_queue'
  | 'plan_commitments'
  | 'pipeline_review'
  | 'content_review'
  | 'money_ops'
  | 'register_health'
  | 'risk_review'
  | 'rhythm_health'
  | 'top_three'
  | 'day_close'
  | 'planning'
  | 'retrospective'
  | 'conclude';

/** A meeting series of 02 §3 that carries this instance's meetings. */
export interface SeriesView {
  readonly id: string;
  /** The BackboneMeeting key, e.g. "weekly". */
  readonly backboneMeetingKey: string;
  readonly status: 'active' | 'paused' | 'ended';
  /** More than one: a merged series (02 §4.4). */
  readonly workstreamIds: readonly string[];
  /** RFC 5545, local to the series time zone. */
  readonly rrule: string;
  readonly durationMinutes: number;
  /** Section types in agenda order; a merged series repeats its perWorkstream sections. */
  readonly agenda: readonly AgendaSectionType[];
}

/**
 * The parts of a Goal (03 §5.3) the validators read. IDs are plain strings, and a missing
 * owner (a draft) is an absent `ownerId`.
 */
export interface GoalView {
  readonly id: string;
  readonly kind: Goal['kind'];
  readonly status: Goal['status'];
  readonly ownerId?: string;
  readonly doneMeans?: string;
  readonly measureIds: readonly string[];
  readonly target?: Goal['target'];
  readonly grade?: number;
}

/** The parts of a Measure (03 §5.4) the validators read. */
export interface MeasureView {
  readonly id: string;
  readonly role: Measure['role'];
  readonly cadence: Measure['cadence'];
  readonly active: boolean;
  readonly ownerId?: string;
  readonly target?: Measure['target'];
}

/** The parts of an ActionItem (03 §5.7) the validators read. */
export interface ActionItemView {
  readonly id: string;
  readonly kind: ActionItem['kind'];
  readonly ownerId?: string;
  readonly doneMeans: string;
  readonly lifecycle: ActionItem['lifecycle'];
  readonly due?: { readonly date: string };
  /** The local date the item was created, in the workstream's time zone. */
  readonly createdOn: string;
  /** The goals (priorities, WIGs) the item links to. */
  readonly goalIds: readonly string[];
}

export interface DecisionView {
  readonly id: string;
  readonly deciderId?: string;
}

/** The parts of an Issue (03 §5.6) the validators read. */
export interface IssueView {
  readonly id: string;
  readonly status: Issue['status'];
  readonly resolution?: Pick<NonNullable<Issue['resolution']>, 'kind' | 'refs' | 'note'>;
}

/** The `action_review` outcomes captured in a running meeting (E-5). */
export interface ActionReviewOutcome {
  readonly actionItemId: string;
  readonly outcome: string;
}

/** A pre-read about to be built (X-5). */
export interface PrereadView {
  readonly leadMeasureIdsWithValue: readonly string[];
  readonly flaggedMeasureIds: readonly string[];
}

export interface InstanceState {
  readonly workstreamId: string;
  readonly instance: InstanceView;
  /** Every series that carries a meeting of this instance, merged series included. */
  readonly series: readonly SeriesView[];
  /** The instance's goals for the current period. */
  readonly goals: readonly GoalView[];
  readonly measures: readonly MeasureView[];
  readonly actionItems?: readonly ActionItemView[];
  readonly decisions?: readonly DecisionView[];
  readonly issues?: readonly IssueView[];
  readonly actionReview?: readonly ActionReviewOutcome[];
  readonly preread?: PrereadView;
}
