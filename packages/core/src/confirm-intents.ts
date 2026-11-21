/**
 * Confirmation intents for Tier H operations (04 §4.3 rule 4, C-04-12, AC-04-15).
 *
 * The app UI is the user (04 §4.3 rule 1), but whatever runs in that page can send a call. So
 * a Tier H operation (`confirm: 'shell'` in `human-only.ts`) arriving from the UI port does
 * not run. The core checks it as the dispatcher would (method, params), keeps the canonical
 * payload, and answers:
 *
 *   { status: 'needs_confirmation', intent: { id, method, preview, payloadHash, expiresAt } }
 *
 * `preview` is text the core writes from the canonical payload (`confirm-previews.ts`), never
 * text the UI supplies. The operation runs only when the app shell approves the intent over
 * the main ↔ core-host channel (`approve-intent` in `apps/desktop/src/shared/protocol.ts`),
 * which the UI port cannot reach: the UI port has no method that approves.
 *
 * An intent is single-use: the first approval attempt consumes it, whatever its outcome. It
 * expires (5 minutes by default) and runs only with the payload hash it was issued with; a
 * second approval, an expired one or one with another hash is refused and nothing changes.
 * It runs exactly the stored payload, through the dispatcher as the user, so the handler's
 * own checks (domain invariants, C-04-10's backup before a restore) still apply at that time.
 * Intents live in memory: a core restart drops them all.
 */
import { createHash } from 'node:crypto';

import type { Clock } from './clock.js';
import type { Caller, Dispatcher } from './dispatch.js';
import { CoreError } from './errors.js';
import { humanOnlyOperation, isShellConfirmed } from './human-only.js';
import { newId } from './ids.js';
import type { Logger } from './logger.js';
import { silentLogger } from './logger.js';

/** How long an intent may wait for the shell's confirmation. */
export const DEFAULT_INTENT_TTL_MS = 5 * 60_000;
/** Pending intents kept at most; the oldest is dropped first, so a flood cannot grow memory. */
export const MAX_PENDING_INTENTS = 32;

const USER: Caller = { kind: 'user' };

/** What the shell is asked to confirm. */
export interface ConfirmationIntent {
  /** `cfi_<ULID>`. */
  readonly id: string;
  readonly method: string;
  /** What the operation will do, written by the core from the canonical payload. */
  readonly preview: string;
  /** `sha256:<hex>` over the method and the canonical payload. */
  readonly payloadHash: string;
  readonly expiresAt: string;
}

/** The answer to a Tier H call from the UI port, in place of the method's result. */
export interface NeedsConfirmation {
  readonly status: 'needs_confirmation';
  readonly intent: ConfirmationIntent;
}

/**
 * Decides whether one payload of a Tier H method needs the shell's confirmation, and writes
 * the preview. `undefined` means this payload is not safety-critical and runs at once (for
 * example a `principals.update` that only removes scopes).
 */
export type ConfirmRule = (params: unknown) => Promise<string | undefined> | string | undefined;

export interface ConfirmIntentsOptions {
  readonly dispatcher: Dispatcher;
  readonly clock: Clock;
  /** Per-method rules; a Tier H method without one always needs confirmation. */
  readonly rules?: ReadonlyMap<string, ConfirmRule>;
  readonly ttlMs?: number;
  readonly logger?: Logger;
}

interface Pending {
  readonly intent: ConfirmationIntent;
  readonly params: unknown;
  readonly expiresAtMs: number;
}

/** JSON with object keys sorted at every level, so one payload always has one hash. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (record[key] !== undefined) sorted[key] = sortKeys(record[key]);
  }
  return sorted;
}

/** The hash an approval must carry: the method and its canonical payload. */
export function payloadHashOf(method: string, params: unknown): string {
  return `sha256:${createHash('sha256')
    .update(`${method}\n${canonicalJson(params)}`)
    .digest('hex')}`;
}

export function isNeedsConfirmation(value: unknown): value is NeedsConfirmation {
  if (typeof value !== 'object' || value === null) return false;
  const answer = value as Record<string, unknown>;
  const intent = answer['intent'] as Record<string, unknown> | undefined;
  return (
    answer['status'] === 'needs_confirmation' &&
    typeof intent === 'object' &&
    intent !== null &&
    typeof intent['id'] === 'string' &&
    typeof intent['method'] === 'string' &&
    typeof intent['preview'] === 'string' &&
    typeof intent['payloadHash'] === 'string' &&
    typeof intent['expiresAt'] === 'string'
  );
}

const AGAIN = 'Do it again in the app: a new confirmation is shown';

