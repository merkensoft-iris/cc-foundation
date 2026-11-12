/**
 * The MeetingSeries and MeetingInstance records, docs/design/02-rhythm-and-calendar.md §3
 * (added by P1-07). Beyond the 02 §3 fields, both carry the audit fields of 03 §3, and:
 *
 * - `MeetingSeries.dtstart`: the local wall-clock start of the first occurrence. RFC 5545
 *   §3.8.5.3 leaves the set undefined when DTSTART is not an occurrence, so it is synced to the
 *   first occurrence whenever the series is created or changed (ADR 0001 decision 5).
 * - `MeetingInstance.occurrenceStart`: the RRULE occurrence the instance materialises. A one-off
 *   reschedule moves `scheduledStart` but not this, so materialisation stays idempotent
 *   (C-02-02) however often an instance is moved.
 * - `AgendaSectionInstance.absorbedFrom`: on an absorbing instance, the absorbed instance a
 *   section comes from (02 §4.3).
 */
import { z } from 'zod';

import { Cadence, FrameworkMode } from '../frameworks/framework.js';
import {
  ActionItemId,
  Actor,
  auditShape,
  ConnectorBindingId,
  DecisionId,
  FrameworkInstanceId,
  GoalId,
  humanRef,
  IanaTimeZone,
  IssueId,
  MeetingInstanceId,
  MeetingSeriesId,
  PersonId,
  RiskId,
  Sha256,
  UtcTimestamp,
  WorkstreamId,
} from './common.js';
import { RRuleText } from './rrule.js';

/** A local wall-clock date and time "2026-11-13T15:00", read in the accompanying time zone. */
export const LocalDateTime = z
  .string()
  .regex(/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d$/)
  .describe('Local date and time YYYY-MM-DDTHH:MM');

/** 02 §3: one calendar a series writes to (02 §9.6). */
export const SeriesCalendarBinding = z.strictObject({
  /** A binding of any connector that implements calendar@1 (02 §9.1). */
  bindingId: ConnectorBindingId,
  calendarId: z.string().min(1),
  /** Exactly one primary per series: its moves are accepted first (02 §9.4). */
  role: z.enum(['primary', 'mirror']),
  colour: z.string().min(1).optional(),
  /** "[CC] {{series.name}}"; sensitive workstreams use neutral titles. */
  titleTemplate: z.string().min(1),
  /** False in solo mode; true needs a send_publish confirmation. */
  inviteAttendees: z.boolean(),
});
export type SeriesCalendarBinding = z.infer<typeof SeriesCalendarBinding>;

export const MeetingSeries = z
  .strictObject({
    id: MeetingSeriesId,
    /** "Weekly CEO review". */
    name: z.string().min(1),
    cadence: Cadence,
    /** RFC 5545 of the ADR 0001 subset, local to timeZone; RDATE and EXDATE allowed. */
    rrule: RRuleText,
    /** Local start of the first occurrence (ADR 0001 decision 5). */
    dtstart: LocalDateTime,
    timeZone: IanaTimeZone,
    /** Within the BackboneMeeting bounds. */
    durationMinutes: z.int().min(1),
    /** More than one: a merged series (02 §4.4). */
    workstreamIds: z.array(WorkstreamId).min(1),
    frameworkInstanceIds: z.array(FrameworkInstanceId),
    /** e.g. "weekly"; "portfolio.daily-start" for the portfolio series of 02 §4.5. */
    backboneMeetingKey: z.string().min(1),
    /** 02 §5, e.g. "agenda.eos-lite.weekly@1". */
    agendaTemplateId: z.string().min(1),
    /** Within the section bounds. */
    agendaOverrides: z.array(
      z.strictObject({ sectionId: z.string().min(1), timeboxMinutes: z.int().min(0) }),
    ),
    /** Solo mode: [self]. */
    attendeeIds: z.array(PersonId),
    chairId: PersonId,
    mode: FrameworkMode,
    /** 02 §4.3. */
    absorbs: z.array(z.strictObject({ cadence: Cadence, absorbedMinutes: z.int().min(1) })),
    /** Empty: no calendar binding (.ics export only); several: the same events on each. */
    calendars: z.array(SeriesCalendarBinding),
    /** Default 1440 (24 h); daily meetings 30. */
    prereadLeadMinutes: z.int().min(0),
    /** Default [15]. */
    reminderMinutes: z.array(z.int().min(0)),
    /** Default 60 (02 §4.2). */
    graceMinutes: z.int().min(0),
    status: z.enum(['active', 'paused', 'ended']),
    ...auditShape,
  })
  .describe('MeetingSeries (02 §3): a backbone meeting as a recurring series');
