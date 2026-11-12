/** The FrameworkInstance record, docs/design/01-onboarding-and-frameworks.md §4. */
import { z } from 'zod';

import {
  FrameworkId,
  FrameworkMode,
  ForkedFrom,
  GoalModel,
  PackId,
  SemVer,
  Vocabulary,
} from '../frameworks/framework.js';
import {
  auditShape,
  FrameworkInstanceId,
  MeetingSeriesId,
  UtcTimestamp,
  WorkstreamId,
} from './common.js';

/**
 * One workstream's framework: a template plus parameters plus packs (01 §1 item 2). A
 * workstream has at most one active instance, the one its `frameworkInstanceId` names
 * (C-01-05); a replaced instance stays as history (01 §9).
 */
export const FrameworkInstance = z
  .strictObject({
    id: FrameworkInstanceId,
    workstreamId: WorkstreamId,
    templateId: FrameworkId,
    templateVersion: SemVer,
    mode: FrameworkMode,
    goalModel: GoalModel,
    packIds: z.array(PackId),
    /** Validated against the template's ParameterSpec bounds (C-01-04). */
    parameters: z.record(z.string(), z.unknown()),
    vocabularyOverrides: Vocabulary.partial(),
    /** 02. */
    seriesIds: z.array(MeetingSeriesId),
    /** Last successful invariant check (C-01-03). */
    validatedAt: UtcTimestamp,
    /** Set for custom:*. */
    forkedFrom: ForkedFrom.optional(),
    ...auditShape,
  })
  .describe(
    'FrameworkInstance (01 §4): one workstream framework, template plus parameters plus packs',
  );
export type FrameworkInstance = z.infer<typeof FrameworkInstance>;
