/** The Issue and Risk records, docs/design/03-decisions-and-action-items.md §5.6 and §11. */
import { z } from 'zod';

import {
  ActionItemId,
  Actor,
  auditShape,
  GoalId,
  humanRef,
  IssueId,
  LocalDate,
  MeasureId,
  MeetingInstanceId,
  MeetingSeriesId,
  PersonId,
  RiskId,
  UtcTimestamp,
  WorkstreamId,
} from './common.js';

export const IssueOrigin = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('meeting'),
    meetingId: MeetingInstanceId,
    sectionId: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('escalation'),
    actionItemId: ActionItemId,
    level: z.literal(2),
  }),
  z.strictObject({ kind: z.literal('goal_off_track'), goalId: GoalId }),
  z.strictObject({
    kind: z.literal('measure_not_normal'),
    measureId: MeasureId,
    periodStart: LocalDate,
  }),
  z.strictObject({ kind: z.literal('rhythm'), seriesId: MeetingSeriesId }),
  z.strictObject({ kind: z.literal('manual') }),
]);
export type IssueOrigin = z.infer<typeof IssueOrigin>;

export const Issue = z
  .strictObject({
    id: IssueId,
    ref: humanRef('I'),
    workstreamId: WorkstreamId,
    title: z.string().min(1),
    raisedFrom: IssueOrigin,
    /** Set in the issues section; lower is more important. */
    rank: z.int().min(0).optional(),
    status: z.enum(['open', 'resolved', 'dropped']),
    /** refs: the decisions and action items that resolve it (INV-03-11). */
    resolution: z
      .strictObject({
        kind: z.enum(['decision', 'action', 'replan', 'dropped']),
        refs: z.array(z.string().min(1)),
        note: z.string(),
        at: UtcTimestamp,
        by: Actor,
      })
      .optional(),
    ...auditShape,
  })
  .describe('Issue (03 §5.6): a problem to identify, discuss and solve');
export type Issue = z.infer<typeof Issue>;

export const Risk = z
  .strictObject({
    id: RiskId,
    ref: humanRef('R'),
    /** The Workspace pseudo-workstream for workspace-level risks (03 §11, owner decision Q4). */
    workstreamId: WorkstreamId,
    /** "Client renewal: if no PO by 15 Dec, move build time to product". */
    description: z.string().min(1),
    watcherId: PersonId,
    trigger: z.string().min(1),
    status: z.enum(['watching', 'triggered', 'closed']),
    reviewCadence: z.literal('monthly'),
    ...auditShape,
  })
  .describe('Risk (03 §5.6): something that may happen, watched until it triggers or closes');
export type Risk = z.infer<typeof Risk>;
