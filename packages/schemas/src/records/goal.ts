/** The Goal record, docs/design/03-decisions-and-action-items.md §5.3. */
import { z } from 'zod';

import {
  auditShape,
  FrameworkInstanceId,
  GoalId,
  Health,
  humanRef,
  LocalDate,
  MeasureId,
  PersonId,
  WorkstreamId,
} from './common.js';

/** eos-lite: priority; okr: objective/key_result; 4dx: wig; personal-os: personal_goal. */
export const GoalKind = z.enum([
  'vision',
  'annual',
  'priority',
  'objective',
  'key_result',
  'wig',
  'personal_goal',
]);
export type GoalKind = z.infer<typeof GoalKind>;

export const Goal = z
  .strictObject({
    id: GoalId,
    ref: humanRef('G'),
    workstreamId: WorkstreamId,
    frameworkInstanceId: FrameworkInstanceId,
    kind: GoalKind,
    title: z.string().min(1),
    /** Exactly one owner. */
    ownerId: PersonId,
    /** key_result -> objective; priority -> annual. */
    parentId: GoalId.optional(),
    /** label such as "2026-Q4". */
    period: z.strictObject({ start: LocalDate, end: LocalDate, label: z.string().min(1) }),
    doneMeans: z.string().optional(),
    measureIds: z.array(MeasureId),
    /** WIG: "from X to Y by when". */
    target: z
      .strictObject({ from: z.number(), to: z.number(), unit: z.string().min(1), by: LocalDate })
      .optional(),
    /** okr only; others 'committed'. */
    commitment: z.enum(['committed', 'aspirational']),
    status: z.enum(['active', 'done', 'not_done', 'dropped']),
    health: Health,
    /** Required when health is not on_track (INV-03-03), enforced in the domain. */
    healthNote: z.string().optional(),
    /** priority/rock: 1 or 0; okr: 0.0-1.0; wig: lag value at target.by. */
    grade: z.number().optional(),
    ...auditShape,
  })
  .describe('Goal (03 §5.3): a priority, objective, key result, WIG or personal goal');
export type Goal = z.infer<typeof Goal>;
