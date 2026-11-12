/**
 * The table registry: for every table of 03 §12 point 2, which columns hold which record
 * field, which schema in @cc/schemas validates the record, and what goes into `fts_items`.
 *
 * 03 §12 point 3 is the rule this file encodes: scalar fields are columns, nested structures
 * are JSON columns, "validated by the same schemas as the API" - which is P1-01's
 * `recordTypes` and `validateRecord`, used here rather than redefined.
 *
 * `@cc/schemas` has a record type for only some of the tables; the others "arrive with the
 * build steps that specify them". A table without a schema has `schema: undefined` and the
 * storage envelope of `UnspecifiedRecord`: its `doc` must be well-formed JSON and nothing
 * more. No shape is guessed here. packages/store/migrations/0001_init.sql lists the same
 * split, and `unvalidatedTables()` names the build step that adds each missing record type.
 * A build step that specifies a record adds a migration with its columns and replaces the
 * envelope here: 0002_meetings did so for meeting_series and meeting_instances (P1-07).
 */
import {
  ExecutionStep,
  recordTypes,
  VerificationRecord,
  type ActionItem,
  type Actor,
  type AgentPrincipal,
  type Decision,
  type DomainEvent,
  type Evidence,
  type FrameworkInstance,
  type Goal,
  type Issue,
  type Measure,
  type MeasureValue,
  type MeetingInstance,
  type MeetingSeries,
  type Person,
  type RecordType,
  type Risk,
  type Run,
  type Workspace,
  type Workstream,
} from '@cc/schemas';

/** A row of a table whose record type is not written yet (see the file comment). */
export interface UnspecifiedRecord {
  readonly id: string;
  /** The record, as the build step that specifies it will define it. */
  readonly doc: Record<string, unknown>;
  readonly createdAt: string;
  readonly createdBy: Actor;
  readonly updatedAt: string;
  readonly updatedBy: Actor;
  readonly version: number;
}

/** One row of `execution_steps`: a step of 03 §5.8 with the item it belongs to. */
export type ExecutionStepRow = ExecutionStep & {
  readonly actionItemId: ActionItem['id'];
  readonly version: number;
};

/** One row of `verifications`: the verification record of 03 §5.9 with its item. */
export type VerificationRow = VerificationRecord & {
  readonly actionItemId: ActionItem['id'];
  readonly version: number;
};

/** Record types whose schema has no `version`; the store owns the column (03 §12 point 3). */
type Versioned<T> = T & { readonly version: number };

/** Every table of 03 §12 point 2 with the record it stores. */
export interface StoreRecords {
  readonly workspace: Workspace;
  readonly persons: Person;
  readonly workstreams: Workstream;
  readonly framework_instances: FrameworkInstance;
  readonly goals: Goal;
  readonly measures: Measure;
  readonly measure_values: Versioned<MeasureValue>;
  readonly decisions: Decision;
  readonly issues: Issue;
  readonly risks: Risk;
  readonly action_items: ActionItem;
  readonly execution_steps: ExecutionStepRow;
  readonly runs: Versioned<Run>;
  readonly evidence: Versioned<Evidence>;
  readonly verifications: VerificationRow;
  readonly meeting_series: MeetingSeries;
  readonly meeting_instances: MeetingInstance;
  readonly connector_installs: UnspecifiedRecord;
  readonly connector_bindings: UnspecifiedRecord;
  readonly browser_sessions: UnspecifiedRecord;
  readonly confirmations: UnspecifiedRecord;
  readonly standing_approvals: UnspecifiedRecord;
  readonly agent_principals: AgentPrincipal;
  readonly development_requests: UnspecifiedRecord;
  readonly backup_runs: UnspecifiedRecord;
  readonly events: Versioned<DomainEvent>;
}

export type TableName = keyof StoreRecords;

export type ColumnKind = 'text' | 'integer' | 'real' | 'boolean' | 'json';

