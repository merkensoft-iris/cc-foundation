/**
 * Settings → Agent access (07 §5, 04 §4.2): list the principals, and add, change or revoke one.
 * Adding, changing and revoking are human-only (04 §4.3, 07 §5 rule 1); listing never shows a
 * token, only where the token file of a new principal was written.
 */
import { methods, type AgentPrincipal } from '@cc/schemas';

import type { Dispatcher } from '../dispatch.js';
import type { Principals } from '../principals.js';

function summary(principal: AgentPrincipal) {
  return {
    name: principal.name,
    kind: principal.kind,
    scopes: [...principal.scopes],
    workstreamFilter:
      principal.workstreamFilter === 'all' ? ('all' as const) : [...principal.workstreamFilter],
    sensitiveAccess: principal.sensitiveAccess,
    ...(principal.lastUsedAt === undefined ? {} : { lastUsedAt: principal.lastUsedAt }),
    ...(principal.revokedAt === undefined ? {} : { revokedAt: principal.revokedAt }),
  };
}

export function registerPrincipalHandlers(dispatcher: Dispatcher, principals: Principals): void {
  dispatcher.register(methods.principalsList, async () => {
    const all = (await principals.list()).sort((a, b) => a.name.localeCompare(b.name));
    return { principals: all.map(summary), total: all.length };
  });

  dispatcher.register(methods.principalsCreate, async (params, context) => {
    const principal = await principals.create(context.actor, {
      name: params.name,
      kind: params.kind,
      scopes: params.scopes,
      ...(params.workstreamFilter === undefined
        ? {}
        : { workstreamFilter: params.workstreamFilter }),
      ...(params.sensitiveAccess === undefined ? {} : { sensitiveAccess: params.sensitiveAccess }),
    });
    return { principal: summary(principal), tokenPath: principal.tokenPath };
  });

  dispatcher.register(methods.principalsUpdate, async (params, context) => {
    const principal = await principals.update(context.actor, params.name, {
      ...(params.scopes === undefined ? {} : { scopes: params.scopes }),
      ...(params.workstreamFilter === undefined
        ? {}
        : { workstreamFilter: params.workstreamFilter }),
      ...(params.sensitiveAccess === undefined ? {} : { sensitiveAccess: params.sensitiveAccess }),
    });
    return { principal: summary(principal) };
  });

  dispatcher.register(methods.principalsRevoke, async (params, context) => {
    const principal = await principals.revoke(context.actor, params.name);
    return { principal: summary(principal) };
  });
}
