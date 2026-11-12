/** Action templates, docs/design/03-decisions-and-action-items.md §8.4. */
import { z } from 'zod';

import { ActionKind, VerificationPolicy } from './action-item.js';
import { EvidenceRequirement } from './evidence.js';
import { stepShape } from './execution.js';

/**
 * A pack's reusable action template (03 §8.4). Not a stored record: packs carry it in their
 * YAML (01 §5.5), validated by @cc/frameworks with this schema.
 */
export const ActionTemplate = z
  .strictObject({
    /** "tpl.marketing.linkedin-batch". */
    id: z.string().min(1),
    /** "{{workstream}} LinkedIn batch, week {{isoWeek}}". */
    title: z.string().min(1),
    kind: ActionKind,
    doneMeans: z.string().min(1),
    /** Checks may reference binding roles. */
    evidenceRequirements: z.array(EvidenceRequirement),
    verificationPolicy: VerificationPolicy,
    steps: z.array(z.strictObject(stepShape)),
    /** e.g. { mail: { category: "email", connectorIds: [...] } }. */
    bindingRoles: z.record(
      z.string(),
      z.strictObject({ category: z.string().min(1), connectorIds: z.array(z.string().min(1)) }),
    ),
    defaultDueOffsetDays: z.int().min(0),
  })
  .describe('ActionTemplate (03 §8.4): a reusable action item definition in a pack');
export type ActionTemplate = z.infer<typeof ActionTemplate>;
