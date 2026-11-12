/**
 * The read methods of 04 §4.1 over the workspace store, for every caller (C-04-01): the home
 * view, lists, gets, history, search and export. Each runs in one read snapshot. An agent
 * principal sees only the workstreams of its filter, and sensitive ones only with
 * `sensitiveAccess` (07 §5, C-03-03); records it may not see are left out of lists and counts
 * and are "not found" by ref.
 *
 * Not served here: meeting search, confirmations and sessions counts (P1-13/P2-01 and P4), so
 * those read as empty. Today's meetings come from the rhythm engine's instances (P1-07, P1-08).
 */
import path from 'node:path';

import { localDateTime } from '@cc/domain';
import type { ActionItem, DomainEvent, ItemSummary } from '@cc/schemas';
import { methods } from '@cc/schemas';
import { exportWorkspace, MANIFEST_NAME, type ReadTx, type Store } from '@cc/store';

import type { Clock } from '../clock.js';
import type { Dispatcher, HandlerContext } from '../dispatch.js';
import { AGENT_ACCESS_HELP, CoreError } from '../errors.js';
import {
  byUrgency,
  CLOSED,
  displayState,
  findByRef,
  findPerson,
  findWorkstream,
  limitOf,
  localToday,
  localWithOffset,
  SEARCH_TABLES,
  Visibility,
  withoutVersion,
  workspaceOf,
} from './common.js';

/** Everything a read needs: the snapshot, what the caller sees, and "now". */
interface Read {
  readonly tx: ReadTx;
  readonly visibility: Visibility;
  readonly now: Date;
  readonly nowIso: string;
}

function reading<T>(
  store: Store,
  clock: Clock,
  context: HandlerContext,
  run: (read: Read) => T,
): T {
  return store.read((tx) => {
    const now = clock.now();
    return run({ tx, visibility: new Visibility(tx, context), now, nowIso: now.toISOString() });
  });
}

/** The item summary of 07 §4.1 rule 2, with the optional fields asked for. */
function summary(
  read: Read,
  item: ActionItem,
  fields: readonly string[] = [],
  selfPersonId?: string,
): ItemSummary {
  const row: ItemSummary = {
    ref: item.ref,
    title: item.title,
    due: item.due.date,
    state: displayState(item, read.nowIso),
  };
  const out: Record<string, unknown> = { ...row };
  if (fields.includes('owner')) {
    out['owner'] =
      item.ownerId === selfPersonId
        ? 'self'
        : (read.tx.get('persons', item.ownerId)?.displayName ?? item.ownerId);
  }
  if (fields.includes('health')) out['health'] = item.health;
  if (fields.includes('carry')) out['carry'] = item.carryCount;
  if (fields.includes('workstream')) {
    out['workstream'] = read.tx.get('workstreams', item.workstreamId)?.slug;
  }
  return out as ItemSummary;
}

/** The items the caller sees, in one workstream when one is named. */
function visibleItems(read: Read, workstream?: string): ActionItem[] {
  const only =
    workstream === undefined ? undefined : findWorkstream(read.tx, read.visibility, workstream);
  return read.tx
    .list('action_items')
    .filter((item) => read.visibility.record(item))
    .filter((item) => only === undefined || item.workstreamId === only.id);
}

/** Events of an item and of its evidence, oldest first (C-03-04). */
function itemHistory(tx: ReadTx, item: ActionItem): DomainEvent[] {
  const evidenceIds = tx
    .list('evidence')
    .filter((evidence) => evidence.actionItemId === item.id)
    .map((evidence) => evidence.id);
  return [
    ...tx.history('action_item', item.id),
    ...evidenceIds.flatMap((id) => tx.history('evidence', id)),
  ]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(withoutVersion);
}

/** The states of an instance that is on today's list: held, about to be, or being held. */
const HELD_STATES: ReadonlySet<string> = new Set([
  'planned',
  'scheduled',
  'prepared',
  'in_progress',
  'completed',
]);

