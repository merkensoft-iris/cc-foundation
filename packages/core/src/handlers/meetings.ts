/**
 * The `meetings.*` methods (04 §4.1, 07 §4.2) over the core's `Meetings` (P1-08, P1-09): the
 * week view, the runner's agenda with timeboxes and input rows, start, capture of draft items
 * and notes (02 §6.3; daily start and shutdown included, owner decision Q7), read-back, close,
 * and dismissing a daily-start attention entry (owner decision Q6).
 *
 * Starting, closing and dismissing are the user's (02 §4.2, §5.7): an agent with
 * `meetings:capture` passes the gate and is refused by the rhythm commands with E_FORBIDDEN.
 * The read-back confirmation is human-only (04 §4.3) and never reaches here from an agent.
 */
import type { CaptureRequest, Meetings } from '../meetings.js';
import { methods } from '@cc/schemas';
import type { Store } from '@cc/store';

import type { Clock } from '../clock.js';
import type { Dispatcher, HandlerContext } from '../dispatch.js';
import { domainCaller } from '../domain.js';
import { CoreError } from '../errors.js';
import { findPerson, findWorkstream, limitOf, localToday, Visibility } from './common.js';
import { periodStart } from './writes.js';

/** The workspace's time zone; UTC before onboarding sets one. */
function zoneOf(store: Store): string {
  return store.read((tx) => tx.list('workspace', { limit: 1 })[0]?.timeZone ?? 'UTC');
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** An agent sees a meeting only when it sees one of its series' workstreams (07 §5). */
function requireVisible(store: Store, context: HandlerContext, ref: string): void {
  if (context.principal === undefined) return;
  const visible = store.read((tx) => {
    const instance = ref.startsWith('mtg_')
      ? tx.get('meeting_instances', ref)
      : tx.list('meeting_instances').find((candidate) => candidate.ref === ref);
    if (instance === undefined) return true; // Meetings reports it as not found.
    const series = tx.get('meeting_series', instance.seriesId);
    const visibility = new Visibility(tx, context);
    return series?.workstreamIds.some((id) => visibility.workstream(id)) ?? false;
  });
  if (!visible) {
    throw new CoreError('E_NOT_FOUND', `no meeting ${ref}`, ['Run `cc-axi meetings list`']);
  }
}

export function registerMeetingHandlers(
  dispatcher: Dispatcher,
  meetings: Meetings,
  store: Store,
  clock: Clock,
): void {
  dispatcher.register(methods.meetingsList, (params, context) => {
    const today = localToday(clock.now(), zoneOf(store));
    const from = params.from ?? periodStart('weekly', today);
    const to = params.to ?? addDays(from, 6);
    if (to < from) {
      throw new CoreError('E_USAGE', `the range ends (${to}) before it starts (${from})`, [
        'Give --from on or before --to',
      ]);
    }
    const listed = meetings.list(from, to);
    const visible = store.read((tx) => {
      const visibility = new Visibility(tx, context);
      const refs = new Set(
        tx
          .list('meeting_instances')
          .filter((instance) =>
            (tx.get('meeting_series', instance.seriesId)?.workstreamIds ?? []).some((id) =>
              visibility.workstream(id),
            ),
          )
          .map((instance) => instance.ref),
      );
      return listed.meetings.filter((meeting) => refs.has(meeting.ref));
    });
    return {
      from,
      to,
      timeZone: listed.timeZone,
      meetings: visible.slice(0, limitOf(params)),
      total: visible.length,
    };
  });

  dispatcher.register(methods.meetingsGet, (params, context) => {
    requireVisible(store, context, params.ref);
    const view = meetings.view(params.ref);
    return {
      ...view,
      sections: view.sections.map((section) => ({
        ...section,
        allowedOutputs: [...section.allowedOutputs],
        rows: section.rows.map((row) => ({ ...row, flags: [...row.flags] })),
      })),
      readBack: [...view.readBack],
    };
  });

  dispatcher.register(methods.meetingsStart, (params, context) => {
    requireVisible(store, context, params.ref);
    return { meeting: meetings.start(domainCaller(context), params.ref) };
  });

  dispatcher.register(methods.meetingsCapture, (params, context) => {
    requireVisible(store, context, params.ref);
    const output = params.output;
    let request: CaptureRequest;
    if (output.kind === 'note') {
      request = { kind: 'note', text: output.text };
    } else {
      const resolved = store.read((tx) => {
        const visibility = new Visibility(tx, context);
        const workstream =
          output.workstream === undefined
            ? undefined
            : findWorkstream(tx, visibility, output.workstream);
        const owner = output.owner === undefined ? undefined : findPerson(tx, output.owner);
        const zone =
          workstream?.timeZone ?? tx.list('workspace', { limit: 1 })[0]?.timeZone ?? 'UTC';
        return { workstream, owner, zone };
      });
      request = {
        kind: 'action_item',
        item: {
          title: output.title,
          doneMeans: output.doneMeans,
          due: { date: output.due, timeZone: resolved.zone },
          ...(resolved.owner === undefined ? {} : { ownerId: resolved.owner.id }),
          ...(resolved.workstream === undefined ? {} : { workstreamId: resolved.workstream.id }),
        },
      };
    }
    const outcome = meetings.capture(
      domainCaller(context),
      params.ref,
      {
        sectionId: params.section.sectionId,
        ...(params.section.workstreamId === undefined
          ? {}
          : { workstreamId: params.section.workstreamId }),
        ...(params.section.absorbedFrom === undefined
          ? {}
          : { absorbedFrom: params.section.absorbedFrom }),
      },
      request,
    );
    return { status: outcome.status, meeting: outcome.instance };
  });

  dispatcher.register(methods.meetingsConfirm, (params, context) => {
    const outcome = meetings.confirmReadBack(domainCaller(context), params.ref, params.acceptances);
    return {
      status: outcome.status,
      meeting: outcome.record,
      accepted: [...outcome.accepted],
      pending: [...outcome.pending],
    };
  });

  dispatcher.register(methods.meetingsClose, (params, context) => {
    requireVisible(store, context, params.ref);
    const outcome = meetings.close(domainCaller(context), params.ref);
    return { status: outcome.status, meeting: outcome.record, carried: [...outcome.carried] };
  });

  dispatcher.register(methods.meetingsDismiss, (params, context) => {
    requireVisible(store, context, params.ref);
    return meetings.dismiss(domainCaller(context), params.ref, params.entry);
  });
}
