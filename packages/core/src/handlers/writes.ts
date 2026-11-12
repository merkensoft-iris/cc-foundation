/**
 * The write methods of 04 §4.1 over the domain (P1-03) and the workspace store: create and
 * update items, drop (the user only), attach evidence, propose decisions, raise issues and
 * record measure values. Each is one command: the reads, the domain's checks and the writes
 * with one event each, in one transaction (03 §12 point 4, INV-03-09).
 *
 * The actor rules hold for every caller (04 §4.3): human-only methods never reach here from
 * an agent (the dispatcher refuses them first, and the domain refuses them again); items an
 * agent creates are drafts (03 §7); and an agent never writes into a workstream it cannot see
 * (07 §5): that is "not found", as for reads.
 */
import {
  addEvidence,
  checkMeasureValue,
  createActionItem,
  dropItem,
  isActive,
  linkedToIssue,
  proposeDecision,
  raiseIssue,
  setItemHealth,
  type NewActionItem,
} from '@cc/domain';
import { methods, type ActionItem, type MeasureValue } from '@cc/schemas';
import type { Store } from '@cc/store';

import type { Clock } from '../clock.js';
import type { Dispatcher, HandlerContext } from '../dispatch.js';
import { domainCaller, domainContext } from '../domain.js';
import { CoreError } from '../errors.js';
import { newId } from '../ids.js';
import type { CommandOutcome, EventOnly, RecordStore, RecordView } from '../records.js';
import {
  findByRef,
  findPerson,
  findWorkstream,
  localToday,
  Visibility,
  withoutVersion,
  workspaceOf,
} from './common.js';
import { toDomainEvidence } from './items.js';

/** The evidence kinds a requirement made from a plain description accepts (07 §4.2). */
const DESCRIBED_KINDS = ['url', 'file', 'connector_record', 'note'] as const;

