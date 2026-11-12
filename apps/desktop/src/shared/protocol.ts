/**
 * The messages between main and the core host, the `utilityProcess` that runs the core
 * service (04 §3). Main starts the host, sends `init` with the UI `MessagePort` as the one
 * transferred port, and supervises it; the host answers `ready`, then pushes notifications
 * and the notification policy as the core produces them.
 *
 * UI calls do not travel on this channel: they go over the transferred port as
 * `{ id, method, params }` and come back as `{ id, result }` or `{ id, error }`, the shape
 * `@cc/core`'s `serveUiPort` serves (04 §4.3 rule 1: calls on that port run as the user).
 */
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
  | { readonly type: 'init'; readonly userData: string; readonly mode: StartMode }
  | { readonly type: 'activity'; readonly id: number }
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
  | { readonly type: 'fatal'; readonly message: string };

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
    case 'fatal':
      return isString(value['message']) ? (value as HostToMain) : undefined;
    default:
      return undefined;
  }
}

export function isUiResponse(value: unknown): value is UiResponse {
  return isRecord(value) && 'id' in value && ('result' in value || isRecord(value['error']));
}
