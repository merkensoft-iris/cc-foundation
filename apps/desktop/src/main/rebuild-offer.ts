/**
 * The Rebuild now offer (04 §10 rule 2; owner decisions C1 and "Rebuild now", 10 Nov 2026;
 * ADR 0004 decision 6; AC-04-14).
 *
 * When the start check finds a clean checkout whose build is out of date (the user pulled a
 * merged update), main offers **Rebuild now** and **Later**. The offer is re-checked when the
 * app is idle, so a pull while CC runs is noticed, and it goes away once the build matches.
 * Rebuild now runs `rebuildNow` of `@cc/build-runtime` (the backup, then a build of the
 * committed tree outside the checkout); when it succeeds, main relaunches on the new build at
 * the first idle moment (no meeting `in_progress`, no run in flight). A failure changes
 * nothing and shows its reason and build log.
 *
 * Rebuild now is an app action, from the window or the tray. Nothing here is reachable from
 * the CLI or MCP (OQ-04-11).
 */
import { REASON_STALE, restartWhenIdle } from '@cc/build-runtime';

import type { Clock, TimerHandle } from './clock.js';
import type { StartCheck, StartVerdict } from './start-mode.js';

export type RebuildState =
  /** Nothing to offer: the build matches, the checkout is dirty, or the run is unpackaged. */
  | { readonly kind: 'none' }
  /** Rebuild now is offered; \`deferred\` once the user chose Later this run. */
  | { readonly kind: 'offered'; readonly reason: string; readonly deferred: boolean }
  | { readonly kind: 'building' }
  | { readonly kind: 'failed'; readonly reason: string; readonly log: string | null }
  /** Built: main relaunches on it at the first idle moment. */
  | { readonly kind: 'waiting-for-idle'; readonly busy: readonly string[] }
  | { readonly kind: 'restarting' };

export type RebuildOutcome =
  | { readonly ok: true; readonly app: string | null; readonly log: string }
  | { readonly ok: false; readonly reason: string; readonly log: string | null };

export interface RebuildOfferOptions {
  readonly clock: Clock;
  /** The start check, run again when the app is idle. */
  readonly check: StartCheck;
  /** Runs Rebuild now; undefined for a run without a build stamp (nothing to rebuild). */
  readonly rebuild: (() => Promise<RebuildOutcome>) | undefined;
  /** Why the app is not idle; empty when it is (the core's answer). */
  readonly activity: () => Promise<readonly string[]>;
  /** Quits and starts the packaged app at \`executable\`. */
  readonly relaunch: (executable: string) => void;
  readonly onChange: (state: RebuildState) => void;
  readonly log?: (event: string, fields?: Record<string, unknown>) => void;
  /** How often the offer is re-checked while idle; default 10 minutes. */
  readonly recheckMs?: number;
  /** How often a finished build checks for idle before restarting; default 30 s. */
  readonly idlePollMs?: number;
}

export const RECHECK_MS = 10 * 60_000;
export const IDLE_RESTART_POLL_MS = 30_000;

/** The reason shown with the offer: the first "build out of date" reason. */
function staleReason(verdict: StartVerdict): string {
  const reasons = verdict.mode.kind === 'developer' ? verdict.mode.reasons : [];
  return reasons.find((reason) => reason.startsWith(REASON_STALE)) ?? REASON_STALE;
}

export class RebuildOffer {
  readonly #options: RebuildOfferOptions;
  #state: RebuildState = { kind: 'none' };
  #recheck: TimerHandle | undefined;
  readonly #abort = new AbortController();

  constructor(options: RebuildOfferOptions) {
    this.#options = options;
  }

  get state(): RebuildState {
    return this.#state;
  }

  /** True while the tray and window should show a Rebuild now action. */
  get actionable(): boolean {
    return this.#state.kind === 'offered' || this.#state.kind === 'failed';
  }