/** The start of the period that holds `date`: Monday for weeks (ISO 8601), the 1st otherwise. */
export function periodStart(
  cadence: 'daily' | 'weekly' | 'monthly' | 'quarterly',
  date: string,
): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  switch (cadence) {
    case 'daily':
      return date;
    case 'weekly': {
      const utc = new Date(Date.UTC(year, month - 1, day));
      const back = (utc.getUTCDay() + 6) % 7;
      return new Date(utc.getTime() - back * 86_400_000).toISOString().slice(0, 10);
    }
    case 'monthly':
      return `${String(year)}-${String(month).padStart(2, '0')}-01`;
    case 'quarterly':
      return `${String(year)}-${String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
  }
}

/**
 * A proposed due date (07 §5 "propose due changes"; owner decision of 12 Nov 2026): recorded
 * as an `action_item.due_proposed` event in the item's history, the item unchanged, for the
 * user to re-plan in the app. The same proposal again, or the date the item already has,
 * records nothing.
 */
function proposeDue(
  view: RecordView,
  context: HandlerContext,
  item: ActionItem,
  proposal: { date: string; reason: string },
): EventOnly[] {
  if (!isActive(item)) {
    throw new CoreError(
      'E_INVARIANT',
      `${item.ref} is ${item.lifecycle}; it has no due date to move`,
      ['03 §7'],
    );
  }
  if (proposal.date === item.due.date) return [];
  const last = view.tx
    .history('action_item', item.id)
    .filter((event) => event.type === 'action_item.due_proposed')
    .at(-1)?.after as
    { proposedDue?: { date?: string }; reason?: string; due?: string } | undefined;
  if (
    last?.proposedDue?.date === proposal.date &&
    last.reason === proposal.reason &&
    last.due === item.due.date
  ) {
    return [];
  }
  return [
    {
      type: 'action_item.due_proposed',
      entity: { kind: 'action_item', id: item.id, ref: item.ref },
      after: {
        due: item.due.date,
        proposedDue: { date: proposal.date, timeZone: item.due.timeZone },
        reason: proposal.reason,
      },
      actor: context.actor,
    },
  ];
}

export function registerWriteHandlers(
  dispatcher: Dispatcher,
  records: RecordStore,
  store: Store,
  clock: Clock,
): void {
  /** One command with the caller's actor, its domain context and what it may see. */
  const command = <T>(
    context: HandlerContext,
    run: (
      view: RecordView,
      parts: {
        ctx: ReturnType<typeof domainContext>;
        visibility: Visibility;
        caller: ReturnType<typeof domainCaller>;
      },
    ) => CommandOutcome<T>,
  ): T =>
    records.command(context.actor, (view) =>
      run(view, {
        ctx: domainContext(view, context.clock),
        visibility: new Visibility(view.tx, context),
        caller: domainCaller(context),
      }),
    );

  dispatcher.register(methods.itemsCreate, (params, context) =>
    command(context, (view, { ctx, visibility, caller }) => {
      const workstream = findWorkstream(view.tx, visibility, params.workstream);
      if (params.meeting !== undefined) {
        // Meeting instances are records of the rhythm engine and agendas (P1-07, P1-08).
        throw new CoreError('E_NOT_FOUND', `no meeting ${params.meeting}`, [
          'Meeting capture arrives with the meetings surface; create the item without --meeting',
        ]);
      }
      const input: NewActionItem = {
        workstreamId: workstream.id,
        title: params.title,
        doneMeans: params.doneMeans,
        due: { date: params.due, timeZone: workstream.timeZone },
        ...(params.kind === undefined ? {} : { kind: params.kind }),
        ...(params.owner === undefined ? {} : { ownerId: findPerson(view.tx, params.owner).id }),
        evidenceRequirements: (params.evidence ?? []).map((description, index) => ({
          id: `er${String(index + 1)}`,
          description,
          required: true,
          acceptedKinds: [...DESCRIBED_KINDS],
        })),
        // 03 §7: created through the API, an item is a draft for the user to accept.
        lifecycle: 'draft',
      };
      const outcome = createActionItem(ctx, caller, input);
      return { result: { status: outcome.status, item: outcome.record }, changes: outcome.changes };
    }),
  );

  dispatcher.register(methods.itemsUpdate, (params, context) =>
    command(context, (view, { ctx, visibility, caller }) => {
      const item = findByRef(view.tx, visibility, 'action_items', params.ref);
      if (params.version !== undefined && params.version !== item.version) {
        throw new CoreError(
          'E_CONFLICT',
          `${item.ref} is at version ${String(item.version)}, not ${String(params.version)}`,
          [`Run \`cc-axi items view ${item.ref}\` and retry`],
        );
      }
      const proposal =
        params.proposeDue === undefined ? [] : proposeDue(view, context, item, params.proposeDue);
      const outcome =
        params.health === undefined
          ? { status: 'no-op' as const, record: item, changes: [] }
          : setItemHealth(ctx, caller, item, params.health.value, params.health.note);
      const changed = outcome.changes.length > 0 || proposal.length > 0;
      return {
        result: { status: changed ? ('ok' as const) : ('no-op' as const), item: outcome.record },
        changes: outcome.changes,
        events: proposal,
      };
    }),
  );

  // Human-only (04 §4.3): only the app's user reaches this handler.
  dispatcher.register(methods.itemsDrop, (params, context) =>
    command(context, (view, { ctx, visibility, caller }) => {
      const item = findByRef(view.tx, visibility, 'action_items', params.ref);
      if (item.lifecycle === 'dropped' && item.dropReason === params.reason) {
        return { result: { status: 'no-op' as const, item }, changes: [] };
      }
      const issues = view.tx
        .list('issues')
        .filter((issue) => issue.status === 'open' && item.links.issueIds.includes(issue.id));
      const items = view.tx
        .list('action_items')
        .filter((other) => issues.some((issue) => linkedToIssue(other, issue)));
      const outcome = dropItem(ctx, caller, item, params.reason, { issues, items });
      return { result: { status: outcome.status, item: outcome.record }, changes: outcome.changes };
    }),
  );

  dispatcher.register(methods.evidenceAdd, (params, context) =>
    command(context, (view, { ctx, visibility, caller }) => {
      const item = findByRef(view.tx, visibility, 'action_items', params.ref);
      const outcome = addEvidence(
        ctx,
        caller,
        item,
        view.evidenceOf(item.id),
        toDomainEvidence(view, params.evidence),
      );
      return {
        result: { status: outcome.status, evidence: outcome.record },
        changes: outcome.changes,
      };
    }),
  );

  dispatcher.register(methods.decisionsPropose, (params, context) =>
    command(context, (view, { ctx, visibility, caller }) => {
      const workstream = findWorkstream(view.tx, visibility, params.workstream);
      const outcome = proposeDecision(ctx, caller, {
        workstreamId: workstream.id,
        question: params.question,
        ...(params.options === undefined ? {} : { options: params.options }),
        ...(params.decider === undefined
          ? {}
          : { deciderId: findPerson(view.tx, params.decider).id }),
        ...(params.reversibility === undefined ? {} : { reversibility: params.reversibility }),
        ...(params.dueBy === undefined ? {} : { dueBy: params.dueBy }),
      });
      return {
        result: { status: outcome.status, decision: outcome.record },
        changes: outcome.changes,
      };
    }),
  );

  dispatcher.register(methods.issuesRaise, (params, context) =>
    command(context, (view, { ctx, visibility, caller }) => {
      const workstream = findWorkstream(view.tx, visibility, params.workstream);
      // The same open issue raised again is a no-op (07 §4.4), not a second issue.
      const same = view.tx
        .list('issues')
        .find(
          (issue) =>
            issue.status === 'open' &&
            issue.workstreamId === workstream.id &&
            issue.title === params.title,
        );
      if (same !== undefined)
        return { result: { status: 'no-op' as const, issue: same }, changes: [] };
      const outcome = raiseIssue(ctx, caller, { workstreamId: workstream.id, title: params.title });
      return {
        result: { status: outcome.status, issue: outcome.record },
        changes: outcome.changes,
      };
    }),
  );

  // A measure value is not a domain entity, so the core writes it with its event (03 §5.4).
  dispatcher.register(methods.measuresRecord, (params, context) =>
    store.command({ actor: context.actor }, (tx) => {
      const visibility = new Visibility(tx, context);
      const measure = findByRef(tx, visibility, 'measures', params.ref);
      if (measure.source.kind !== 'manual') {
        throw new CoreError(
          'E_INVARIANT',
          `${measure.ref} is a ${measure.source.kind} measure; its values are not recorded by hand`,
          ['03 §5.4'],
        );
      }
      if ((measure.unit === 'boolean') !== (typeof params.value === 'boolean')) {
        throw new CoreError(
          'E_USAGE',
          `${measure.ref} is measured in ${measure.unit}; give a ${measure.unit === 'boolean' ? 'true or false' : 'number'}`,
          ['03 §5.4'],
        );
      }
      const date = params.period ?? localToday(clock.now(), workspaceOf(tx).timeZone);
      const start = periodStart(measure.cadence, date);
      const existing = tx
        .list('measure_values')
        .find((value) => value.measureId === measure.id && value.periodStart === start);
      if (
        existing !== undefined &&
        existing.value === params.value &&
        existing.note === params.note
      ) {
        return { status: 'no-op' as const, value: withoutVersion<MeasureValue>(existing) };
      }
      const value: MeasureValue = {
        id: existing?.id ?? newId('mv', clock),
        measureId: measure.id,
        periodStart: start,
        value: params.value,
        source: 'manual',
        recordedAt: clock.now().toISOString(),
        recordedBy: context.actor,
        // Read as normal or not in the scorecard section (03 §5.4), so not yet read.
        normal: null,
        ...(params.note === undefined ? {} : { note: params.note }),
      };
      const violation = checkMeasureValue(value)[0];
      if (violation !== undefined) {
        throw new CoreError('E_INVARIANT', violation.message, [violation.rule]);
      }
      if (existing === undefined) tx.insert('measure_values', { ...value, version: 1 });
      else tx.update('measure_values', { ...value, version: existing.version }, existing.version);
      tx.event({
        type: 'measure_value.recorded',
        entity: { kind: 'measure_value', id: value.id },
        ...(existing === undefined
          ? {}
          : {
              before: {
                value: existing.value,
                ...(existing.note === undefined ? {} : { note: existing.note }),
              },
            }),
        after: {
          measureId: measure.id,
          periodStart: start,
          value: value.value,
          ...(value.note === undefined ? {} : { note: value.note }),
        },
        correlationId: measure.id,
      });
      return { status: 'ok' as const, value };
    }),
  );
}
