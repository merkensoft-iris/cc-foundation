-- Snapshot of the schema after 0002, written by
-- pnpm cc:new-migration. It is the starting point of the fixture-upgrade test of
-- migration 0003 (03 §12 point 5). Generated; never edited by hand.

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
CREATE TABLE backup_runs (
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
CREATE TABLE connector_bindings (
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
CREATE TABLE development_requests (
  id         TEXT PRIMARY KEY,
  doc        TEXT NOT NULL CHECK (json_valid(doc)),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (json_valid(created_by)),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL CHECK (json_valid(updated_by)),
  version    INTEGER NOT NULL CHECK (version >= 1)
) STRICT;
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
CREATE VIRTUAL TABLE fts_items USING fts5 (
  table_name UNINDEXED,
  item_id UNINDEXED,
  ref UNINDEXED,
  title,
  done_means,
  notes,
  tokenize = 'unicode61 remove_diacritics 2'
);
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
CREATE TABLE "meeting_instances" (
  id                     TEXT PRIMARY KEY,
  ref                    TEXT NOT NULL UNIQUE,
  series_id              TEXT NOT NULL,
  occurrence_start       TEXT NOT NULL,
  scheduled_start        TEXT NOT NULL,
  scheduled_end          TEXT NOT NULL,
  actual_start           TEXT,
  actual_end             TEXT,
  state                  TEXT NOT NULL,
  agenda                 TEXT NOT NULL CHECK (json_valid(agenda)),
  preread                TEXT CHECK (preread IS NULL OR json_valid(preread)),
  outputs                TEXT NOT NULL CHECK (json_valid(outputs)),
  calendar_events        TEXT NOT NULL CHECK (json_valid(calendar_events)),
  carried_from           TEXT NOT NULL CHECK (json_valid(carried_from)),
  absorbed_instance_ids  TEXT NOT NULL CHECK (json_valid(absorbed_instance_ids)),
  absorbed_by            TEXT,
  skip_reason            TEXT,
  rescheduled_from       TEXT CHECK (rescheduled_from IS NULL OR json_valid(rescheduled_from)),
  read_back_confirmed_at TEXT,
  rating                 INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 10),
  notes                  TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  created_by             TEXT NOT NULL CHECK (json_valid(created_by)),
  updated_at             TEXT NOT NULL,
  updated_by             TEXT NOT NULL CHECK (json_valid(updated_by)),
  version                INTEGER NOT NULL CHECK (version >= 1)
) STRICT;
CREATE TABLE "meeting_series" (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  cadence                TEXT NOT NULL,
  rrule                  TEXT NOT NULL,
  dtstart                TEXT NOT NULL,
  time_zone              TEXT NOT NULL,
  duration_minutes       INTEGER NOT NULL CHECK (duration_minutes >= 1),
  workstream_ids         TEXT NOT NULL CHECK (json_valid(workstream_ids)),
  framework_instance_ids TEXT NOT NULL CHECK (json_valid(framework_instance_ids)),
  backbone_meeting_key   TEXT NOT NULL,
  agenda_template_id     TEXT NOT NULL,
  agenda_overrides       TEXT NOT NULL CHECK (json_valid(agenda_overrides)),
  attendee_ids           TEXT NOT NULL CHECK (json_valid(attendee_ids)),
  chair_id               TEXT NOT NULL,
  mode                   TEXT NOT NULL,
  absorbs                TEXT NOT NULL CHECK (json_valid(absorbs)),
  calendars              TEXT NOT NULL CHECK (json_valid(calendars)),
  preread_lead_minutes   INTEGER NOT NULL CHECK (preread_lead_minutes >= 0),
  reminder_minutes       TEXT NOT NULL CHECK (json_valid(reminder_minutes)),
  grace_minutes          INTEGER NOT NULL CHECK (grace_minutes >= 0),
  status                 TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  created_by             TEXT NOT NULL CHECK (json_valid(created_by)),
  updated_at             TEXT NOT NULL,
  updated_by             TEXT NOT NULL CHECK (json_valid(updated_by)),
  version                INTEGER NOT NULL CHECK (version >= 1)
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
CREATE TABLE schema_version (
  number     INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  applied_at TEXT NOT NULL
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
CREATE INDEX action_items_due ON action_items (due_date, lifecycle);
CREATE INDEX action_items_owner ON action_items (owner_id, lifecycle);
CREATE INDEX action_items_workstream ON action_items (workstream_id, lifecycle);
CREATE INDEX decisions_workstream ON decisions (workstream_id, status);
CREATE INDEX events_at ON events (at);
CREATE INDEX events_entity ON events (entity_kind, entity_id, id);
CREATE INDEX events_type ON events (type);
CREATE INDEX evidence_action_item ON evidence (action_item_id);
CREATE INDEX execution_steps_order ON execution_steps (action_item_id, step_order);
CREATE INDEX execution_steps_status ON execution_steps (status);
CREATE INDEX framework_instances_workstream ON framework_instances (workstream_id);
CREATE INDEX goals_parent ON goals (parent_id);
CREATE INDEX goals_workstream ON goals (workstream_id, status);
CREATE INDEX issues_workstream ON issues (workstream_id, status);
CREATE UNIQUE INDEX measure_values_period ON measure_values (measure_id, period_start);
CREATE INDEX meeting_instances_series ON meeting_instances (series_id, occurrence_start);
CREATE INDEX meeting_instances_state ON meeting_instances (state, scheduled_start);
CREATE INDEX meeting_series_status ON meeting_series (status);
CREATE INDEX risks_workstream ON risks (workstream_id, status);
CREATE INDEX runs_action_item ON runs (action_item_id, started_at);
CREATE INDEX runs_started ON runs (started_at);
CREATE INDEX workstreams_parent ON workstreams (parent_id);
