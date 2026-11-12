/**
 * `items.claim` over the domain (P1-03) and the record store: the method AC-03-02 runs. The
 * other read and write methods are in reads.ts and writes.ts.
 *
 * Every handler serves both actors (04 §4.3 rule 1): the user through the app, an agent
 * through the socket. Human-only operations never reach here from an agent: the dispatcher
 * refuses them first, and the domain refuses them again.
 */
import { type EvidenceInput as DomainEvidence, addEvidence, claimItem } from '@cc/domain';
import { type EvidenceInput, methods } from '@cc/schemas';

import type { Dispatcher } from '../dispatch.js';
import { domainCaller, domainContext } from '../domain.js';
import { CoreError } from '../errors.js';
import type { RecordStore, RecordView } from '../records.js';
import { findByRef, Visibility } from './common.js';

/** The longest evidence summary (03 §5.9). */
const SUMMARY_MAX = 200;

function clip(text: string): string {
  return text.length <= SUMMARY_MAX ? text : `${text.slice(0, SUMMARY_MAX - 1)}…`;
}

/** Evidence as the API takes it (07 §4.2 `--evidence` forms), as the domain takes it. */
export function toDomainEvidence(records: RecordView, input: EvidenceInput): DomainEvidence {
  const requirement =
    input.requirementId === undefined ? {} : { requirementId: input.requirementId };
  switch (input.kind) {
    case 'url':
      return {
        kind: 'url',
        url: input.url,
        summary: input.summary ?? clip(input.url),
        ...requirement,
      };
    case 'connector_record': {
      const binding = records.binding(input.binding);
      if (binding === undefined) {
        throw new CoreError('E_NOT_FOUND', `no connector binding ${input.binding}`, [
          'Use the binding label shown in Settings → Connectors, or its bnd_ ID',
        ]);
      }
      return {
        kind: 'connector_record',
        record: {
          bindingId: binding.id,
          recordType: input.recordType,
          externalId: input.externalId,
        },
        summary:
          input.summary ?? clip(`${input.recordType} ${input.externalId} in ${binding.label}`),
        ...requirement,
      };
    }
    case 'note':
      if (input.text.length > SUMMARY_MAX) {
        throw new CoreError('E_PARAM_BOUNDS', 'a note is at most 200 characters (03 §5.9)', [
          'Shorten the note, or attach the full text as a file',
        ]);
      }
      return { kind: 'note', summary: input.summary ?? input.text, ...requirement };
    case 'file':
      // Files become content-addressed blobs in the store (03 §5.9); copying a file in comes
      // with the attach surface (P1-05).
      throw new CoreError('E_USAGE', 'file evidence is not accepted yet', [
        'Attach a URL or a connector record instead',
      ]);
  }
}

export function registerItemHandlers(dispatcher: Dispatcher, records: RecordStore): void {
  dispatcher.register(methods.itemsClaim, (params, context) =>
    // One command: the reads, the evidence and the claim in one transaction (03 §12 point 4).
    records.command(context.actor, (view) => {
      const ctx = domainContext(view, context.clock);
      const caller = domainCaller(context);
      const item = findByRef(view.tx, new Visibility(view.tx, context), 'action_items', params.ref);
      const inputs = params.evidence.map((evidence) => toDomainEvidence(view, evidence));
      const evidence = view.evidenceOf(item.id);
      const added = inputs.map((input) => {
        const outcome = addEvidence(ctx, caller, item, evidence, input);
        if (outcome.status === 'ok') evidence.push(outcome.record);
        return outcome;
      });
      const claimed = claimItem(ctx, caller, item, evidence, params.note);
      const changes = [...added.flatMap((outcome) => outcome.changes), ...claimed.changes];
      return {
        changes,
        result: {
          status: changes.length === 0 ? ('no-op' as const) : ('ok' as const),
          item: claimed.record,
          evidence: added.map((outcome) => outcome.record),
        },
      };
    }),
  );
}