/** The intents of one core. */
export class ConfirmIntents {
  readonly #dispatcher: Dispatcher;
  readonly #clock: Clock;
  readonly #rules: ReadonlyMap<string, ConfirmRule>;
  readonly #ttlMs: number;
  readonly #logger: Logger;
  /** Insertion order is age order. */
  readonly #pending = new Map<string, Pending>();

  constructor(options: ConfirmIntentsOptions) {
    this.#dispatcher = options.dispatcher;
    this.#clock = options.clock;
    this.#rules = options.rules ?? new Map();
    this.#ttlMs = options.ttlMs ?? DEFAULT_INTENT_TTL_MS;
    this.#logger = options.logger ?? silentLogger;
  }

  /**
   * One call from the UI port, as the user. A Tier R call runs at once; a Tier H call whose
   * payload needs confirmation returns `NeedsConfirmation` and changes nothing.
   */
  async fromUi(method: string, params: unknown): Promise<unknown> {
    if (!isShellConfirmed(method)) return this.#dispatcher.call(USER, method, params);
    // The same checks as a call (unknown method, invalid params), before anything is kept.
    const canonical = this.#dispatcher.check(USER, method, params);
    const rule = this.#rules.get(method);
    const preview = rule === undefined ? defaultPreview(method, canonical) : await rule(canonical);
    if (preview === undefined) return this.#dispatcher.call(USER, method, canonical);
    return { status: 'needs_confirmation', intent: this.#issue(method, canonical, preview) };
  }

  /**
   * The shell confirmed: runs the intent's payload as the user, once. Refuses an unknown or
   * already used intent (`E_NOT_FOUND`), an expired one (`E_CONFLICT`) and another payload
   * (`E_PAYLOAD_CHANGED`, 07 §4.4).
   */
  async approve(id: string, payloadHash: string): Promise<unknown> {
    const pending = this.#pending.get(id);
    // Single use: any approval attempt consumes the intent, whatever its outcome.
    this.#pending.delete(id);
    this.#prune();
    if (pending === undefined) {
      this.#logger.warn('intent.refused', { id, reason: 'unknown' });
      throw new CoreError('E_NOT_FOUND', `no pending confirmation ${id}`, [
        'A confirmation runs once; it may have been used, denied or replaced',
        AGAIN,
      ]);
    }
    const { intent } = pending;
    if (this.#clock.now().getTime() >= pending.expiresAtMs) {
      this.#logger.warn('intent.refused', { id, method: intent.method, reason: 'expired' });
      throw new CoreError('E_CONFLICT', `the confirmation ${id} expired at ${intent.expiresAt}`, [
        AGAIN,
      ]);
    }
    if (payloadHash !== intent.payloadHash) {
      this.#logger.warn('intent.refused', { id, method: intent.method, reason: 'payload' });
      throw new CoreError(
        'E_PAYLOAD_CHANGED',
        `the approved payload is not the one confirmation ${id} was issued for`,
        [AGAIN],
      );
    }
    this.#logger.info('intent.approved', { id, method: intent.method });
    return this.#dispatcher.call(USER, intent.method, pending.params);
  }

  /** The shell's Cancel: drops the intent. True when there was one to drop. */
  deny(id: string): boolean {
    const had = this.#pending.delete(id);
    if (had) this.#logger.info('intent.denied', { id });
    return had;
  }

  /** How many intents wait for the shell (tests and diagnostics). */
  get size(): number {
    this.#prune();
    return this.#pending.size;
  }

  #issue(method: string, params: unknown, preview: string): ConfirmationIntent {
    this.#prune();
    while (this.#pending.size >= MAX_PENDING_INTENTS) {
      const oldest = this.#pending.keys().next().value;
      if (oldest === undefined) break;
      this.#pending.delete(oldest);
    }
    const now = this.#clock.now().getTime();
    const expiresAtMs = now + this.#ttlMs;
    const intent: ConfirmationIntent = {
      id: newId('cfi', this.#clock),
      method,
      preview,
      payloadHash: payloadHashOf(method, params),
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
    this.#pending.set(intent.id, { intent, params, expiresAtMs });
    this.#logger.info('intent.issued', { id: intent.id, method });
    return intent;
  }

  #prune(): void {
    const now = this.#clock.now().getTime();
    for (const [id, pending] of this.#pending) {
      if (now >= pending.expiresAtMs) this.#pending.delete(id);
    }
  }
}

/** For a Tier H method without its own rule: the operation and the exact payload. */
function defaultPreview(method: string, params: unknown): string {
  const operation = humanOnlyOperation(method)?.operation ?? method;
  return `Confirm ${operation} (${method}) with ${canonicalJson(params)}.`;
}
