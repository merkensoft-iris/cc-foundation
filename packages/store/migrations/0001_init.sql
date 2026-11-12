-- 0001_init: the workspace store, the tables of
-- docs/design/03-decisions-and-action-items.md §12 point 2 plus schema_version (§12 point 5).
--
-- Conventions (§12 point 3):
--   * Scalar record fields are columns; nested structures are JSON columns, validated on the
--     way in by the record's zod schema in @cc/schemas (packages/store/src/tables.ts names
--     which schema validates which table).
--   * Every table has `version` for optimistic concurrency. For record types whose schema
--     carries `version` (the audit fields of 03 §3) the column mirrors the field; for the
--     rest the repository layer owns it. `events` is append-only, so its version is always 1.
--   * execution_steps and verifications are projections of the ActionItem record's
--     `execution.steps` and `verification`, written in the same transaction as the item.
--   * Tables whose record type is not written yet (meetings, connectors, browser sessions,
--     confirmations, standing approvals, development requests, backup runs) exist here with
--     the storage envelope only: `doc` holds the record and is checked for well-formed JSON,
--     but nothing validates its shape until the build step that specifies the record adds a
--     migration with its columns. No shape is guessed here.
--   * The only foreign keys are the two projections the repository layer maintains itself
--     (execution_steps and verifications -> action_items). Links between records are IDs in
--     columns with an index, not SQL constraints: the record model's referential rules are
--     invariants the domain owns (03 §6), and a store-level constraint would also decide,
--     in a file that can never be edited, questions later build steps still own.
--
-- Forward-only: this file never changes once merged (08 §6, AC-08-08).

