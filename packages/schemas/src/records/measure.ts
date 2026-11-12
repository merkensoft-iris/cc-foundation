/** The Measure and MeasureValue records, docs/design/03-decisions-and-action-items.md §5.4. */
import { z } from 'zod';

import {
  Actor,
  auditShape,
  ConnectorBindingId,
  humanRef,
  JsonObject,
  LocalDate,
  MeasureId,
  PersonId,
  UtcTimestamp,
  WorkstreamId,
} from './common.js';

export const MeasureSource = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('manual') }),
  z.strictObject({
    kind: z.literal('connector'),
    bindingId: ConnectorBindingId,
    action: z.string().min(1),
    input: JsonObject,
    valuePath: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('derived'),
    formula: z.enum([
      'action_items_closed_on_time_pct',
      'verified_items_count',
      'meetings_held_pct',
    ]),
  }),
]);
export type MeasureSource = z.infer<typeof MeasureSource>;

export const Measure = z
  .strictObject({
    id: MeasureId,
    ref: humanRef('K'),
    /** Usually one; K-0006 spans the merged review. */
    workstreamIds: z.array(WorkstreamId).min(1),
    name: z.string().min(1),
    ownerId: PersonId,
    unit: z.enum(['count', 'percent', 'currency', 'hours', 'boolean', 'days']),
    /** ISO 4217, e.g. "INR". */
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    /** 4DX lead/lag; Amazon's controllable input/output. */
    role: z.enum(['lead', 'lag']),
    cadence: z.enum(['daily', 'weekly', 'monthly', 'quarterly']),
    aggregation: z.enum(['sum', 'last', 'avg', 'max', 'min']),
    target: z.strictObject({
      op: z.enum(['gte', 'lte', 'eq', 'between']),
      value: z.union([z.number(), z.boolean()]),
      value2: z.number().optional(),
    }),
    source: MeasureSource,
    scorecardOrder: z.int().min(0),
    active: z.boolean(),
    ...auditShape,
  })
  .describe('Measure (03 §5.4): a scorecard number with its target and source');
export type Measure = z.infer<typeof Measure>;

export const MeasureValue = z
  .strictObject({
    id: z.string().min(1),
    measureId: MeasureId,
    /** Start of the week/month/quarter in the measure's time zone. */
    periodStart: LocalDate,
    value: z.union([z.number(), z.boolean()]),
    source: z.enum(['manual', 'connector', 'derived']),
    recordedAt: UtcTimestamp,
    recordedBy: Actor,
    /** Set in the scorecard section: normal / not normal / not yet read. */
    normal: z.boolean().nullable(),
    /** Required when normal === false, enforced in the domain. */
    note: z.string().optional(),
  })
  .describe('MeasureValue (03 §5.4): one period value of a measure');
export type MeasureValue = z.infer<typeof MeasureValue>;
