/**
 * What the app shell shows for a Tier H operation, and when a payload is Tier H at all
 * (04 §4.3 rule 4, C-04-12). The core writes every preview from the canonical payload: the
 * UI that asked never supplies the text the user confirms.
 *
 * - `principals.create`: Tier H when it grants a scope of `GRANT_ONLY_SCOPES` (07 §5 rule 3)
 *   or sensitive access. A new principal's workstream filter only narrows what its scopes
 *   allow, so it is shown but is not a reason on its own.
 * - `principals.update`: Tier H when the change adds a `GRANT_ONLY_SCOPES` scope the principal
 *   does not have, turns sensitive access on, or widens the workstream filter. Removing scopes
 *   or narrowing runs at once.
 * - `principals.revoke` and `backups.restore`: always.
 *
 * Tier H methods without a rule here get the generic preview of `confirm-intents.ts`.
 */
import type { AgentPrincipal, Scope } from '@cc/schemas';

import type { Backups } from './backups/engine.js';
import type { ConfirmRule } from './confirm-intents.js';
import { GRANT_ONLY_SCOPES, type Principals } from './principals.js';

/** The grant-only scopes in the words the user confirms (07 §5 rule 3). */
const GRANT_ONLY_WORDS: Readonly<Record<string, string>> = {
  'connectors:invoke': 'use your connected services on your behalf',
  'discovery:request': 'ask for connector discovery',
  'requests:propose': 'propose development requests',
  'onboarding:apply': 'apply onboarding answers to your workspace',
};

type WorkstreamFilter = AgentPrincipal['workstreamFilter'];

interface PrincipalPayload {
  readonly name: string;
  readonly kind?: string;
  readonly scopes?: readonly Scope[];
  readonly workstreamFilter?: WorkstreamFilter;
  readonly sensitiveAccess?: boolean;
}

function grantOnly(scopes: readonly Scope[]): Scope[] {
  return scopes.filter((scope) => GRANT_ONLY_SCOPES.includes(scope));
}

function grantLines(scopes: readonly Scope[]): string[] {
  return scopes.map((scope) => `- ${GRANT_ONLY_WORDS[scope] ?? scope} (${scope})`);
}

function workstreams(filter: WorkstreamFilter): string {
  return filter === 'all' ? 'all workstreams' : `workstreams ${filter.join(', ') || '(none)'}`;
}

/** Whether `next` lets a principal see a workstream `current` does not. */
export function widens(current: WorkstreamFilter, next: WorkstreamFilter | undefined): boolean {
  if (next === undefined || current === 'all') return false;
  if (next === 'all') return true;
  return next.some((workstream) => !current.includes(workstream));
}

function createRule(): ConfirmRule {
  return (params) => {
    const payload = params as PrincipalPayload;
    const scopes = [...new Set(payload.scopes ?? [])];
    const granted = grantOnly(scopes);
    if (granted.length === 0 && payload.sensitiveAccess !== true) return undefined;
    return [
      `Add agent access for "${payload.name}" (${payload.kind ?? 'agent'}).`,
      ...(granted.length === 0 ? [] : ['It will be allowed to:', ...grantLines(granted)]),
      ...(payload.sensitiveAccess === true ? ['It will see records marked sensitive.'] : []),
      `All its scopes: ${scopes.join(', ') || '(none)'}.`,
      `It sees ${workstreams(payload.workstreamFilter ?? 'all')}.`,
      'Command Center writes a new access token for it.',
    ].join('\n');
  };
}

function updateRule(principals: Principals): ConfirmRule {
  return async (params) => {
    const payload = params as PrincipalPayload;
    const current = await principals.get(payload.name);
    // An unknown principal changes nothing: the handler answers E_NOT_FOUND.
    if (current === undefined) return undefined;
    const added = grantOnly([...new Set(payload.scopes ?? [])]).filter(
      (scope) => !current.scopes.includes(scope),
    );
    const sensitiveOn = payload.sensitiveAccess === true && !current.sensitiveAccess;
    const widened = widens(current.workstreamFilter, payload.workstreamFilter);
    if (added.length === 0 && !sensitiveOn && !widened) return undefined;
    const scopesAfter =
      payload.scopes === undefined ? current.scopes : [...new Set(payload.scopes)];
    return [
      `Change agent access for "${payload.name}".`,
      ...(added.length === 0 ? [] : ['It will newly be allowed to:', ...grantLines(added)]),
      ...(sensitiveOn ? ['It will see records marked sensitive.'] : []),
      ...(widened && payload.workstreamFilter !== undefined
        ? [
            `It will see ${workstreams(payload.workstreamFilter)} (now ${workstreams(current.workstreamFilter)}).`,
          ]
        : []),
      `All its scopes after the change: ${scopesAfter.join(', ') || '(none)'}.`,
    ].join('\n');
  };
}

function revokeRule(): ConfirmRule {
  return (params) => {
    const { name } = params as PrincipalPayload;
    return [
      `Remove access for "${name}".`,
      'Its access token is deleted now, and it can no longer connect to Command Center.',
      'Adding it again later issues a new token.',
    ].join('\n');
  };
}

function restoreRule(backups: Backups): ConfirmRule {
  return (params) => {
    const { id } = params as { readonly id: string };
    const record = backups.list().backups.find((backup) => backup.id === id);
    return [
      `Restore your workspace from the backup ${id}${record === undefined ? '' : `, taken ${record.at}`}.`,
      'Command Center first backs up the current data, then restarts on the restored data.',
      'Changes made after that backup are replaced.',
    ].join('\n');
  };
}

/** The rules of the Tier H methods this core serves. */
export function confirmRules(deps: {
  readonly principals: Principals;
  readonly backups: Backups;
}): ReadonlyMap<string, ConfirmRule> {
  return new Map<string, ConfirmRule>([
    ['principals.create', createRule()],
    ['principals.update', updateRule(deps.principals)],
    ['principals.revoke', revokeRule()],
    ['backups.restore', restoreRule(deps.backups)],
  ]);
}
