/**
 * Health rules of 03 §7:
 *
 * 1. The owner or user may set health at any time, with a note.
 * 2. The escalation job sets `off_track` when the due date has passed and the item is not
 *    claimed, and `at_risk` when a step failed or a wait has lasted longer than 3 days.
 * 3. The system never sets `on_track` over a user-set `at_risk` or `off_track`. Only the
 *    user clears these, or a claim that is then verified.
 *
 * Rule 3 is applied as: an actor other than the user never lowers health (on_track <
 * at_risk < off_track). The system and agents only raise it; the user, or a verification,
 * lowers it. That needs no record of who set the current health.
 */
import type { ActionItem, Health } from '@cc/schemas';

import { isPastDue } from './time.js';

export const HEALTH_SEVERITY: Record<Health, number> = { on_track: 0, at_risk: 1, off_track: 2 };

/** Lifecycles in which an item is still being worked on: the "open states" of 03 §7. */
export const WORKING: ReadonlySet<ActionItem['lifecycle']> = new Set([
  'open',
  'in_progress',
  'waiting',
]);

/** Lifecycles that are not closed: everything but verified_done and dropped. */
export function isActive(item: Pick<ActionItem, 'lifecycle'>): boolean {
  return item.lifecycle !== 'verified_done' && item.lifecycle !== 'dropped';
}

/** The longest a wait may last before rule 2 sets at_risk. */
export const WAIT_AT_RISK_DAYS = 3;

export interface HealthChange {
  readonly health: Health;
  readonly healthNote: string;
}

/**
 * Rule 2: the health the escalation job would set at `now`, or undefined. Never lowers the
 * current health (rule 3). Applies to items being worked on; a draft is not a commitment yet,
 * and a claimed item is claimed.
 */
export function escalationHealth(item: ActionItem, now: string): HealthChange | undefined {
  if (!WORKING.has(item.lifecycle)) return undefined;
  let next: HealthChange | undefined;
  if (isPastDue(item.due, now)) {
    next = {
      health: 'off_track',
      healthNote: `Due ${item.due.date} has passed and the item is not claimed`,
    };
  } else {
    const failed = item.execution.steps.find((step) => step.status === 'failed');
    if (failed !== undefined) {
      const code = failed.failure?.code ?? 'failed';
      next = { health: 'at_risk', healthNote: `Step ${failed.id} failed: ${code}` };
    } else if (
      item.lifecycle === 'waiting' &&
      item.waitingOn !== undefined &&
      Date.parse(now) - Date.parse(item.waitingOn.since) > WAIT_AT_RISK_DAYS * 86_400_000
    ) {
      next = {
        health: 'at_risk',
        healthNote: `Waiting on ${item.waitingOn.kind} for more than ${WAIT_AT_RISK_DAYS} days`,
      };
    }
  }
  if (next === undefined || HEALTH_SEVERITY[next.health] <= HEALTH_SEVERITY[item.health]) {
    return undefined;
  }
  return next;
}
