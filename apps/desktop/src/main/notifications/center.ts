/**
 * Desktop notifications (02 §10). The core decides what is pushed and sends it to main;
 * main shows it now, or holds it while notifications are muted (quiet hours and `hard`
 * protected blocks, rule 4) and delivers everything held as one merged notification when
 * the mute ends. Kinds outside rule 2's list are refused: progress, retries and successful
 * syncs are never pushed (rule 3).
 *
 * Held notifications live in main's memory. If the app quits during a mute they are not
 * shown; what they announced is still in the in-app attention list (rule 1).
 */
import { PUSHED_KINDS, type NotificationPolicy, type PushRequest } from '../../shared/protocol.js';
import type { Clock, TimerHandle } from '../clock.js';
import { DEEP_LINK_SCHEME } from '../deep-links.js';
import { mutedUntil } from './quiet-hours.js';

/** What the platform shows: one OS notification. */
export interface ShownNotification {
  readonly title: string;
  readonly body: string;
  /** Opened on click; `commandcenter://` (Home) for a merged notification of mixed links. */
  readonly link: string;
  /** The pushes it carries, in arrival order. */
  readonly ids: readonly string[];
}

export type PushOutcome = 'shown' | 'held' | 'refused';

export interface NotificationCenterOptions {
  readonly clock: Clock;
  readonly show: (notification: ShownNotification) => void;
  readonly policy?: NotificationPolicy;
  readonly onRefused?: (request: unknown, reason: string) => void;
}

/** The longest single timer; a longer mute is re-checked when it fires. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** Merged notifications list at most this many titles. */
const MERGED_TITLES = 5;

export function mergeNotifications(held: readonly PushRequest[]): ShownNotification {
  const first = held[0];
  if (first === undefined) throw new Error('nothing to merge');
  const ids = held.map((request) => request.id);
  if (held.length === 1) {
    return {
      title: first.title,
      body: first.body ?? '',
      link: first.link ?? DEEP_LINK_SCHEME,
      ids,
    };
  }
  const titles = held.slice(0, MERGED_TITLES).map((request) => `• ${request.title}`);
  if (held.length > MERGED_TITLES) titles.push(`and ${held.length - MERGED_TITLES} more`);
  const links = new Set(held.map((request) => request.link ?? DEEP_LINK_SCHEME));
  return {
    title: `${held.length} notifications held during quiet time`,
    body: titles.join('\n'),
    link: links.size === 1 ? (links.values().next().value ?? DEEP_LINK_SCHEME) : DEEP_LINK_SCHEME,
    ids,
  };
}

export class NotificationCenter {
  readonly #clock: Clock;
  readonly #show: (notification: ShownNotification) => void;
  readonly #onRefused: ((request: unknown, reason: string) => void) | undefined;
  #policy: NotificationPolicy | undefined;
  /** Held pushes, by ID, in arrival order of their latest version. */
  readonly #held = new Map<string, PushRequest>();
  #timer: TimerHandle | undefined;
  #disposed = false;

  constructor(options: NotificationCenterOptions) {
    this.#clock = options.clock;
    this.#show = options.show;
    this.#onRefused = options.onRefused;
    this.#policy = options.policy;
  }

  /** Pushes held right now, oldest first. */
  get held(): readonly PushRequest[] {
    return [...this.#held.values()];
  }

  /** When held pushes will be delivered, if any are held. */
  get deliverAt(): Date | undefined {
    if (this.#held.size === 0) return undefined;
    const until = mutedUntil(this.#policy, this.#clock.now().getTime());
    return until === undefined ? this.#clock.now() : new Date(until);
  }

  push(request: PushRequest): PushOutcome {
    if (this.#disposed) return 'refused';
    if (!(PUSHED_KINDS as readonly string[]).includes(request.kind)) {
      this.#onRefused?.(request, `kind ${String(request.kind)} is not pushed (02 §10 rule 3)`);
      return 'refused';
    }
    const now = this.#clock.now().getTime();
    if (mutedUntil(this.#policy, now) === undefined && this.#held.size === 0) {
      this.#show(mergeNotifications([request]));
      return 'shown';
    }
    this.#held.delete(request.id);
    this.#held.set(request.id, request);
    this.#schedule();
    return 'held';
  }

  /** A new policy applies to held pushes at once: they may be due now, or later. */
  setPolicy(policy: NotificationPolicy | undefined): void {
    this.#policy = policy;
    if (this.#held.size > 0) this.#schedule();
  }

  dispose(): void {
    this.#disposed = true;
    this.#cancel();
    this.#held.clear();
  }

  #cancel(): void {
    if (this.#timer !== undefined) this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #schedule(): void {
    this.#cancel();
    const now = this.#clock.now().getTime();
    const until = mutedUntil(this.#policy, now);
    if (until === undefined) {
      this.#deliver();
      return;
    }
    this.#timer = this.#clock.setTimeout(
      () => {
        this.#timer = undefined;
        this.#schedule();
      },
      Math.min(until - now, MAX_TIMER_MS),
    );
  }

  #deliver(): void {
    if (this.#held.size === 0 || this.#disposed) return;
    const merged = mergeNotifications([...this.#held.values()]);
    this.#held.clear();
    this.#show(merged);
  }
}
