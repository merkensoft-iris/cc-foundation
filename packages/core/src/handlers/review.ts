/**
 * The methods the screens of 09 P1-11 need beyond the P1-04 surface: the review queue (03 §9.2,
 * owner decision Q5), accepting drafts (03 §7), deciding (03 §10), editing goals on the
 * Scorecard's Goals tab with their history (owner decision Q2), and risks, workspace-level ones
 * on the Workspace pseudo-workstream (owner decision Q4).
 *
 * Accept, confirm, attest, reject, decide and the goal edit are human-only (04 §4.3): the
 * dispatcher refuses an agent before these handlers run, and the domain refuses again.
 */
import {
  acceptItem,
  attestItem,
  confirmItem,
  decide,
  recordRisk,
  rejectClaim,
  reviewOptions,
  updateGoal,
} from '@cc/domain';
import { methods, type Evidence } from '@cc/schemas';
import type { Store } from '@cc/store';

import type { Dispatcher, HandlerContext } from '../dispatch.js';
import { domainCaller, domainContext } from '../domain.js';
import { CoreError } from '../errors.js';
import type { CommandOutcome, RecordStore, RecordView } from '../records.js';
import {
  findByRef,
  findPerson,
  findWorkstream,
  limitOf,
  notFound,
  Visibility,
  withoutVersion,
} from './common.js';