CREATE TABLE schema_version (
  number     INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE workspace (
  id             TEXT PRIMARY KEY,
  display_name   TEXT NOT NULL,
  time_zone      TEXT NOT NULL,
  self_person_id TEXT NOT NULL,
  counters       TEXT NOT NULL CHECK (json_valid(counters)),
  created_at     TEXT NOT NULL,
  created_by     TEXT NOT NULL CHECK (json_valid(created_by)),
  updated_at     TEXT NOT NULL,
  updated_by     TEXT NOT NULL CHECK (json_valid(updated_by)),
  version        INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

CREATE TABLE persons (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role         TEXT NOT NULL,
  time_zone    TEXT,
  emails       TEXT NOT NULL CHECK (json_valid(emails)),
  consents     TEXT NOT NULL CHECK (json_valid(consents)),
  created_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL CHECK (json_valid(created_by)),
  updated_at   TEXT NOT NULL,
  updated_by   TEXT NOT NULL CHECK (json_valid(updated_by)),
  version      INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

CREATE TABLE workstreams (
  id                    TEXT PRIMARY KEY,
  slug                  TEXT NOT NULL UNIQUE,
  name                  TEXT NOT NULL,
  kind                  TEXT NOT NULL,
  parent_id             TEXT,
  principal_id          TEXT NOT NULL,
  steward_id            TEXT NOT NULL,
  time_zone             TEXT NOT NULL,
  status                TEXT NOT NULL,
  framework_instance_id TEXT,
  privacy               TEXT NOT NULL,
  ai_data_policy        TEXT NOT NULL,
  repo_paths            TEXT NOT NULL CHECK (json_valid(repo_paths)),
  grounding_refs        TEXT NOT NULL CHECK (json_valid(grounding_refs)),
  created_at            TEXT NOT NULL,
  created_by            TEXT NOT NULL CHECK (json_valid(created_by)),
  updated_at            TEXT NOT NULL,
  updated_by            TEXT NOT NULL CHECK (json_valid(updated_by)),
  version               INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

CREATE INDEX workstreams_parent ON workstreams (parent_id);

CREATE TABLE framework_instances (
  id                   TEXT PRIMARY KEY,
  workstream_id        TEXT NOT NULL,
  template_id          TEXT NOT NULL,
  template_version     TEXT NOT NULL,
  mode                 TEXT NOT NULL,
  goal_model           TEXT NOT NULL,
  validated_at         TEXT NOT NULL,
  pack_ids             TEXT NOT NULL CHECK (json_valid(pack_ids)),
  parameters           TEXT NOT NULL CHECK (json_valid(parameters)),
  vocabulary_overrides TEXT NOT NULL CHECK (json_valid(vocabulary_overrides)),
  series_ids           TEXT NOT NULL CHECK (json_valid(series_ids)),
  forked_from          TEXT CHECK (forked_from IS NULL OR json_valid(forked_from)),
  created_at           TEXT NOT NULL,
  created_by           TEXT NOT NULL CHECK (json_valid(created_by)),
  updated_at           TEXT NOT NULL,
  updated_by           TEXT NOT NULL CHECK (json_valid(updated_by)),
  version              INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

CREATE INDEX framework_instances_workstream ON framework_instances (workstream_id);

CREATE TABLE goals (
  id                    TEXT PRIMARY KEY,
  ref                   TEXT NOT NULL UNIQUE,
  workstream_id         TEXT NOT NULL,
  framework_instance_id TEXT NOT NULL,
  kind                  TEXT NOT NULL,
  title                 TEXT NOT NULL,
  owner_id              TEXT NOT NULL,
  parent_id             TEXT,
  done_means            TEXT,
  commitment            TEXT NOT NULL,
  status                TEXT NOT NULL,
  health                TEXT NOT NULL,
  health_note           TEXT,
  grade                 REAL,
  period                TEXT NOT NULL CHECK (json_valid(period)),
  measure_ids           TEXT NOT NULL CHECK (json_valid(measure_ids)),
  target                TEXT CHECK (target IS NULL OR json_valid(target)),
  created_at            TEXT NOT NULL,
  created_by            TEXT NOT NULL CHECK (json_valid(created_by)),
  updated_at            TEXT NOT NULL,
  updated_by            TEXT NOT NULL CHECK (json_valid(updated_by)),
  version               INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

CREATE INDEX goals_workstream ON goals (workstream_id, status);
CREATE INDEX goals_parent ON goals (parent_id);

CREATE TABLE measures (
  id              TEXT PRIMARY KEY,
  ref             TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  owner_id        TEXT NOT NULL,
  unit            TEXT NOT NULL,
  currency        TEXT,
  role            TEXT NOT NULL,
  cadence         TEXT NOT NULL,
  aggregation     TEXT NOT NULL,
  scorecard_order INTEGER NOT NULL,
  active          INTEGER NOT NULL CHECK (active IN (0, 1)),
  workstream_ids  TEXT NOT NULL CHECK (json_valid(workstream_ids)),
  target          TEXT NOT NULL CHECK (json_valid(target)),
  source          TEXT NOT NULL CHECK (json_valid(source)),
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL CHECK (json_valid(created_by)),
  updated_at      TEXT NOT NULL,
  updated_by      TEXT NOT NULL CHECK (json_valid(updated_by)),
  version         INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

CREATE TABLE measure_values (
  id           TEXT PRIMARY KEY,
  measure_id   TEXT NOT NULL,
  period_start TEXT NOT NULL,
  value        TEXT NOT NULL CHECK (json_valid(value)),
  source       TEXT NOT NULL,
  recorded_at  TEXT NOT NULL,
  recorded_by  TEXT NOT NULL CHECK (json_valid(recorded_by)),
  normal       INTEGER CHECK (normal IS NULL OR normal IN (0, 1)),
  note         TEXT,
  version      INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

CREATE UNIQUE INDEX measure_values_period ON measure_values (measure_id, period_start);

CREATE TABLE decisions (
  id               TEXT PRIMARY KEY,
  ref              TEXT NOT NULL UNIQUE,
  workstream_id    TEXT NOT NULL,
  question         TEXT NOT NULL,
  decider_id       TEXT NOT NULL,
  driver_id        TEXT,
  reversibility    TEXT NOT NULL,
  due_by           TEXT,
  status           TEXT NOT NULL,
  drop_reason      TEXT,
  memo_sha256      TEXT,
  supersedes_id    TEXT,
  input_from_ids   TEXT NOT NULL CHECK (json_valid(input_from_ids)),
  inform_ids       TEXT NOT NULL CHECK (json_valid(inform_ids)),
  options          TEXT NOT NULL CHECK (json_valid(options)),
  recommendation   TEXT CHECK (recommendation IS NULL OR json_valid(recommendation)),
  outcome          TEXT CHECK (outcome IS NULL OR json_valid(outcome)),
  action_item_ids  TEXT NOT NULL CHECK (json_valid(action_item_ids)),
  review_on        TEXT CHECK (review_on IS NULL OR json_valid(review_on)),
  source           TEXT NOT NULL CHECK (json_valid(source)),
  created_at       TEXT NOT NULL,
  created_by       TEXT NOT NULL CHECK (json_valid(created_by)),
  updated_at       TEXT NOT NULL,
  updated_by       TEXT NOT NULL CHECK (json_valid(updated_by)),
  version          INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

CREATE INDEX decisions_workstream ON decisions (workstream_id, status);

CREATE TABLE issues (
  id            TEXT PRIMARY KEY,
  ref           TEXT NOT NULL UNIQUE,
  workstream_id TEXT NOT NULL,
  title         TEXT NOT NULL,
  rank          INTEGER,
  status        TEXT NOT NULL,
  raised_from   TEXT NOT NULL CHECK (json_valid(raised_from)),
  resolution    TEXT CHECK (resolution IS NULL OR json_valid(resolution)),
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL CHECK (json_valid(created_by)),
  updated_at    TEXT NOT NULL,
  updated_by    TEXT NOT NULL CHECK (json_valid(updated_by)),
  version       INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

CREATE INDEX issues_workstream ON issues (workstream_id, status);

CREATE TABLE risks (
  id              TEXT PRIMARY KEY,
  ref             TEXT NOT NULL UNIQUE,
  workstream_id   TEXT NOT NULL,
  description     TEXT NOT NULL,
  watcher_id      TEXT NOT NULL,
  trigger_text    TEXT NOT NULL,
  status          TEXT NOT NULL,
  review_cadence  TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL CHECK (json_valid(created_by)),
  updated_at      TEXT NOT NULL,
  updated_by      TEXT NOT NULL CHECK (json_valid(updated_by)),
  version         INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

CREATE INDEX risks_workstream ON risks (workstream_id, status);

CREATE TABLE action_items (
  id                    TEXT PRIMARY KEY,
  ref                   TEXT NOT NULL UNIQUE,
  workstream_id         TEXT NOT NULL,
  kind                  TEXT NOT NULL,
  title                 TEXT NOT NULL,
  done_means            TEXT NOT NULL,
  verification_policy   TEXT NOT NULL,
  owner_id              TEXT NOT NULL,
  reviewer_id           TEXT NOT NULL,
  due_date              TEXT NOT NULL,
  due_time              TEXT,
  due_time_zone         TEXT NOT NULL,
  lifecycle             TEXT NOT NULL,
  health                TEXT NOT NULL,
  health_note           TEXT,
  carry_count           INTEGER NOT NULL CHECK (carry_count >= 0),
  replanned_count       INTEGER NOT NULL CHECK (replanned_count >= 0),
  escalation_level      INTEGER NOT NULL CHECK (escalation_level BETWEEN 0 AND 4),
  drop_reason           TEXT,
  closed_at             TEXT,
  closed_by             TEXT CHECK (closed_by IS NULL OR json_valid(closed_by)),
  privacy               TEXT NOT NULL,
  evidence_requirements TEXT NOT NULL CHECK (json_valid(evidence_requirements)),
  inform_ids            TEXT NOT NULL CHECK (json_valid(inform_ids)),
  waiting_on            TEXT CHECK (waiting_on IS NULL OR json_valid(waiting_on)),
  execution             TEXT NOT NULL CHECK (json_valid(execution)),
  source                TEXT NOT NULL CHECK (json_valid(source)),
  links                 TEXT NOT NULL CHECK (json_valid(links)),
  claim                 TEXT CHECK (claim IS NULL OR json_valid(claim)),
  verification          TEXT CHECK (verification IS NULL OR json_valid(verification)),
  external_refs         TEXT NOT NULL CHECK (json_valid(external_refs)),
  created_at            TEXT NOT NULL,
  created_by            TEXT NOT NULL CHECK (json_valid(created_by)),
  updated_at            TEXT NOT NULL,
  updated_by            TEXT NOT NULL CHECK (json_valid(updated_by)),
  version               INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

CREATE INDEX action_items_workstream ON action_items (workstream_id, lifecycle);
CREATE INDEX action_items_owner ON action_items (owner_id, lifecycle);
CREATE INDEX action_items_due ON action_items (due_date, lifecycle);

-- Projection of ActionItem.execution.steps (03 §5.8), rewritten with its action item.
CREATE TABLE execution_steps (
  action_item_id TEXT NOT NULL REFERENCES action_items (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  step_id        TEXT NOT NULL,
  step_order     INTEGER NOT NULL CHECK (step_order >= 1),
  title          TEXT NOT NULL,
  status         TEXT NOT NULL,
  confirmation   TEXT NOT NULL,
  performer      TEXT NOT NULL CHECK (json_valid(performer)),
  depends_on     TEXT NOT NULL CHECK (json_valid(depends_on)),
  satisfies      TEXT NOT NULL CHECK (json_valid(satisfies)),
  run_ids        TEXT NOT NULL CHECK (json_valid(run_ids)),
  output         TEXT CHECK (output IS NULL OR json_valid(output)),
  failure        TEXT CHECK (failure IS NULL OR json_valid(failure)),
  version        INTEGER NOT NULL CHECK (version >= 1),
  PRIMARY KEY (action_item_id, step_id)
) STRICT;

CREATE INDEX execution_steps_order ON execution_steps (action_item_id, step_order);
CREATE INDEX execution_steps_status ON execution_steps (status);

CREATE TABLE runs (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  action_item_id TEXT,
  step_id        TEXT,
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  status         TEXT NOT NULL,
  log_sha256     TEXT,
  actor          TEXT NOT NULL CHECK (json_valid(actor)),
  usage          TEXT CHECK (usage IS NULL OR json_valid(usage)),
  version        INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

CREATE INDEX runs_action_item ON runs (action_item_id, started_at);
CREATE INDEX runs_started ON runs (started_at);

CREATE TABLE evidence (
  id             TEXT PRIMARY KEY,
  action_item_id TEXT NOT NULL,
  requirement_id TEXT,
  kind           TEXT NOT NULL,
  summary        TEXT NOT NULL,
  url            TEXT,
  blob_sha256    TEXT,
  captured_at    TEXT NOT NULL,
  captured_by    TEXT NOT NULL CHECK (json_valid(captured_by)),
  record         TEXT CHECK (record IS NULL OR json_valid(record)),
  external_task  TEXT CHECK (external_task IS NULL OR json_valid(external_task)),
  version        INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

CREATE INDEX evidence_action_item ON evidence (action_item_id);

-- Projection of ActionItem.verification (03 §5.9), rewritten with its action item.
CREATE TABLE verifications (
  action_item_id   TEXT PRIMARY KEY REFERENCES action_items (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  method           TEXT,
  decided_at       TEXT,
  attestation_note TEXT,
  checks           TEXT NOT NULL CHECK (json_valid(checks)),
  ai_review        TEXT CHECK (ai_review IS NULL OR json_valid(ai_review)),
  decided_by       TEXT CHECK (decided_by IS NULL OR json_valid(decided_by)),
  rejected_claims  TEXT NOT NULL CHECK (json_valid(rejected_claims)),
  version          INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

CREATE TABLE agent_principals (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  kind              TEXT NOT NULL,
  sensitive_access  INTEGER NOT NULL CHECK (sensitive_access IN (0, 1)),
  token_path        TEXT NOT NULL,
  last_used_at      TEXT,
  revoked_at        TEXT,
  scopes            TEXT NOT NULL CHECK (json_valid(scopes)),
  workstream_filter TEXT NOT NULL CHECK (json_valid(workstream_filter)),
  created_at        TEXT NOT NULL,
  created_by        TEXT NOT NULL CHECK (json_valid(created_by)),
  updated_at        TEXT NOT NULL,
  updated_by        TEXT NOT NULL CHECK (json_valid(updated_by)),
  version           INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

-- Tables whose record type is not written yet (see the header). `doc` holds the whole record;
-- the build step that specifies the record replaces this envelope with its own columns.
CREATE TABLE meeting_series (
  id         TEXT PRIMARY KEY,
  doc        TEXT NOT NULL CHECK (json_valid(doc)),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (json_valid(created_by)),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL CHECK (json_valid(updated_by)),
  version    INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

CREATE TABLE meeting_instances (
  id         TEXT PRIMARY KEY,
  doc        TEXT NOT NULL CHECK (json_valid(doc)),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (json_valid(created_by)),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL CHECK (json_valid(updated_by)),
  version    INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

CREATE TABLE connector_installs (
  id         TEXT PRIMARY KEY,
  doc        TEXT NOT NULL CHECK (json_valid(doc)),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (json_valid(created_by)),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL CHECK (json_valid(updated_by)),
  version    INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

CREATE TABLE connector_bindings (
  id         TEXT PRIMARY KEY,
  doc        TEXT NOT NULL CHECK (json_valid(doc)),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (json_valid(created_by)),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL CHECK (json_valid(updated_by)),
  version    INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

CREATE TABLE browser_sessions (
  id         TEXT PRIMARY KEY,
  doc        TEXT NOT NULL CHECK (json_valid(doc)),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (json_valid(created_by)),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL CHECK (json_valid(updated_by)),
  version    INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

CREATE TABLE confirmations (
  id         TEXT PRIMARY KEY,
  doc        TEXT NOT NULL CHECK (json_valid(doc)),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (json_valid(created_by)),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL CHECK (json_valid(updated_by)),
  version    INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

CREATE TABLE standing_approvals (
  id         TEXT PRIMARY KEY,
  doc        TEXT NOT NULL CHECK (json_valid(doc)),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (json_valid(created_by)),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL CHECK (json_valid(updated_by)),
  version    INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

CREATE TABLE development_requests (
  id         TEXT PRIMARY KEY,
  doc        TEXT NOT NULL CHECK (json_valid(doc)),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (json_valid(created_by)),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL CHECK (json_valid(updated_by)),
  version    INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

CREATE TABLE backup_runs (
  id         TEXT PRIMARY KEY,
  doc        TEXT NOT NULL CHECK (json_valid(doc)),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (json_valid(created_by)),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL CHECK (json_valid(updated_by)),
  version    INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

-- The event log (03 §5.10, §12 point 4): append-only, written in the same transaction as the
-- projection rows it describes. `id` is a ULID, so event order is ID order.
CREATE TABLE events (
  id             TEXT PRIMARY KEY,
  at             TEXT NOT NULL,
  type           TEXT NOT NULL,
  entity_kind    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  entity_ref     TEXT,
  correlation_id TEXT,
  actor          TEXT NOT NULL CHECK (json_valid(actor)),
  before         TEXT CHECK (before IS NULL OR json_valid(before)),
  after          TEXT CHECK (after IS NULL OR json_valid(after)),
  version        INTEGER NOT NULL CHECK (version = 1)
) STRICT;

CREATE INDEX events_entity ON events (entity_kind, entity_id, id);
CREATE INDEX events_at ON events (at);
CREATE INDEX events_type ON events (type);

-- FTS5 over titles, done-means and notes (§12 point 2), kept in sync inside the same
-- transaction as the rows it indexes.
CREATE VIRTUAL TABLE fts_items USING fts5 (
  table_name UNINDEXED,
  item_id UNINDEXED,
  ref UNINDEXED,
  title,
  done_means,
  notes,
  tokenize = 'unicode61 remove_diacritics 2'
);
