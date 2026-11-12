-- 0002_meetings: the columns of meeting_series and meeting_instances, whose record types
-- P1-07 specified (MeetingSeries and MeetingInstance, 02 §3, in @cc/schemas). 0001 created
-- both tables with the storage envelope only (`doc` holding the whole record); this
-- migration replaces the envelope with the record's own columns, as 0001's header says the
-- build step that specifies a record does.
--
-- Scalar fields are columns and nested structures JSON columns (03 §12 point 3). Rows already
-- in the envelope are carried over field by field from `doc`, with the envelope's audit
-- columns; a row whose `doc` lacks a required field fails the migration rather than being
-- dropped. As in 0001, links between records (series_id, absorbed_by) are indexed columns,
-- not SQL constraints: the rhythm engine owns those rules (02 §4).
--
-- Forward-only (03 §12 point 5): this file never changes once merged. Add another
-- migration instead. Every table keeps its `version` column for optimistic concurrency,
-- and nested structures stay JSON columns validated by their schema in @cc/schemas.

CREATE TABLE meeting_series_0002 (
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

INSERT INTO meeting_series_0002
SELECT
  id,
  json_extract(doc, '$.name'),
  json_extract(doc, '$.cadence'),
  json_extract(doc, '$.rrule'),
  json_extract(doc, '$.dtstart'),
  json_extract(doc, '$.timeZone'),
  json_extract(doc, '$.durationMinutes'),
  json_extract(doc, '$.workstreamIds'),
  json_extract(doc, '$.frameworkInstanceIds'),
  json_extract(doc, '$.backboneMeetingKey'),
  json_extract(doc, '$.agendaTemplateId'),
  json_extract(doc, '$.agendaOverrides'),
  json_extract(doc, '$.attendeeIds'),
  json_extract(doc, '$.chairId'),
  json_extract(doc, '$.mode'),
  json_extract(doc, '$.absorbs'),
  json_extract(doc, '$.calendars'),
  json_extract(doc, '$.prereadLeadMinutes'),
  json_extract(doc, '$.reminderMinutes'),
  json_extract(doc, '$.graceMinutes'),
  json_extract(doc, '$.status'),
  created_at,
  created_by,
  updated_at,
  updated_by,
  version
FROM meeting_series;

DROP TABLE meeting_series;
ALTER TABLE meeting_series_0002 RENAME TO meeting_series;

CREATE INDEX meeting_series_status ON meeting_series (status);

CREATE TABLE meeting_instances_0002 (
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

INSERT INTO meeting_instances_0002
SELECT
  id,
  json_extract(doc, '$.ref'),
  json_extract(doc, '$.seriesId'),
  json_extract(doc, '$.occurrenceStart'),
  json_extract(doc, '$.scheduledStart'),
  json_extract(doc, '$.scheduledEnd'),
  json_extract(doc, '$.actualStart'),
  json_extract(doc, '$.actualEnd'),
  json_extract(doc, '$.state'),
  json_extract(doc, '$.agenda'),
  json_extract(doc, '$.preread'),
  json_extract(doc, '$.outputs'),
  json_extract(doc, '$.calendarEvents'),
  json_extract(doc, '$.carriedFrom'),
  json_extract(doc, '$.absorbedInstanceIds'),
  json_extract(doc, '$.absorbedBy'),
  json_extract(doc, '$.skipReason'),
  json_extract(doc, '$.rescheduledFrom'),
  json_extract(doc, '$.readBackConfirmedAt'),
  json_extract(doc, '$.rating'),
  json_extract(doc, '$.notes'),
  created_at,
  created_by,
  updated_at,
  updated_by,
  version
FROM meeting_instances;

DROP TABLE meeting_instances;
ALTER TABLE meeting_instances_0002 RENAME TO meeting_instances;

CREATE INDEX meeting_instances_series ON meeting_instances (series_id, occurrence_start);
CREATE INDEX meeting_instances_state ON meeting_instances (state, scheduled_start);