  /** Applies the start check's verdict and starts the idle re-check. */
  start(verdict: StartVerdict): void {
    this.#apply(verdict);
    if (this.#options.rebuild !== undefined) this.#scheduleRecheck();
  }

  /** The user chose Rebuild now. Resolves when the build is done or has failed. */
  async rebuildNow(): Promise<RebuildState> {
    const rebuild = this.#options.rebuild;
    if (rebuild === undefined || !this.actionable) return this.#state;
    this.#set({ kind: 'building' });
    this.#options.log?.('rebuild.started');
    let outcome: RebuildOutcome;
    try {
      outcome = await rebuild();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      outcome = { ok: false, reason, log: null };
    }
    if (!outcome.ok) {
      this.#options.log?.('rebuild.failed', { reason: outcome.reason, log: outcome.log });
      this.#set({ kind: 'failed', reason: outcome.reason, log: outcome.log });
      return this.#state;
    }
    const app = outcome.app;
    if (app === null) {
      this.#set({ kind: 'failed', reason: 'the build produced no app', log: outcome.log });
      return this.#state;
    }
    this.#options.log?.('rebuild.built', { app });
    this.#set({ kind: 'waiting-for-idle', busy: [] });
    void this.#restartWhenIdle(app);
    return this.#state;
  }

  /** The user chose Later: the offer stays (tray) until the build matches. */
  later(): void {
    if (this.#state.kind === 'offered') this.#set({ ...this.#state, deferred: true });
    if (this.#state.kind === 'failed') this.#set({ kind: 'none' });
  }

  dispose(): void {
    this.#abort.abort();
    if (this.#recheck !== undefined) this.#options.clock.clearTimeout(this.#recheck);
    this.#recheck = undefined;
  }

  async #restartWhenIdle(app: string): Promise<void> {
    const { clock } = this.#options;
    const result = await restartWhenIdle({
      isIdle: async () => {
        const busy = await this.#options.activity();
        if (busy.length > 0) this.#set({ kind: 'waiting-for-idle', busy });
        return busy.length === 0;
      },
      restart: () => {
        this.#set({ kind: 'restarting' });
        this.#options.log?.('rebuild.restarting', { app });
        this.#options.relaunch(app);
      },
      intervalMs: this.#options.idlePollMs ?? IDLE_RESTART_POLL_MS,
      wait: (ms) => new Promise<void>((resolve) => void clock.setTimeout(resolve, ms)),
      signal: this.#abort.signal,
    });
    if (result === 'aborted') this.#options.log?.('rebuild.restart_abandoned');
  }

  #scheduleRecheck(): void {
    if (this.#abort.signal.aborted) return;
    this.#recheck = this.#options.clock.setTimeout(() => {
      this.#recheck = undefined;
      void this.#recheckWhenIdle().finally(() => this.#scheduleRecheck());
    }, this.#options.recheckMs ?? RECHECK_MS);
  }

  /** "At every start, and when the app is idle" (04 §10 rule 2). */
  async #recheckWhenIdle(): Promise<void> {
    if (this.#state.kind !== 'none' && this.#state.kind !== 'offered') return;
    if ((await this.#options.activity()).length > 0) return;
    let verdict: StartVerdict;
    try {
      verdict = await this.#options.check();
    } catch {
      return;
    }
    if (this.#state.kind === 'none' || this.#state.kind === 'offered') this.#apply(verdict);
  }

  #apply(verdict: StartVerdict): void {
    if (this.#options.rebuild === undefined || !verdict.offerRebuild) {
      if (this.#state.kind !== 'none') this.#set({ kind: 'none' });
      return;
    }
    const deferred = this.#state.kind === 'offered' && this.#state.deferred;
    const reason = staleReason(verdict);
    if (
      this.#state.kind !== 'offered' ||
      this.#state.reason !== reason ||
      this.#state.deferred !== deferred
    ) {
      this.#set({ kind: 'offered', reason, deferred });
    }
  }

  #set(state: RebuildState): void {
    this.#state = state;
    this.#options.onChange(state);
  }
}