export function registerReviewHandlers(
  dispatcher: Dispatcher,
  records: RecordStore,
  store: Store,
): void {
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

  dispatcher.register(methods.itemsReview, (params, context) =>
    store.read((tx) => {
      const item = findByRef(tx, new Visibility(tx, context), 'action_items', params.ref);
      const evidence = tx
        .list('evidence')
        .filter((record) => record.actionItemId === item.id)
        .map((record) => withoutVersion<Evidence>(record));
      const review = reviewOptions(item, evidence);
      return { item, evidence, review: { ...review, notCheckable: [...review.notCheckable] } };
    }),
  );

  dispatcher.register(methods.itemsAccept, (params, context) =>
    command(context, (view, { ctx, visibility, caller }) => {
      const item = findByRef(view.tx, visibility, 'action_items', params.ref);
      if (item.lifecycle === 'open') {
        return { result: { status: 'no-op' as const, item }, changes: [] };
      }
      const outcome = acceptItem(ctx, caller, item, params.note);
      return { result: { status: outcome.status, item: outcome.record }, changes: outcome.changes };
    }),
  );

  dispatcher.register(methods.itemsConfirm, (params, context) =>
    command(context, (view, { ctx, visibility, caller }) => {
      const item = findByRef(view.tx, visibility, 'action_items', params.ref);
      const outcome = confirmItem(ctx, caller, item, view.evidenceOf(item.id));
      return { result: { status: outcome.status, item: outcome.record }, changes: outcome.changes };
    }),
  );

  dispatcher.register(methods.itemsAttest, (params, context) =>
    command(context, (view, { ctx, visibility, caller }) => {
      const item = findByRef(view.tx, visibility, 'action_items', params.ref);
      const outcome = attestItem(ctx, caller, item, params.note);
      return { result: { status: outcome.status, item: outcome.record }, changes: outcome.changes };
    }),
  );

  dispatcher.register(methods.itemsReject, (params, context) =>
    command(context, (view, { ctx, visibility, caller }) => {
      const item = findByRef(view.tx, visibility, 'action_items', params.ref);
      const outcome = rejectClaim(ctx, caller, item, params.reason);
      return { result: { status: outcome.status, item: outcome.record }, changes: outcome.changes };
    }),
  );

  dispatcher.register(methods.decisionsDecide, (params, context) =>
    command(context, (view, { ctx, visibility, caller }) => {
      const decision = findByRef(view.tx, visibility, 'decisions', params.ref);
      const outcome = decide(ctx, caller, decision, {
        text: params.text,
        why: params.why,
        ...(params.optionId === undefined ? {} : { optionId: params.optionId }),
        ...(params.waiverNote === undefined ? {} : { waiverNote: params.waiverNote }),
      });
      return {
        result: { status: outcome.status, decision: outcome.record },
        changes: outcome.changes,
      };
    }),
  );

  dispatcher.register(methods.goalsUpdate, (params, context) =>
    command(context, (view, { ctx, visibility, caller }) => {
      const goal = findByRef(view.tx, visibility, 'goals', params.ref);
      if (params.version !== undefined && params.version !== goal.version) {
        throw new CoreError(
          'E_CONFLICT',
          `${goal.ref} is at version ${String(goal.version)}, not ${String(params.version)}`,
          ['Reload the goal and retry'],
        );
      }
      const outcome = updateGoal(ctx, caller, goal, {
        ...(params.title === undefined ? {} : { title: params.title }),
        ...(params.doneMeans === undefined ? {} : { doneMeans: params.doneMeans }),
        ...(params.target === undefined ? {} : { target: params.target }),
        ...(params.health === undefined
          ? {}
          : {
              health: {
                value: params.health.value,
                ...(params.health.note === undefined ? {} : { note: params.health.note }),
              },
            }),
      });
      return { result: { status: outcome.status, goal: outcome.record }, changes: outcome.changes };
    }),
  );

  dispatcher.register(methods.goalsHistory, (params, context) =>
    store.read((tx) => {
      const goal = findByRef(tx, new Visibility(tx, context), 'goals', params.ref);
      const events = tx.history('goal', goal.id).map(withoutVersion);
      return { events: events.slice(0, limitOf(params)), total: events.length };
    }),
  );

  dispatcher.register(methods.risksList, (params, context) =>
    store.read((tx) => {
      const visibility = new Visibility(tx, context);
      const only =
        params.workstream === undefined
          ? undefined
          : findWorkstream(tx, visibility, params.workstream);
      const slugs = new Map(tx.list('workstreams').map((w) => [w.id as string, w.slug]));
      const matches = tx
        .list('risks')
        .filter((risk) => visibility.record(risk))
        .filter((risk) => only === undefined || risk.workstreamId === only.id)
        .filter((risk) => params.status === undefined || risk.status === params.status)
        .sort((a, b) => a.ref.localeCompare(b.ref));
      return {
        risks: matches.slice(0, limitOf(params)).map((risk) => ({
          ref: risk.ref,
          description: risk.description,
          trigger: risk.trigger,
          status: risk.status,
          workstream: slugs.get(risk.workstreamId) ?? risk.workstreamId,
        })),
        total: matches.length,
      };
    }),
  );

  dispatcher.register(methods.risksGet, (params, context) =>
    store.read((tx) => {
      const visibility = new Visibility(tx, context);
      const found = /^R-\d+$/.test(params.ref)
        ? tx.list('risks').find((risk) => risk.ref === params.ref)
        : tx.get('risks', params.ref);
      if (found === undefined || !visibility.record(found)) {
        throw notFound('risk', params.ref, 'cc-axi risks list');
      }
      return { risk: found };
    }),
  );

  dispatcher.register(methods.risksRecord, (params, context) =>
    command(context, (view, { ctx, visibility, caller }) => {
      const workstream = findWorkstream(view.tx, visibility, params.workstream);
      const same = view.tx
        .list('risks')
        .find(
          (risk) =>
            risk.status === 'watching' &&
            risk.workstreamId === workstream.id &&
            risk.description === params.description,
        );
      if (same !== undefined) {
        return { result: { status: 'no-op' as const, risk: same }, changes: [] };
      }
      const outcome = recordRisk(ctx, caller, {
        workstreamId: workstream.id,
        description: params.description,
        trigger: params.trigger,
        ...(params.watcher === undefined
          ? {}
          : { watcherId: findPerson(view.tx, params.watcher).id }),
      });
      return { result: { status: outcome.status, risk: outcome.record }, changes: outcome.changes };
    }),
  );
}