export interface ColumnSpec {
  /** The SQL column in packages/store/migrations/0001_init.sql. */
  readonly column: string;
  /** Dot path of the record field it holds, e.g. "due.date". */
  readonly field: string;
  readonly kind: ColumnKind;
  /** The field may be absent; the column is then NULL and the field is left out on read. */
  readonly optional?: boolean;
  /** The field is always present and may be null, as `MeasureValue.normal` is. */
  readonly nullable?: boolean;
}

/** What of a record goes into `fts_items` (03 §12 point 2: titles, done-means and notes). */
export interface FtsSpec {
  readonly ref?: string;
  readonly title: string;
  readonly doneMeans?: string;
  readonly notes?: readonly string[];
}

export interface TableSpec {
  readonly table: TableName;
  /** Column names of the primary key, in order. */
  readonly primaryKey: readonly string[];
  readonly columns: readonly ColumnSpec[];
  /**
   * The record type that validates a row, or `undefined` while @cc/schemas has none. The
   * build step that adds the record type is named in `followUp`.
   */
  readonly schema?: RecordType;
  /** The build step that will add the missing record type (09 §6.1). */
  readonly followUp?: string;
  /** Fields the store owns, stripped before the record is validated. */
  readonly managedFields: readonly string[];
  /**
   * A projection of another table's record, rewritten whenever the parent is written; it is
   * never inserted or updated on its own.
   */
  readonly derivedFrom?: TableName;
  readonly fts?: FtsSpec;
  /** Fields holding a blob digest, so export copies the blob (03 §12 point 6). */
  readonly blobFields?: readonly string[];
}

const SRC = 'packages/schemas/src/records';

function record(type: string): RecordType {
  const found = recordTypes.find((entry) => entry.type === type);
  if (found === undefined) throw new Error(`@cc/schemas has no record type "${type}"`);
  return found;
}

/**
 * ExecutionStep and VerificationRecord are exported by @cc/schemas but are not entries of
 * `recordTypes`: they are nested in ActionItem rather than records of their own. Wrapping
 * them as RecordType lets `validateRecord` check the two projection tables with the same
 * schemas the API uses.
 */
const executionStepType: RecordType = {
  type: 'execution_step',
  major: 1,
  spec: '03 §5.8',
  source: `${SRC}/execution.ts`,
  schema: ExecutionStep,
};

const verificationType: RecordType = {
  type: 'verification',
  major: 1,
  spec: '03 §5.9',
  source: `${SRC}/evidence.ts`,
  schema: VerificationRecord,
};

const AUDIT: readonly ColumnSpec[] = [
  { column: 'created_at', field: 'createdAt', kind: 'text' },
  { column: 'created_by', field: 'createdBy', kind: 'json' },
  { column: 'updated_at', field: 'updatedAt', kind: 'text' },
  { column: 'updated_by', field: 'updatedBy', kind: 'json' },
  { column: 'version', field: 'version', kind: 'integer' },
];

/** The storage envelope of a table whose record type is not written yet. */
function unspecified(table: TableName, followUp: string): TableSpec {
  return {
    table,
    primaryKey: ['id'],
    columns: [
      { column: 'id', field: 'id', kind: 'text' },
      { column: 'doc', field: 'doc', kind: 'json' },
      ...AUDIT,
    ],
    followUp,
    managedFields: [],
  };
}

