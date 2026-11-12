/**
 * INV-03-10: `sensitive` content (the client engagement) never appears in calendar event text,
 * and goes to AI providers only under the workstream's `aiDataPolicy` (04 §6.5). The calendar
 * writer (P2-07) and the AI layer (P3-03) call these; `checkPrivacy` in invariants.ts keeps an
 * item's privacy from being lowered.
 */
import type { Privacy, Workstream } from '@cc/schemas';

/** The neutral text a calendar event shows in place of sensitive content. */
export const PRIVATE_CALENDAR_TEXT = 'Private';

/** The text a calendar event may carry for a record of this privacy. */
export function calendarEventText(privacy: Privacy, text: string): string {
  return privacy === 'sensitive' ? PRIVATE_CALENDAR_TEXT : text;
}

/**
 * The AI data policy that applies to content of a workstream. Sensitive content follows the
 * workstream's policy; `deny` sends nothing.
 */
export function aiDataPolicyFor(
  workstream: Pick<Workstream, 'aiDataPolicy'>,
): Workstream['aiDataPolicy'] {
  return workstream.aiDataPolicy;
}

/** Whether content of this workstream may be sent to an AI provider at all. */
export function maySendToAi(workstream: Pick<Workstream, 'aiDataPolicy'>): boolean {
  return aiDataPolicyFor(workstream) !== 'deny';
}
