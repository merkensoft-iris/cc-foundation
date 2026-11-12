/**
 * `cc-axi onboarding export --out profile.json` (01 §9.1 rule 3, C-01-09): the answers only,
 * for the user to review and commit to their engine repository if they wish. No records, no
 * secrets, no person names, and workstreams by key, never by name:
 *
 * - each workstream's `name` becomes its key, and its free-text `notes` are left out (they may
 *   name anyone);
 * - another person who is a workstream's principal becomes a role token, `[Principal of
 *   <key>]`, and the consent they gave is recorded as given in the app, not quoted;
 * - grounding files keep their kind, not their path (a path names the machine's user);
 * - the app-only answers stay out: the backup destination and whether a passphrase is set
 *   (01 §3.1 rows 9 and 10);
 * - the recommendations are left out: they are the recommender's output, computed again on
 *   import (C-01-02); the S4 choices (`accepted`) stay.
 *
 * Measure names, goal titles and role tokens are answers and stay; the user reviews the file
 * before committing it.
 */
import type { OnboardingProfile } from '@cc/schemas';

export const CONSENT_RECORDED = 'Recorded in the app';

export function exportProfile(profile: OnboardingProfile): OnboardingProfile {
  const workspace = { ...profile.workspace };
  delete workspace.backup;
  const out: OnboardingProfile = {
    version: profile.version,
    completedSteps: profile.completedSteps.filter((step) => step !== 'commit'),
    workspace,
    workstreams: profile.workstreams.map((workstream) => {
      const copy = { ...workstream, name: workstream.key };
      delete copy.notes;
      if (copy.principal.kind === 'other') {
        copy.principal = {
          ...copy.principal,
          displayName: `[Principal of ${workstream.key}]`,
          consentNote: CONSENT_RECORDED,
        };
      }
      return copy;
    }),
    tools: profile.tools.map((tool) => ({ ...tool })),
    ai: { ...profile.ai },
  };
  if (profile.tailoring !== undefined) {
    out.tailoring = profile.tailoring.map((tailoring) => ({
      ...tailoring,
      ...(tailoring.groundingRefs === undefined
        ? {}
        : {
            groundingRefs: tailoring.groundingRefs.map((ref) => ({ kind: ref.kind, path: null })),
          }),
    }));
  }
  if (profile.rhythm !== undefined) out.rhythm = profile.rhythm;
  if (profile.accepted !== undefined) out.accepted = profile.accepted;
  return out;
}