export const tableSpecs: readonly TableSpec[] = [
  {
    table: 'workspace',
    primaryKey: ['id'],
    schema: record('workspace'),
    managedFields: [],
    columns: [
      { column: 'id', field: 'id', kind: 'text' },
      { column: 'display_name', field: 'displayName', kind: 'text' },
      { column: 'time_zone', field: 'timeZone', kind: 'text' },
      { column: 'self_person_id', field: 'selfPersonId', kind: 'text' },
      { column: 'counters', field: 'counters', kind: 'json' },
      ...AUDIT,
    ],
  },
  {
    table: 'persons',
    primaryKey: ['id'],
    schema: record('person'),
    managedFields: [],
    fts: { title: 'displayName' },
    columns: [
      { column: 'id', field: 'id', kind: 'text' },
      { column: 'display_name', field: 'displayName', kind: 'text' },
      { column: 'role', field: 'role', kind: 'text' },
      { column: 'time_zone', field: 'timeZone', kind: 'text', optional: true },
      { column: 'emails', field: 'emails', kind: 'json' },
      { column: 'consents', field: 'consents', kind: 'json' },
      ...AUDIT,
    ],
  },
  {
    table: 'workstreams',
    primaryKey: ['id'],
    schema: record('workstream'),
    managedFields: [],
    fts: { title: 'name' },
    columns: [
      { column: 'id', field: 'id', kind: 'text' },
      { column: 'slug', field: 'slug', kind: 'text' },
      { column: 'name', field: 'name', kind: 'text' },
      { column: 'kind', field: 'kind', kind: 'text' },
      { column: 'parent_id', field: 'parentId', kind: 'text', optional: true },
      { column: 'principal_id', field: 'principalId', kind: 'text' },
      { column: 'steward_id', field: 'stewardId', kind: 'text' },
      { column: 'time_zone', field: 'timeZone', kind: 'text' },
      { column: 'status', field: 'status', kind: 'text' },
      {
        column: 'framework_instance_id',
        field: 'frameworkInstanceId',
        kind: 'text',
        optional: true,
      },
      { column: 'privacy', field: 'privacy', kind: 'text' },
      { column: 'ai_data_policy', field: 'aiDataPolicy', kind: 'text' },
      { column: 'repo_paths', field: 'repoPaths', kind: 'json' },
      { column: 'grounding_refs', field: 'groundingRefs', kind: 'json' },
      ...AUDIT,
    ],
  },
  {
    table: 'framework_instances',
    primaryKey: ['id'],
    schema: record('framework_instance'),
    managedFields: [],
    columns: [
      { column: 'id', field: 'id', kind: 'text' },
      { column: 'workstream_id', field: 'workstreamId', kind: 'text' },
      { column: 'template_id', field: 'templateId', kind: 'text' },
      { column: 'template_version', field: 'templateVersion', kind: 'text' },
      { column: 'mode', field: 'mode', kind: 'text' },
      { column: 'goal_model', field: 'goalModel', kind: 'text' },
      { column: 'validated_at', field: 'validatedAt', kind: 'text' },
      { column: 'pack_ids', field: 'packIds', kind: 'json' },
      { column: 'parameters', field: 'parameters', kind: 'json' },
      { column: 'vocabulary_overrides', field: 'vocabularyOverrides', kind: 'json' },
      { column: 'series_ids', field: 'seriesIds', kind: 'json' },
      { column: 'forked_from', field: 'forkedFrom', kind: 'json', optional: true },
      ...AUDIT,
    ],
  },
  {
    table: 'goals',
    primaryKey: ['id'],
    schema: record('goal'),
    managedFields: [],
    fts: { ref: 'ref', title: 'title', doneMeans: 'doneMeans', notes: ['healthNote'] },
    columns: [
      { column: 'id', field: 'id', kind: 'text' },
      { column: 'ref', field: 'ref', kind: 'text' },
      { column: 'workstream_id', field: 'workstreamId', kind: 'text' },
      { column: 'framework_instance_id', field: 'frameworkInstanceId', kind: 'text' },
      { column: 'kind', field: 'kind', kind: 'text' },
      { column: 'title', field: 'title', kind: 'text' },
      { column: 'owner_id', field: 'ownerId', kind: 'text' },
      { column: 'parent_id', field: 'parentId', kind: 'text', optional: true },
      { column: 'done_means', field: 'doneMeans', kind: 'text', optional: true },
      { column: 'commitment', field: 'commitment', kind: 'text' },
      { column: 'status', field: 'status', kind: 'text' },
      { column: 'health', field: 'health', kind: 'text' },
      { column: 'health_note', field: 'healthNote', kind: 'text', optional: true },
      { column: 'grade', field: 'grade', kind: 'real', optional: true },
      { column: 'period', field: 'period', kind: 'json' },
      { column: 'measure_ids', field: 'measureIds', kind: 'json' },
      { column: 'target', field: 'target', kind: 'json', optional: true },
      ...AUDIT,
    ],
  },
  {
    table: 'measures',
    primaryKey: ['id'],
    schema: record('measure'),
    managedFields: [],
    fts: { ref: 'ref', title: 'name' },
    columns: [
      { column: 'id', field: 'id', kind: 'text' },
      { column: 'ref', field: 'ref', kind: 'text' },
      { column: 'name', field: 'name', kind: 'text' },
      { column: 'owner_id', field: 'ownerId', kind: 'text' },
      { column: 'unit', field: 'unit', kind: 'text' },
      { column: 'currency', field: 'currency', kind: 'text', optional: true },
      { column: 'role', field: 'role', kind: 'text' },
      { column: 'cadence', field: 'cadence', kind: 'text' },
      { column: 'aggregation', field: 'aggregation', kind: 'text' },
      { column: 'scorecard_order', field: 'scorecardOrder', kind: 'integer' },
      { column: 'active', field: 'active', kind: 'boolean' },
      { column: 'workstream_ids', field: 'workstreamIds', kind: 'json' },
      { column: 'target', field: 'target', kind: 'json' },
      { column: 'source', field: 'source', kind: 'json' },
      ...AUDIT,
    ],
  },
  {
    table: 'measure_values',
    primaryKey: ['id'],
    schema: record('measure_value'),
    managedFields: ['version'],
    columns: [
      { column: 'id', field: 'id', kind: 'text' },
      { column: 'measure_id', field: 'measureId', kind: 'text' },
      { column: 'period_start', field: 'periodStart', kind: 'text' },
      { column: 'value', field: 'value', kind: 'json' },
      { column: 'source', field: 'source', kind: 'text' },
      { column: 'recorded_at', field: 'recordedAt', kind: 'text' },
      { column: 'recorded_by', field: 'recordedBy', kind: 'json' },
      { column: 'normal', field: 'normal', kind: 'boolean', nullable: true },
      { column: 'note', field: 'note', kind: 'text', optional: true },
      { column: 'version', field: 'version', kind: 'integer' },
    ],
  },
  {
    table: 'decisions',
    primaryKey: ['id'],
    schema: record('decision'),
    managedFields: [],
    blobFields: ['memoSha256'],
    fts: {
      ref: 'ref',
      title: 'question',
      notes: ['outcome.text', 'outcome.why', 'dropReason'],
    },
    columns: [
      { column: 'id', field: 'id', kind: 'text' },
      { column: 'ref', field: 'ref', kind: 'text' },
      { column: 'workstream_id', field: 'workstreamId', kind: 'text' },
      { column: 'question', field: 'question', kind: 'text' },
      { column: 'decider_id', field: 'deciderId', kind: 'text' },
      { column: 'driver_id', field: 'driverId', kind: 'text', optional: true },
      { column: 'reversibility', field: 'reversibility', kind: 'text' },
      { column: 'due_by', field: 'dueBy', kind: 'text', optional: true },
      { column: 'status', field: 'status', kind: 'text' },
      { column: 'drop_reason', field: 'dropReason', kind: 'text', optional: true },
      { column: 'memo_sha256', field: 'memoSha256', kind: 'text', optional: true },
      { column: 'supersedes_id', field: 'supersedesId', kind: 'text', optional: true },
      { column: 'input_from_ids', field: 'inputFromIds', kind: 'json' },
      { column: 'inform_ids', field: 'informIds', kind: 'json' },
      { column: 'options', field: 'options', kind: 'json' },
      { column: 'recommendation', field: 'recommendation', kind: 'json', optional: true },
      { column: 'outcome', field: 'outcome', kind: 'json', optional: true },
      { column: 'action_item_ids', field: 'actionItemIds', kind: 'json' },
      { column: 'review_on', field: 'reviewOn', kind: 'json', optional: true },
      { column: 'source', field: 'source', kind: 'json' },
      ...AUDIT,
    ],
  },
  {
    table: 'issues',
    primaryKey: ['id'],
    schema: record('issue'),
    managedFields: [],
    fts: { ref: 'ref', title: 'title', notes: ['resolution.note'] },
    columns: [
      { column: 'id', field: 'id', kind: 'text' },
      { column: 'ref', field: 'ref', kind: 'text' },
      { column: 'workstream_id', field: 'workstreamId', kind: 'text' },
      { column: 'title', field: 'title', kind: 'text' },
      { column: 'rank', field: 'rank', kind: 'integer', optional: true },
      { column: 'status', field: 'status', kind: 'text' },
      { column: 'raised_from', field: 'raisedFrom', kind: 'json' },
      { column: 'resolution', field: 'resolution', kind: 'json', optional: true },
      ...AUDIT,
    ],
  },
  {
    table: 'risks',
    primaryKey: ['id'],
    schema: record('risk'),
    managedFields: [],
    fts: { ref: 'ref', title: 'description', notes: ['trigger'] },
    columns: [
      { column: 'id', field: 'id', kind: 'text' },
      { column: 'ref', field: 'ref', kind: 'text' },
      { column: 'workstream_id', field: 'workstreamId', kind: 'text' },
      { column: 'description', field: 'description', kind: 'text' },
      { column: 'watcher_id', field: 'watcherId', kind: 'text' },
      { column: 'trigger_text', field: 'trigger', kind: 'text' },
      { column: 'status', field: 'status', kind: 'text' },
      { column: 'review_cadence', field: 'reviewCadence', kind: 'text' },
      ...AUDIT,
    ],
  },
  {
    table: 'action_items',
    primaryKey: ['id'],
    schema: record('action_item'),
    managedFields: [],
    fts: {
      ref: 'ref',
      title: 'title',
      doneMeans: 'doneMeans',
      notes: ['healthNote', 'dropReason', 'claim.note'],
    },
    columns: [
      { column: 'id', field: 'id', kind: 'text' },
      { column: 'ref', field: 'ref', kind: 'text' },
      { column: 'workstream_id', field: 'workstreamId', kind: 'text' },
      { column: 'kind', field: 'kind', kind: 'text' },
      { column: 'title', field: 'title', kind: 'text' },
      { column: 'done_means', field: 'doneMeans', kind: 'text' },
      { column: 'verification_policy', field: 'verificationPolicy', kind: 'text' },
      { column: 'owner_id', field: 'ownerId', kind: 'text' },
      { column: 'reviewer_id', field: 'reviewerId', kind: 'text' },
      { column: 'due_date', field: 'due.date', kind: 'text' },
      { column: 'due_time', field: 'due.time', kind: 'text', optional: true },
      { column: 'due_time_zone', field: 'due.timeZone', kind: 'text' },
      { column: 'lifecycle', field: 'lifecycle', kind: 'text' },
      { column: 'health', field: 'health', kind: 'text' },
      { column: 'health_note', field: 'healthNote', kind: 'text', optional: true },
      { column: 'carry_count', field: 'carryCount', kind: 'integer' },
      { column: 'replanned_count', field: 'replannedCount', kind: 'integer' },
      { column: 'escalation_level', field: 'escalationLevel', kind: 'integer' },
      { column: 'drop_reason', field: 'dropReason', kind: 'text', optional: true },
      { column: 'closed_at', field: 'closedAt', kind: 'text', optional: true },
      { column: 'closed_by', field: 'closedBy', kind: 'json', optional: true },
      { column: 'privacy', field: 'privacy', kind: 'text' },
      { column: 'evidence_requirements', field: 'evidenceRequirements', kind: 'json' },
      { column: 'inform_ids', field: 'informIds', kind: 'json' },
      { column: 'waiting_on', field: 'waitingOn', kind: 'json', optional: true },
      { column: 'execution', field: 'execution', kind: 'json' },
      { column: 'source', field: 'source', kind: 'json' },
      { column: 'links', field: 'links', kind: 'json' },
      { column: 'claim', field: 'claim', kind: 'json', optional: true },
      { column: 'verification', field: 'verification', kind: 'json', optional: true },
      { column: 'external_refs', field: 'externalRefs', kind: 'json' },
      ...AUDIT,
    ],
  },
  {
    table: 'execution_steps',
    primaryKey: ['action_item_id', 'step_id'],
    schema: executionStepType,
    managedFields: ['actionItemId', 'version'],
    derivedFrom: 'action_items',
    columns: [
      { column: 'action_item_id', field: 'actionItemId', kind: 'text' },
      { column: 'step_id', field: 'id', kind: 'text' },
      { column: 'step_order', field: 'order', kind: 'integer' },
      { column: 'title', field: 'title', kind: 'text' },
      { column: 'status', field: 'status', kind: 'text' },
      { column: 'confirmation', field: 'confirmation', kind: 'text' },
      { column: 'performer', field: 'performer', kind: 'json' },
      { column: 'depends_on', field: 'dependsOn', kind: 'json' },
      { column: 'satisfies', field: 'satisfies', kind: 'json' },
      { column: 'run_ids', field: 'runIds', kind: 'json' },
      { column: 'output', field: 'output', kind: 'json', optional: true },
      { column: 'failure', field: 'failure', kind: 'json', optional: true },
      { column: 'version', field: 'version', kind: 'integer' },
    ],
  },
  {
    table: 'runs',
    primaryKey: ['id'],
    schema: record('run'),
    managedFields: ['version'],
    blobFields: ['logSha256'],
    columns: [
      { column: 'id', field: 'id', kind: 'text' },
      { column: 'kind', field: 'kind', kind: 'text' },
      { column: 'action_item_id', field: 'actionItemId', kind: 'text', optional: true },
      { column: 'step_id', field: 'stepId', kind: 'text', optional: true },
      { column: 'started_at', field: 'startedAt', kind: 'text' },
      { column: 'ended_at', field: 'endedAt', kind: 'text', optional: true },
      { column: 'status', field: 'status', kind: 'text' },
      { column: 'log_sha256', field: 'logSha256', kind: 'text', optional: true },
      { column: 'actor', field: 'actor', kind: 'json' },
      { column: 'usage', field: 'usage', kind: 'json', optional: true },
      { column: 'version', field: 'version', kind: 'integer' },
    ],
  },
  {
    table: 'evidence',
    primaryKey: ['id'],
    schema: record('evidence'),
    managedFields: ['version'],
    blobFields: ['blobSha256'],
    fts: { title: 'summary' },
    columns: [
      { column: 'id', field: 'id', kind: 'text' },
      { column: 'action_item_id', field: 'actionItemId', kind: 'text' },
      { column: 'requirement_id', field: 'requirementId', kind: 'text', optional: true },
      { column: 'kind', field: 'kind', kind: 'text' },
      { column: 'summary', field: 'summary', kind: 'text' },
      { column: 'url', field: 'url', kind: 'text', optional: true },
      { column: 'blob_sha256', field: 'blobSha256', kind: 'text', optional: true },
      { column: 'captured_at', field: 'capturedAt', kind: 'text' },
      { column: 'captured_by', field: 'capturedBy', kind: 'json' },
      { column: 'record', field: 'record', kind: 'json', optional: true },
      { column: 'external_task', field: 'externalTask', kind: 'json', optional: true },
      { column: 'version', field: 'version', kind: 'integer' },
    ],
  },
  {
    table: 'verifications',
    primaryKey: ['action_item_id'],
    schema: verificationType,
    managedFields: ['actionItemId', 'version'],
    derivedFrom: 'action_items',
    columns: [
      { column: 'action_item_id', field: 'actionItemId', kind: 'text' },
      { column: 'method', field: 'method', kind: 'text', optional: true },
      { column: 'decided_at', field: 'decidedAt', kind: 'text', optional: true },
      { column: 'attestation_note', field: 'attestationNote', kind: 'text', optional: true },
      { column: 'checks', field: 'checks', kind: 'json' },
      { column: 'ai_review', field: 'aiReview', kind: 'json', optional: true },
      { column: 'decided_by', field: 'decidedBy', kind: 'json', optional: true },
      { column: 'rejected_claims', field: 'rejectedClaims', kind: 'json' },
      { column: 'version', field: 'version', kind: 'integer' },
    ],
  },
  {
    table: 'meeting_series',
    primaryKey: ['id'],
    schema: record('meeting_series'),
    managedFields: [],
    columns: [
      { column: 'id', field: 'id', kind: 'text' },
      { column: 'name', field: 'name', kind: 'text' },
      { column: 'cadence', field: 'cadence', kind: 'text' },
      { column: 'rrule', field: 'rrule', kind: 'text' },
      { column: 'dtstart', field: 'dtstart', kind: 'text' },
      { column: 'time_zone', field: 'timeZone', kind: 'text' },
      { column: 'duration_minutes', field: 'durationMinutes', kind: 'integer' },
      { column: 'workstream_ids', field: 'workstreamIds', kind: 'json' },
      { column: 'framework_instance_ids', field: 'frameworkInstanceIds', kind: 'json' },
      { column: 'backbone_meeting_key', field: 'backboneMeetingKey', kind: 'text' },
      { column: 'agenda_template_id', field: 'agendaTemplateId', kind: 'text' },
      { column: 'agenda_overrides', field: 'agendaOverrides', kind: 'json' },
      { column: 'attendee_ids', field: 'attendeeIds', kind: 'json' },
      { column: 'chair_id', field: 'chairId', kind: 'text' },
      { column: 'mode', field: 'mode', kind: 'text' },
      { column: 'absorbs', field: 'absorbs', kind: 'json' },
      { column: 'calendars', field: 'calendars', kind: 'json' },
      { column: 'preread_lead_minutes', field: 'prereadLeadMinutes', kind: 'integer' },
      { column: 'reminder_minutes', field: 'reminderMinutes', kind: 'json' },
      { column: 'grace_minutes', field: 'graceMinutes', kind: 'integer' },
      { column: 'status', field: 'status', kind: 'text' },
      ...AUDIT,
    ],
  },
  {
    table: 'meeting_instances',
    primaryKey: ['id'],
    schema: record('meeting_instance'),
    managedFields: [],
    // The pre-read snapshot and its Markdown view (02 §6.2 rule 1).
    blobFields: ['preread.snapshotSha256', 'preread.renderedSha256'],
    columns: [
      { column: 'id', field: 'id', kind: 'text' },
      { column: 'ref', field: 'ref', kind: 'text' },
      { column: 'series_id', field: 'seriesId', kind: 'text' },
      { column: 'occurrence_start', field: 'occurrenceStart', kind: 'text' },
      { column: 'scheduled_start', field: 'scheduledStart', kind: 'text' },
      { column: 'scheduled_end', field: 'scheduledEnd', kind: 'text' },
      { column: 'actual_start', field: 'actualStart', kind: 'text', optional: true },
      { column: 'actual_end', field: 'actualEnd', kind: 'text', optional: true },
      { column: 'state', field: 'state', kind: 'text' },
      { column: 'agenda', field: 'agenda', kind: 'json' },
      { column: 'preread', field: 'preread', kind: 'json', optional: true },
      { column: 'outputs', field: 'outputs', kind: 'json' },
      { column: 'calendar_events', field: 'calendarEvents', kind: 'json' },
      { column: 'carried_from', field: 'carriedFrom', kind: 'json' },
      { column: 'absorbed_instance_ids', field: 'absorbedInstanceIds', kind: 'json' },
      { column: 'absorbed_by', field: 'absorbedBy', kind: 'text', optional: true },
      { column: 'skip_reason', field: 'skipReason', kind: 'text', optional: true },
      { column: 'rescheduled_from', field: 'rescheduledFrom', kind: 'json', optional: true },
      {
        column: 'read_back_confirmed_at',
        field: 'readBackConfirmedAt',
        kind: 'text',
        optional: true,
      },
      { column: 'rating', field: 'rating', kind: 'integer', optional: true },
      { column: 'notes', field: 'notes', kind: 'text' },
      ...AUDIT,
    ],
  },
  unspecified('connector_installs', 'P2 connector host (05 §15)'),
  unspecified('connector_bindings', 'P2 connector host (05 §3)'),
  unspecified('browser_sessions', 'P2 browser host (04 §5.6)'),
  unspecified('confirmations', 'P1-04 core service and local API (04 §4.3, §11)'),
  unspecified('standing_approvals', 'P2 policy engine (04 §7.4)'),
  {
    table: 'agent_principals',
    primaryKey: ['id'],
    schema: record('agent_principal'),
    managedFields: [],
    columns: [
      { column: 'id', field: 'id', kind: 'text' },
      { column: 'name', field: 'name', kind: 'text' },
      { column: 'kind', field: 'kind', kind: 'text' },
      { column: 'sensitive_access', field: 'sensitiveAccess', kind: 'boolean' },
      { column: 'token_path', field: 'tokenPath', kind: 'text' },
      { column: 'last_used_at', field: 'lastUsedAt', kind: 'text', optional: true },
      { column: 'revoked_at', field: 'revokedAt', kind: 'text', optional: true },
      { column: 'scopes', field: 'scopes', kind: 'json' },
      { column: 'workstream_filter', field: 'workstreamFilter', kind: 'json' },
      ...AUDIT,
    ],
  },
  unspecified('development_requests', 'P6 connector discovery (06 §10.4)'),
  unspecified('backup_runs', 'P1-17 backups (04 §9.1)'),
  {
    table: 'events',
    primaryKey: ['id'],
    schema: record('domain_event'),
    managedFields: ['version'],
    columns: [
      { column: 'id', field: 'id', kind: 'text' },
      { column: 'at', field: 'at', kind: 'text' },
      { column: 'type', field: 'type', kind: 'text' },
      { column: 'entity_kind', field: 'entity.kind', kind: 'text' },
      { column: 'entity_id', field: 'entity.id', kind: 'text' },
      { column: 'entity_ref', field: 'entity.ref', kind: 'text', optional: true },
      { column: 'correlation_id', field: 'correlationId', kind: 'text', optional: true },
      { column: 'actor', field: 'actor', kind: 'json' },
      { column: 'before', field: 'before', kind: 'json', optional: true },
      { column: 'after', field: 'after', kind: 'json', optional: true },
      { column: 'version', field: 'version', kind: 'integer' },
    ],
  },
];

const byName = new Map<string, TableSpec>(tableSpecs.map((spec) => [spec.table, spec]));

/** Every table name of 03 §12 point 2, in the order that section lists them. */
export const tableNames: readonly TableName[] = tableSpecs.map((spec) => spec.table);

export function tableSpec(table: TableName): TableSpec {
  const spec = byName.get(table);
  if (spec === undefined) throw new Error(`no such table: ${table}`);
  return spec;
}

export function isTableName(value: string): value is TableName {
  return byName.has(value);
}

/** The tables whose rows no schema validates yet, with the build step that adds it. */
export function unvalidatedTables(): readonly { table: TableName; followUp: string }[] {
  return tableSpecs
    .filter((spec) => spec.schema === undefined)
    .map((spec) => ({ table: spec.table, followUp: spec.followUp ?? 'not yet planned' }));
}
