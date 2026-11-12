/**
 * The bridge to @cc/domain (P1-03): the domain is pure (D4), so the core hands each command
 * its clock, ID source and registry over the command's `RecordView`, runs it, and the record
 * store commits the writes it returns in the same transaction (03 §12 point 4). The dispatcher turns a domain error into the local
 * API error with its code and help lines (04 §4.1 rule 4, `asCoreError`).
 */
import type { Caller as DomainCaller, DomainContext } from '@cc/domain';

import type { Clock } from './clock.js';
import type { HandlerContext } from './dispatch.js';
import { newId } from './ids.js';
import { registryOf, type RecordView } from './records.js';

/** The domain's context for one command: the core's clock as RFC 3339, real IDs, the store. */
export function domainContext(view: RecordView, clock: Clock): DomainContext {
  return {
    clock: { now: () => clock.now().toISOString() },
    ids: {
      id: (prefix) => newId(prefix, clock),
      ref: (kind) => view.nextRef(kind),
    },
    registry: registryOf(view),
  };
}

/** The handler's caller as the domain sees it: the actor, and the principal's scopes. */
export function domainCaller(context: HandlerContext): DomainCaller {
  return context.principal === undefined
    ? { actor: context.actor }
    : { actor: context.actor, scopes: context.principal.scopes };
}
