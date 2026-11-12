/**
 * The start mode (ADR 0004, 04 §10 rule 4). Main runs the clean-tree check asynchronously,
 * in parallel with creating the window, and starts the core only once the mode is known, so
 * the core never runs schedulers or outside effects before it knows (ADR 0004 decision 3).
 *
 * The check itself, and the build and install stamps it reads, belong to
 * `@cc/build-runtime` (P1-16; ADR 0004 decisions 1 to 4): a packaged build checks the build
 * stamp `cc-build` wrote into its asar (`stampCheck`). An unpackaged development run has no
 * stamp, and that is developer mode: it was not built from a verified clean tree. A check
 * that throws also gives developer mode, never normal.
 */
import { checkStart, type BuildStamp } from '@cc/build-runtime';

import type { StartMode } from '../shared/protocol.js';

export type { StartMode };

/** What the check decided: the mode, and whether Rebuild now is offered (04 §10 rule 2). */
export interface StartVerdict {
  readonly mode: StartMode;
  /** A clean checkout whose build is out of date; never for a dirty one. */
  readonly offerRebuild: boolean;
}

/** The clean-tree check: resolves to the verdict for this start. */
export type StartCheck = () => Promise<StartVerdict>;

export const UNPACKAGED_REASON = 'unpackaged development run: no build stamp to check';

/** The check for a run without a build stamp. */
export const unpackagedCheck: StartCheck = () =>
  Promise.resolve({
    mode: { kind: 'developer', reasons: [UNPACKAGED_REASON] },
    offerRebuild: false,
  });

/** The check of a packaged build, against the stamp read from its asar (null: none). */
export function stampCheck(stamp: BuildStamp | null): StartCheck {
  return async () => {
    const { mode, offerRebuild } = await checkStart(stamp);
    return { mode, offerRebuild };
  };
}

/** Runs the check; any failure is developer mode with the failure as the reason. */
export async function resolveStartMode(check: StartCheck): Promise<StartVerdict> {
  try {
    const { mode, offerRebuild } = await check();
    if (mode.kind === 'developer' && mode.reasons.length === 0) {
      return { mode: { kind: 'developer', reasons: ['cannot verify tree'] }, offerRebuild };
    }
    return { mode, offerRebuild: offerRebuild && mode.kind === 'developer' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      mode: { kind: 'developer', reasons: [`cannot verify tree: ${detail}`] },
      offerRebuild: false,
    };
  }
}

export const APP_NAME = 'Command Center';

/** The window title: `[developer]` is appended in developer mode (ADR 0004 decision 7). */
export function windowTitle(mode: StartMode | undefined): string {
  return mode?.kind === 'developer' ? `${APP_NAME} [developer]` : APP_NAME;
}

/** The tray tooltip: names the first reason in developer mode. */
export function trayTooltip(mode: StartMode | undefined): string {
  if (mode?.kind !== 'developer') return APP_NAME;
  return `${APP_NAME}: developer mode (${mode.reasons[0] ?? 'cannot verify tree'})`;
}
