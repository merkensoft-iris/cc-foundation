/**
 * The Rebuild now strip of the window (04 §10 rule 2): what it says for each state of main's
 * offer, and which of Rebuild now and Later it shows. Pure, so it is tested headless.
 */
import type { RebuildState } from './bridge.js';

/** What the Rebuild now strip says, and which buttons it shows (04 §10 rule 2). */
export function describeRebuild(state: RebuildState): {
  readonly text: string;
  readonly now: boolean;
  readonly later: boolean;
} | null {
  switch (state.kind) {
    case 'none':
      return null;
    case 'offered':
      return state.deferred
        ? null
        : {
            text: `This app is older than its engine checkout (${state.reason}).`,
            now: true,
            later: true,
          };
    case 'building':
      return { text: 'Rebuilding from the checkout…', now: false, later: false };
    case 'failed':
      return {
        text: `Rebuild failed: ${state.reason}. Nothing changed.${state.log === null ? '' : ` Build log: ${state.log}`}`,
        now: true,
        later: true,
      };
    case 'waiting-for-idle':
      return {
        text: `Rebuilt. Restarting when idle${state.busy.length > 0 ? ` (waiting: ${state.busy.join(', ')})` : ''}.`,
        now: false,
        later: false,
      };
    case 'restarting':
      return { text: 'Restarting on the new build…', now: false, later: false };
  }
}
