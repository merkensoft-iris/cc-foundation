/** The Workstream record, docs/design/03-decisions-and-action-items.md §5.2. */
import { z } from 'zod';

import {
  auditShape,
  FrameworkInstanceId,
  IanaTimeZone,
  PersonId,
  Privacy,
  WorkstreamId,
} from './common.js';

/**
 * `workspace` is the Workspace pseudo-workstream only (owner decision Q4, 10 Nov 2026, in
 * cc-foundation PR 3); it is never offered at onboarding S2.
 */
export const WorkstreamKind = z.enum([
  'company',
  'business_unit',
  'client_engagement',
  'project',
  'job_search',
  'personal',
  'other',
  'workspace',
]);
export type WorkstreamKind = z.infer<typeof WorkstreamKind>;

/** Lower-case slug used by the CLI, e.g. "alderwick". */
export const Slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .describe('Lower-case slug, unique in the workspace');

export const Workstream = z
  .strictObject({
    id: WorkstreamId,
    slug: Slug,
    name: z.string().min(1),
    kind: WorkstreamKind,
    parentId: WorkstreamId.optional(),
    /** Whose outcome: self, or another person. */
    principalId: PersonId,
    /** Who runs it in CC: always the user in v1. */
    stewardId: PersonId,
    timeZone: IanaTimeZone,
    status: z.enum(['active', 'paused', 'archived']),
    /** Absent when inheriting from the parent (01 rule R5), and on the Workspace pseudo-workstream. */
    frameworkInstanceId: FrameworkInstanceId.optional(),
    privacy: Privacy,
    aiDataPolicy: z.enum(['allow', 'redact_people', 'deny']),
    /** Local git repositories mapped to this workstream (ambient context, 07 §8). */
    repoPaths: z.array(z.string().min(1)),
    groundingRefs: z.array(
      z.strictObject({
        kind: z.enum(['profile', 'rubric', 'writing_style', 'master_resume']),
        path: z.string().min(1),
      }),
    ),
    ...auditShape,
  })
  .describe('Workstream (03 §5.2): a company, client, project or search the user runs in CC');
export type Workstream = z.infer<typeof Workstream>;