export type MeetingSeries = z.infer<typeof MeetingSeries>;

export const InstanceState = z.enum([
  'planned',
  'scheduled',
  'prepared',
  'in_progress',
  'completed',
  'missed',
  'skipped',
  'absorbed',
  'cancelled',
]);
export type InstanceState = z.infer<typeof InstanceState>;

export const AgendaSectionInstance = z.strictObject({
  sectionId: z.string().min(1),
  /** Set when the section is perWorkstream (02 §4.4). */
  workstreamId: WorkstreamId.optional(),
  /** Set on an absorbing instance for the sections of the absorbed meeting (02 §4.3). */
  absorbedFrom: MeetingInstanceId.optional(),
  timeboxMinutes: z.int().min(0),
  inputResults: z.array(
    z.strictObject({
      queryId: z.string().min(1),
      count: z.int().min(0),
      itemRefs: z.array(z.string().min(1)),
      flags: z.array(z.string().min(1)),
    }),
  ),
  status: z.enum(['pending', 'done', 'skipped']),
});
export type AgendaSectionInstance = z.infer<typeof AgendaSectionInstance>;

export const MeetingOutputs = z.strictObject({
  decisionIds: z.array(DecisionId),
  actionItemIds: z.array(ActionItemId),
  issueIds: z.array(IssueId),
  riskIds: z.array(RiskId),
  measureValueIds: z.array(z.string().min(1)),
  goalIds: z.array(GoalId),
  statusUpdates: z.array(
    z.strictObject({
      ref: z.string().min(1),
      field: z.enum(['lifecycle', 'health', 'due']),
      from: z.string(),
      to: z.string(),
    }),
  ),
  verifications: z.array(
    z.strictObject({
      actionItemId: ActionItemId,
      result: z.enum(['confirmed', 'attested', 'rejected']),
    }),
  ),
});
export type MeetingOutputs = z.infer<typeof MeetingOutputs>;

export const MeetingInstance = z
  .strictObject({
    id: MeetingInstanceId,
    /** "M-0031". */
    ref: humanRef('M'),
    seriesId: MeetingSeriesId,
    /** The RRULE occurrence this instance materialises; a one-off reschedule keeps it. */
    occurrenceStart: UtcTimestamp,
    scheduledStart: UtcTimestamp,
    scheduledEnd: UtcTimestamp,
    actualStart: UtcTimestamp.optional(),
    actualEnd: UtcTimestamp.optional(),
    state: InstanceState,
    /** Snapshot taken when the pre-read is built. */
    agenda: z.array(AgendaSectionInstance),
    preread: z
      .strictObject({
        builtAt: UtcTimestamp,
        snapshotSha256: Sha256,
        renderedSha256: Sha256,
        inputsHash: z.string().min(1),
      })
      .optional(),
    outputs: MeetingOutputs,
    /** One per bound calendar. */
    calendarEvents: z.array(
      z.strictObject({
        bindingId: ConnectorBindingId,
        calendarId: z.string().min(1),
        eventId: z.string().min(1),
        etag: z.string().min(1),
        lastSyncedAt: UtcTimestamp,
      }),
    ),
    /** Missed instances whose agenda carried in (02 §4.2 rule 2). */
    carriedFrom: z.array(MeetingInstanceId),
    absorbedInstanceIds: z.array(MeetingInstanceId),
    absorbedBy: MeetingInstanceId.optional(),
    skipReason: z.string().min(1).optional(),
    rescheduledFrom: z
      .strictObject({ start: UtcTimestamp, by: Actor, at: UtcTimestamp })
      .optional(),
    /** The conclude step (02 §6.4). */
    readBackConfirmedAt: UtcTimestamp.optional(),
    /** 1-10, team mode or if enabled. */
    rating: z.int().min(1).max(10).optional(),
    /** Free text; may be AI-summarised, labelled as such. */
    notes: z.string(),
    ...auditShape,
  })
  .describe('MeetingInstance (02 §3): one materialised occurrence of a series');
export type MeetingInstance = z.infer<typeof MeetingInstance>;
