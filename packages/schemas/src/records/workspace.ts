/** The Workspace record, docs/design/03-decisions-and-action-items.md §5.1. */
import { z } from 'zod';

import { auditShape, IanaTimeZone, PersonId, WorkspaceId } from './common.js';

const counter = z.int().min(1);

export const Workspace = z
  .strictObject({
    id: WorkspaceId,
    displayName: z.string().min(1),
    timeZone: IanaTimeZone,
    selfPersonId: PersonId,
    /** Next HumanRef number per kind: A-0142, D-0008, I-0012, R-0002, M-0031, G-0004, K-0009. */
    counters: z.strictObject({
      A: counter,
      D: counter,
      I: counter,
      R: counter,
      M: counter,
      G: counter,
      K: counter,
    }),
    ...auditShape,
  })
  .describe('Workspace (03 §5.1): the top-level record that holds workstreams and people');
export type Workspace = z.infer<typeof Workspace>;