/**
 * Today's meetings for the home view (07 §4.3): instances whose local start is today in the
 * workspace's time zone, earliest first, from series whose workstreams the caller sees.
 */
function todaysMeetings(read: Read, zone: string): { ref: string; time: string; title: string }[] {
  const today = localToday(read.now, zone);
  return read.tx
    .list('meeting_instances')
    .filter((instance) => HELD_STATES.has(instance.state))
    .map((instance) => ({
      instance,
      series: read.tx.get('meeting_series', instance.seriesId),
      local: localDateTime(instance.scheduledStart, zone),
    }))
    .filter(({ local }) => local.slice(0, 10) === today)
    .filter(
      ({ series }) =>
        series !== undefined && series.workstreamIds.some((id) => read.visibility.workstream(id)),
    )
    .sort((a, b) => a.instance.scheduledStart.localeCompare(b.instance.scheduledStart))
    .map(({ instance, series, local }) => ({
      ref: instance.ref,
      time: local.slice(11, 16),
      title: series?.name ?? instance.seriesId,
    }));
}

export function registerReadHandlers(dispatcher: Dispatcher, store: Store, clock: Clock): void {
  const read = <T>(context: HandlerContext, run: (read: Read) => T): T =>
    reading(store, clock, context, run);

  dispatcher.register(methods.homeGet, (params, context) =>
    read(context, (r) => {
      const workspace = workspaceOf(r.tx);
      const zone = workspace.timeZone;
      const weekOut = localToday(r.now, zone, 7);
      // Home counts accepted work: drafts wait for the user and are not "open" yet.
      const active = visibleItems(r, params.workstream).filter(
        (item) => !CLOSED.has(item.lifecycle) && item.lifecycle !== 'draft',
      );
      const dueSoon = active
        .filter((item) => item.lifecycle !== 'claimed_done')
        .filter((item) => displayState(item, r.nowIso) === 'overdue' || item.due.date < weekOut)
        .sort(byUrgency(r.nowIso));
      return {
        // 07 §4.3 names the workspace by its ID without the prefix: wsp_main is "main".
        workspace: workspace.id.replace(/^wsp_/, ''),
        now: localWithOffset(r.now, zone),
        today: todaysMeetings(r, zone),
        attention: {
          overdue: active.filter((item) => displayState(item, r.nowIso) === 'overdue').length,
          atRisk: active.filter((item) => item.health === 'at_risk' || item.health === 'off_track')
            .length,
          awaitingReview: active.filter((item) => item.lifecycle === 'claimed_done').length,
          confirmationsPending: active.filter((item) => item.waitingOn?.kind === 'confirmation')
            .length,
          // Browser sessions arrive in P4 (04 §5).
          sessionsNeedingYou: 0,
        },
        items: dueSoon.slice(0, 3).map((item) => summary(r, item, [], workspace.selfPersonId)),
        counts: { dueSoon: dueSoon.length, open: active.length },
      };
    }),
  );

  dispatcher.register(methods.itemsList, (params, context) =>
    read(context, (r) => {
      const self = r.tx.list('workspace', { limit: 1 })[0]?.selfPersonId;
      const owner = params.owner === undefined ? undefined : findPerson(r.tx, params.owner).id;
      const matches = visibleItems(r, params.workstream)
        .filter((item) =>
          params.state === undefined
            ? true
            : params.state === 'active'
              ? !CLOSED.has(item.lifecycle)
              : item.lifecycle === params.state,
        )
        .filter((item) => owner === undefined || item.ownerId === owner)
        .filter((item) => params.health === undefined || item.health === params.health)
        .filter((item) => params.dueBefore === undefined || item.due.date < params.dueBefore)
        .sort(byUrgency(r.nowIso));
      return {
        items: matches
          .slice(0, limitOf(params))
          .map((item) => summary(r, item, params.fields, self)),
        total: matches.length,
      };
    }),
  );

  dispatcher.register(methods.itemsGet, (params, context) =>
    read(context, (r) => ({ item: findByRef(r.tx, r.visibility, 'action_items', params.ref) })),
  );

  dispatcher.register(methods.itemsHistory, (params, context) =>
    read(context, (r) => {
      const item = findByRef(r.tx, r.visibility, 'action_items', params.ref);
      const events = itemHistory(r.tx, item);
      return { events: events.slice(0, limitOf(params)), total: events.length };
    }),
  );

  dispatcher.register(methods.searchQuery, (params, context) =>
    read(context, (r) => {
      const types = params.types ?? ['items', 'decisions', 'issues', 'meetings'];
      const hits = types.flatMap((type) => {
        // Meetings are not indexed until their records exist (P1-07, P1-08).
        if (type === 'meetings') return [];
        const table = SEARCH_TABLES[type];
        return r.tx
          .search(params.text, { tables: [table], limit: 1000 })
          .filter((hit) => hit.ref !== undefined)
          .filter((hit) => {
            const record = r.tx.get(table, hit.id) as { workstreamId: string } | undefined;
            return record !== undefined && r.visibility.record(record);
          })
          .map((hit) => ({
            type,
            ref: hit.ref ?? '',
            title: hit.title,
            snippet: hit.snippet,
            rank: hit.rank,
          }));
      });
      hits.sort((a, b) => a.rank - b.rank);
      return {
        hits: hits
          .slice(0, limitOf(params))
          .map((hit) => ({ type: hit.type, ref: hit.ref, title: hit.title, snippet: hit.snippet })),
        total: hits.length,
      };
    }),
  );

  dispatcher.register(methods.decisionsList, (params, context) =>
    read(context, (r) => {
      const only =
        params.workstream === undefined
          ? undefined
          : findWorkstream(r.tx, r.visibility, params.workstream);
      const matches = r.tx
        .list('decisions')
        .filter((decision) => r.visibility.record(decision))
        .filter((decision) => only === undefined || decision.workstreamId === only.id)
        .filter((decision) => params.status === undefined || decision.status === params.status)
        .sort((a, b) => a.ref.localeCompare(b.ref));
      return {
        decisions: matches.slice(0, limitOf(params)).map((decision) => ({
          ref: decision.ref,
          question: decision.question,
          status: decision.status,
          ...(decision.dueBy === undefined ? {} : { dueBy: decision.dueBy }),
        })),
        total: matches.length,
      };
    }),
  );

  dispatcher.register(methods.decisionsGet, (params, context) =>
    read(context, (r) => ({ decision: findByRef(r.tx, r.visibility, 'decisions', params.ref) })),
  );

  dispatcher.register(methods.issuesList, (params, context) =>
    read(context, (r) => {
      const only =
        params.workstream === undefined
          ? undefined
          : findWorkstream(r.tx, r.visibility, params.workstream);
      const matches = r.tx
        .list('issues')
        .filter((issue) => r.visibility.record(issue))
        .filter((issue) => only === undefined || issue.workstreamId === only.id)
        .filter((issue) => params.status === undefined || issue.status === params.status)
        // Ranked issues first, by rank (03 §11), then by ref.
        .sort(
          (a, b) =>
            (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) ||
            a.ref.localeCompare(b.ref),
        );
      return {
        issues: matches.slice(0, limitOf(params)).map((issue) => ({
          ref: issue.ref,
          title: issue.title,
          status: issue.status,
          ...(issue.rank === undefined ? {} : { rank: issue.rank }),
        })),
        total: matches.length,
      };
    }),
  );

  dispatcher.register(methods.issuesGet, (params, context) =>
    read(context, (r) => ({ issue: findByRef(r.tx, r.visibility, 'issues', params.ref) })),
  );

  dispatcher.register(methods.measuresList, (params, context) =>
    read(context, (r) => {
      const only =
        params.workstream === undefined
          ? undefined
          : findWorkstream(r.tx, r.visibility, params.workstream);
      const values = r.tx.list('measure_values');
      const matches = r.tx
        .list('measures')
        .filter((measure) => r.visibility.record(measure))
        .filter((measure) => only === undefined || measure.workstreamIds.includes(only.id))
        .sort((a, b) => a.ref.localeCompare(b.ref));
      return {
        measures: matches.slice(0, limitOf(params)).map((measure) => {
          const latest = values
            .filter((value) => value.measureId === measure.id)
            .sort((a, b) => b.periodStart.localeCompare(a.periodStart))[0];
          return {
            ref: measure.ref,
            name: measure.name,
            unit: measure.unit,
            target: measure.target,
            ...(latest === undefined
              ? {}
              : {
                  latest: {
                    periodStart: latest.periodStart,
                    value: latest.value,
                    normal: latest.normal,
                  },
                }),
          };
        }),
        total: matches.length,
      };
    }),
  );

  dispatcher.register(methods.measuresGet, (params, context) =>
    read(context, (r) => ({ measure: findByRef(r.tx, r.visibility, 'measures', params.ref) })),
  );

  dispatcher.register(methods.goalsList, (params, context) =>
    read(context, (r) => {
      const only =
        params.workstream === undefined
          ? undefined
          : findWorkstream(r.tx, r.visibility, params.workstream);
      const today = localToday(r.now, workspaceOf(r.tx).timeZone);
      const period = params.period ?? 'current';
      const inPeriod = (goal: { period: { start: string; end: string } }): boolean =>
        period === 'current'
          ? goal.period.start <= today && today <= goal.period.end
          : period === 'previous'
            ? goal.period.end < today
            : goal.period.start > today;
      const matches = r.tx
        .list('goals')
        .filter((goal) => r.visibility.record(goal))
        .filter((goal) => only === undefined || goal.workstreamId === only.id)
        .filter(inPeriod)
        .sort((a, b) => a.ref.localeCompare(b.ref));
      return {
        goals: matches.slice(0, limitOf(params)).map((goal) => ({
          ref: goal.ref,
          title: goal.title,
          kind: goal.kind,
          status: goal.status,
          health: goal.health,
        })),
        total: matches.length,
      };
    }),
  );

  dispatcher.register(methods.goalsGet, (params, context) =>
    read(context, (r) => ({ goal: findByRef(r.tx, r.visibility, 'goals', params.ref) })),
  );

  dispatcher.register(methods.workstreamsList, (params, context) =>
    read(context, (r) => {
      const matches = r.tx
        .list('workstreams')
        .filter((workstream) => r.visibility.workstream(workstream.id))
        .sort((a, b) => a.slug.localeCompare(b.slug));
      return {
        workstreams: matches.slice(0, limitOf(params)).map((workstream) => ({
          slug: workstream.slug,
          name: workstream.name,
          kind: workstream.kind,
          status: workstream.status,
        })),
        total: matches.length,
      };
    }),
  );

  dispatcher.register(methods.workstreamsGet, (params, context) =>
    read(context, (r) => ({ workstream: findWorkstream(r.tx, r.visibility, params.workstream) })),
  );

  dispatcher.register(methods.exportRun, (params, context) => {
    // The core runs apart from its caller, so a relative path would mean the core's directory.
    if (!path.isAbsolute(params.out)) {
      throw new CoreError('E_USAGE', `export needs an absolute directory, not ${params.out}`, [
        'Pass the full path of the export directory',
      ]);
    }
    // C-03-06: an export holds every record, so only a caller who sees every record may run
    // it: the user, or a principal with all workstreams and sensitive access.
    const allowed = read(context, (r) => r.visibility.everything);
    if (!allowed) {
      throw new CoreError(
        'E_FORBIDDEN',
        'an export contains every record; this principal does not see every workstream',
        [AGENT_ACCESS_HELP],
      );
    }
    const result = exportWorkspace(store, {
      outDir: params.out,
      now: () => clock.now().toISOString(),
    });
    return {
      out: result.outDir,
      manifest: MANIFEST_NAME,
      tables: result.manifest.tables.length,
      blobs: result.manifest.blobs.length,
    };
  });
}
