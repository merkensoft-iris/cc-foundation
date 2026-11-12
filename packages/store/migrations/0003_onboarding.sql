-- 0003_onboarding: the onboarding table, which holds the workspace's onboarding answers
-- (01 §3, §9.1; P1-12). The local store is the source of truth for the answers: the wizard
-- saves them after every step, so onboarding can be skipped and resumed, and the S9 commit
-- sets committed_at. One row per workspace. The profile and the calendar mapping are JSON
-- columns validated by the Onboarding schema in @cc/schemas (03 §12 point 3). No secret is
-- stored here: the backup passphrase stays in the secret store (04 §9.1).
--
-- Forward-only (03 §12 point 5): this file never changes once merged. Add another
-- migration instead. Every table keeps its `version` column for optimistic concurrency,
-- and nested structures stay JSON columns validated by their schema in @cc/schemas.

CREATE TABLE onboarding (
  id               TEXT PRIMARY KEY,
  profile          TEXT NOT NULL CHECK (json_valid(profile)),
  calendar_mapping TEXT CHECK (calendar_mapping IS NULL OR json_valid(calendar_mapping)),
  committed_at     TEXT,
  created_at       TEXT NOT NULL,
  created_by       TEXT NOT NULL CHECK (json_valid(created_by)),
  updated_at       TEXT NOT NULL,
  updated_by       TEXT NOT NULL CHECK (json_valid(updated_by)),
  version          INTEGER NOT NULL CHECK (version >= 1)
) STRICT;
