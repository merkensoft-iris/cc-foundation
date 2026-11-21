/**
 * The messages between main and the core host, the `utilityProcess` that runs the core
 * service (04 §3). Main starts the host, sends `init` with the UI `MessagePort` as the one
 * transferred port, and supervises it; the host answers `ready`, then pushes notifications
 * and the notification policy as the core produces them.
 *
 * Backups (04 §9.1, P1-17): `init` carries the backup keys main keeps wrapped by
 * `safeStorage`, and `backup-keys` replaces them after the user sets a passphrase; the
 * passphrase itself never crosses. The host asks for `restart` after staging a restore, and
 * says `refused` when the core refuses to open the store (a data directory inside a synced
 * folder, 04 §9 rule 5): main then shows the help and exits instead of restarting it.
 *
 * Tier H confirmations (04 §4.3 rule 4, C-04-12): a safety-critical UI call answers
 * `{ status: 'needs_confirmation', intent }` instead of running. Only main can approve it, with
 * `approve-intent { id, intentId, payloadHash }` on this channel; the host answers with
 * `intent-result`. `deny-intent` drops it. The UI port has no message that approves.
 *
 * UI calls do not travel on this channel: they go over the transferred port as
 * `{ id, method, params }` and come back as `{ id, result }` or `{ id, error }`, the shape
 * `@cc/core`'s `serveUiPort` serves (04 §4.3 rule 1: calls on that port run as the user).
 */
import type { SerializedBackupKey } from '@cc/core/backup-keys';
import type { ApiErrorData, ProtectedBlock } from '@cc/schemas';

/** How this start was classified by the clean-tree check (ADR 0004, 04 §10 rule 4). */
export type StartMode =
  { readonly kind: 'normal' } | { readonly kind: 'developer'; readonly reasons: readonly string[] };

/** The kinds that are pushed as desktop notifications (02 §10 rule 2). */
export const PUSHED_KINDS = [
  'meeting_reminder',
  'confirmation_waiting',
  'browser_session_needs_you',
  'escalation',
  'failed_step',
  'rhythm_escalation',
  'backup_failing',
] as const;
export type PushedKind = (typeof PUSHED_KINDS)[number];

/** One notification the core asks main to push (02 §10). */
export interface PushRequest {
  /** Stable per subject: a second push with the same ID replaces a held one. */
  readonly id: string;
  readonly kind: PushedKind;
  readonly title: string;
  readonly body?: string;
  /** A `commandcenter://` link opened when the notification is clicked. */
  readonly link?: string;
}

/** When nothing may be pushed (02 §10 rule 4): quiet hours and `hard` protected blocks. */
export interface NotificationPolicy {
  /** The workspace time zone; quiet hours are wall-clock times in it. */
  readonly timeZone: string;
  readonly quietHours: readonly { readonly start: string; readonly end: string }[];
  /** Only `hard` blocks mute notifications; `soft` ones are ignored here. */
  readonly protectedBlocks: readonly ProtectedBlock[];
}

/**
 * main → core host. `init` carries the UI port as `ports[0]`. `activity` asks whether the
 * app is idle (04 §10 rule 2: the restart onto a new build waits for idle).
 */
export type MainToHost =
  | {
      readonly type: 'init';
      readonly userData: string;
      readonly mode: StartMode;
      readonly backupKeys?: readonly SerializedBackupKey[];
    }
  | { readonly type: 'activity'; readonly id: number }
  | { readonly type: 'backup-keys'; readonly keys: readonly SerializedBackupKey[] }
  /** The shell confirmed a Tier H intent: run it once, if `payloadHash` still matches. */
  | {
      readonly type: 'approve-intent';
      readonly id: number;
      readonly intentId: string;
      readonly payloadHash: string;
    }
  /** The shell's Cancel: drop the intent. */
  | { readonly type: 'deny-intent'; readonly intentId: string }
  | { readonly type: 'stop' };

/** core host → main. */
export type HostToMain =
  | {
      readonly type: 'ready';
      readonly endpoint?: { readonly transport: string; readonly path: string };
    }
  | { readonly type: 'notify'; readonly notification: PushRequest }
  | { readonly type: 'notification-policy'; readonly policy: NotificationPolicy }
  /** The answer to `activity`: why the app is not idle; empty when it is. */
  | { readonly type: 'activity'; readonly id: number; readonly busy: readonly string[] }
  /** Restart the core: a staged restore applies before the store opens (04 §9.1 rule 9). */
  | { readonly type: 'restart'; readonly reason: string }
  /** The core will not start here, and restarting cannot help (04 §9 rule 5, AC-04-12). */
  | {
      readonly type: 'refused';
      readonly code: string;
      readonly message: string;
      readonly help: readonly string[];
    }
  | { readonly type: 'fatal'; readonly message: string }
  /** The answer to `approve-intent`: the operation's result, or why it was refused. */
  | { readonly type: 'intent-result'; readonly id: number; readonly result: unknown }
  | { readonly type: 'intent-result'; readonly id: number; readonly error: ApiErrorData };

