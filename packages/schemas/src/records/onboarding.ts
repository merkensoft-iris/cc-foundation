/**
 * The Onboarding record, docs/design/01-onboarding-and-frameworks.md §3 and §9.1 (P1-12): the
 * workspace's onboarding answers in the local store, which is their source of truth. The
 * wizard saves the answers after every step (`profile.completedSteps`), so onboarding can be
 * skipped and resumed; the S9 commit writes the records and sets `committedAt` (C-01-01).
 *
 * There is one per workspace. It holds answers, not secrets: the backup passphrase itself is
 * never stored here (`profile.workspace.backup.passphraseSet` only, 04 §9.1).
 */
import { z } from 'zod';

import { CalendarMapping, OnboardingProfile } from '../frameworks/onboarding.js';
import { auditShape, OnboardingId, UtcTimestamp } from './common.js';

export const Onboarding = z
  .strictObject({
    id: OnboardingId,
    /** Every answer so far; a complete profile once S9 commits. */
    profile: OnboardingProfile,
    /** The S7 calendar answers when the engine has no mapping (02 §9.6 rule 2). */
    calendarMapping: CalendarMapping.optional(),
    /** When S9 committed the records; absent until then. */
    committedAt: UtcTimestamp.optional(),
    ...auditShape,
  })
  .describe('Onboarding (01 §3, §9.1): the onboarding answers in the local store');
export type Onboarding = z.infer<typeof Onboarding>;