/** What a Tier H UI call answers in place of its result (`@cc/core` `NeedsConfirmation`). */
export interface ConfirmationIntent {
  readonly id: string;
  readonly method: string;
  /** What the operation will do, written by the core from the canonical payload. */
  readonly preview: string;
  readonly payloadHash: string;
  readonly expiresAt: string;
}
export interface NeedsConfirmation {
  readonly status: 'needs_confirmation';
  readonly intent: ConfirmationIntent;
}

/** A UI call on the port, and its answer (`@cc/core` `UiRequest` / `UiResponse`). */
export interface UiRequest {
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}
export type UiResponse =
  | { readonly id: number | string | null; readonly result: unknown }
  | { readonly id: number | string | null; readonly error: ApiErrorData };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === 'string';

function isPushRequest(value: unknown): value is PushRequest {
  if (!isRecord(value)) return false;
  return (
    isString(value['id']) &&
    value['id'].length > 0 &&
    (PUSHED_KINDS as readonly unknown[]).includes(value['kind']) &&
    isString(value['title']) &&
    value['title'].length > 0 &&
    (value['body'] === undefined || isString(value['body'])) &&
    (value['link'] === undefined || isString(value['link']))
  );
}

function isPolicy(value: unknown): value is NotificationPolicy {
  if (!isRecord(value)) return false;
  return (
    isString(value['timeZone']) &&
    Array.isArray(value['quietHours']) &&
    value['quietHours'].every(
      (range) => isRecord(range) && isString(range['start']) && isString(range['end']),
    ) &&
    Array.isArray(value['protectedBlocks']) &&
    value['protectedBlocks'].every(
      (block) =>
        isRecord(block) &&
        isString(block['rrule']) &&
        isString(block['timeZone']) &&
        typeof block['durationMinutes'] === 'number' &&
        (block['policy'] === 'hard' || block['policy'] === 'soft'),
    )
  );
}

/** Main checks every message from the host: the host is trusted code, but not its bugs. */
export function parseHostMessage(value: unknown): HostToMain | undefined {
  if (!isRecord(value)) return undefined;
  switch (value['type']) {
    case 'ready':
      return value as HostToMain;
    case 'notify':
      return isPushRequest(value['notification']) ? (value as HostToMain) : undefined;
    case 'notification-policy':
      return isPolicy(value['policy']) ? (value as HostToMain) : undefined;
    case 'activity':
      return typeof value['id'] === 'number' &&
        Array.isArray(value['busy']) &&
        value['busy'].every(isString)
        ? (value as HostToMain)
        : undefined;
    case 'restart':
      return isString(value['reason']) ? (value as HostToMain) : undefined;
    case 'refused':
      return isString(value['code']) &&
        isString(value['message']) &&
        Array.isArray(value['help']) &&
        value['help'].every(isString)
        ? (value as HostToMain)
        : undefined;
    case 'fatal':
      return isString(value['message']) ? (value as HostToMain) : undefined;
    case 'intent-result':
      return typeof value['id'] === 'number' && ('result' in value || isApiError(value['error']))
        ? (value as HostToMain)
        : undefined;
    default:
      return undefined;
  }
}

function isApiError(value: unknown): value is ApiErrorData {
  return (
    isRecord(value) &&
    isString(value['code']) &&
    isString(value['message']) &&
    Array.isArray(value['help']) &&
    value['help'].every(isString)
  );
}

/** A UI call's result that asks the shell to confirm (C-04-12). */
export function isNeedsConfirmation(value: unknown): value is NeedsConfirmation {
  if (!isRecord(value) || value['status'] !== 'needs_confirmation') return false;
  const intent = value['intent'];
  return (
    isRecord(intent) &&
    isString(intent['id']) &&
    isString(intent['method']) &&
    isString(intent['preview']) &&
    isString(intent['payloadHash']) &&
    isString(intent['expiresAt'])
  );
}

export function isUiResponse(value: unknown): value is UiResponse {
  return isRecord(value) && 'id' in value && ('result' in value || isRecord(value['error']));
}
