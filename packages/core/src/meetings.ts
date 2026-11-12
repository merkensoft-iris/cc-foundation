/**
 * Meetings on the workspace store (P1-08; 02 §5, §6): pre-reads, start, output capture,
 * read-back and close; with P1-09 (02 §7, §9.1) the close carries items and runs the escalation
 * job in its transaction, the nightly escalation run, and the .ics export. Each operation is one store command: the reads, the pure @cc/rhythm
 * command, and its writes with one event each, in one transaction (03 §12 point 4, INV-03-09).
 *
 * The pre-read's two files (canonical JSON and Markdown) go to the content-addressed blob store,
 * `blobs/<sha256[0:2]>/<sha256>` (03 §12 point 1), before the instance records their hashes; a
 * blob is written once and never changed, so a rolled-back command leaves at most an unreferenced
 * blob. Export carries both (store table spec `blobFields`).
 *
 * No local API method or CLI command reaches these yet (the `meetings.*` namespace); the
 * human-only rules hold in the pure commands, whichever surface calls them.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { forbidden, isUser, localDate, localDateTime, type Caller } from '@cc/domain';
import { findPack } from '@cc/frameworks';
import {
  agendaTemplate,
  applyPreread,
  buildPreread,
  canBuildPreread,
  captureOutput,
  closeMeeting,
  confirmReadBack,
  DEFAULT_ESCALATION_THRESHOLDS,
  ESCALATION_CALLER,
  exportIcs,
  findSection,
  icsSequence,
  isDuePreread,
  itemHistory,
  packSection,
  readBackList,
  RHYTHM_CALLER,
  runEscalation,
  sectionTemplateOf,
  startMeeting,
  type AbsorbedMeeting,
  type AttentionEntry,
  type BuiltPreread,
  type CaptureOutcome,
  type CloseOutcome,
  type EscalationResult,
  type EscalationThresholds,
  type IcsExport,
  type MeetingData,
  type MeetingOutput,
  type PackSection,
  type PrereadInput,
  type ReadBackLine,
  type ReadBackOutcome,
  type ReviewSighting,
  type SectionKey,
} from '@cc/rhythm';
import type {
  ActionItem,
  DomainEvent,
  Decision,
  Evidence,
  Goal,
  MeasureValue,
  MeetingInstance,
  MeetingSeries,
  Workstream,
} from '@cc/schemas';
import { blobPath, type ReadTx, type Store } from '@cc/store';

import type { Clock } from './clock.js';
import { domainContext } from './domain.js';
import { CoreError } from './errors.js';
import type { CommandOutcome, EventOnly, RecordView } from './records.js';
import { StoreRecordStore } from './store-records.js';

export interface MeetingsOptions {
  readonly clock: Clock;
  /** `<userData>/blobs` by default. */
  readonly blobsDir?: string;
  /** The backup state (04 §9.1); undefined until backups exist (P1-17). */
  readonly backupState?: () => PrereadInput['backupState'];
  /** Attention entries from confirmations, sessions, requests and backups (02 §5.7). */
  readonly attention?: () => readonly AttentionEntry[];
}

/** A capture request by refs; the records are read inside the command. */
export type CaptureRequest =
  | Extract<
      MeetingOutput,
      { kind: 'action_item' | 'decision' | 'issue' | 'risk' | 'goal' | 'note' }
    >
  | {
      readonly kind: 'issue_resolution';
      readonly issueRef: string;
      readonly resolution: Extract<MeetingOutput, { kind: 'issue_resolution' }>['resolution'];
    }
  | {
      readonly kind: 'measure_value';
      readonly measureRef: string;
      readonly periodStart: string;
      readonly value?: number | boolean;
      readonly normal?: boolean | null;
      readonly note?: string;
    }
  | { readonly kind: 'goal_grade'; readonly goalRef: string; readonly grade: number }
  | {
      readonly kind: 'status_update';
      readonly ref: string;
      readonly field: 'health' | 'due' | 'lifecycle';
      readonly health?: ActionItem['health'];
      readonly note?: string;
      readonly due?: string;
      readonly reason?: string;
      readonly lifecycle?: 'in_progress' | 'dropped';
    }
  | {
      readonly kind: 'verification';
      readonly ref: string;
      readonly result: 'confirmed' | 'attested' | 'rejected';
      readonly note?: string;
    };

export interface PrereadResult {
  readonly status: 'ok' | 'no-op';
  readonly instance: MeetingInstance;
  readonly notify: boolean;
  readonly markdown: string;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Writes a blob once, atomically; an existing blob is never changed (03 §12 point 1). */
export function writeBlob(blobsDir: string, text: string): string {
  const digest = sha256(text);
  const target = blobPath(blobsDir, digest);
  if (existsSync(target)) return digest;
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, text, { flag: 'w' });
  renameSync(temporary, target);
  return digest;
}

function stripVersion<T>(record: T & { version?: number }): T {
  const copy = { ...record };
  delete copy.version;
  return copy;
}

function findInstance(tx: ReadTx, refOrId: string): MeetingInstance {
  const instance = refOrId.startsWith('mtg_')
    ? tx.get('meeting_instances', refOrId)
    : tx.list('meeting_instances').find((candidate) => candidate.ref === refOrId);
  if (instance === undefined) throw new CoreError('E_NOT_FOUND', `no meeting ${refOrId}`);
  return instance;
}

function seriesOf(tx: ReadTx, instance: MeetingInstance): MeetingSeries {
  const series = tx.get('meeting_series', instance.seriesId);
  if (series === undefined) {
    throw new CoreError(
      'E_INTERNAL',
      `${instance.ref} names a missing series ${instance.seriesId}`,
    );
  }
  return series;
}

/** An item's events, oldest first, read once per command. */
function historian(tx: ReadTx): (itemId: string) => readonly DomainEvent[] {
  const cache = new Map<string, readonly DomainEvent[]>();
  return (itemId) => {
    let events = cache.get(itemId);
    if (events === undefined) {
      events = tx.history('action_item', itemId);
      cache.set(itemId, events);
    }
    return events;
  };
}

/** The workspace's time zone (03 §5.1); UTC before onboarding sets one. */
function workspaceTimeZone(tx: ReadTx): string {
  return tx.list('workspace', { limit: 1 })[0]?.timeZone ?? 'UTC';
}

/**
 * Each workstream's escalation thresholds: its Q-T08 answers from onboarding (01 §8, 02 §7.2),
 * the defaults of `runEscalation` for a workstream onboarding did not tailor. An R5 child, with
 * no tailoring of its own, takes its parent's.
 */
function escalationThresholds(
  tx: ReadTx,
): (workstreamId: string) => EscalationThresholds | undefined {
  const tailoring = tx.list('onboarding', { limit: 1 })[0]?.profile.tailoring ?? [];
  const bySlug = new Map(tailoring.map((entry) => [entry.workstreamKey, entry.escalation]));
  return (workstreamId) => {
    for (
      let id: string | undefined = workstreamId, hops = 0;
      id !== undefined && hops < 8;
      hops += 1
    ) {
      const workstream: Workstream | undefined = tx.get('workstreams', id);
      const found = workstream === undefined ? undefined : bySlug.get(workstream.slug);
      if (found !== undefined) return found;
      id = workstream?.parentId;
    }
    return undefined;
  };
}

/** The health each item had at a review, as an event with no record change (02 §7.2). */
function sightingEvents(sightings: readonly ReviewSighting[]): EventOnly[] {
  return sightings.map((sighting) => ({
    type: 'action_item.reviewed',
    entity: { kind: 'action_item', id: sighting.itemId, ref: sighting.ref },
    after: { health: sighting.health, meetingId: sighting.meetingId },
    actor: ESCALATION_CALLER.actor,
    correlationId: sighting.meetingId,
  }));
}

function byRef<T extends { ref: string }>(records: readonly T[], ref: string, what: string): T {
  const found = records.find((record) => record.ref === ref);
  if (found === undefined) throw new CoreError('E_NOT_FOUND', `no ${what} ${ref}`);
  return found;
}

/** The pack sections of a series: its framework instances' packs (01 §4 `agendaSections`). */
function packSectionsOf(tx: ReadTx, series: MeetingSeries): PackSection[] {
  const out: PackSection[] = [];
  for (const id of series.frameworkInstanceIds) {
    const instance = tx.get('framework_instances', id);
    for (const packId of instance?.packIds ?? []) {
      for (const entry of findPack(packId)?.agendaSections ?? []) {
        if (out.some((existing) => existing.section.id === entry.sectionTemplateId)) continue;
        out.push({ slot: entry.slot, section: packSection(entry.sectionTemplateId) });
      }
    }
  }
  return out;
}

function absorbedOf(tx: ReadTx, instance: MeetingInstance): AbsorbedMeeting[] {
  return instance.absorbedInstanceIds.map((id) => {
    const absorbed = tx.get('meeting_instances', id);
    if (absorbed === undefined) {
      throw new CoreError('E_INTERNAL', `${instance.ref} absorbs a missing instance ${id}`);
    }
    const series = seriesOf(tx, absorbed);
    return {
      instance: absorbed,
      series,
      template: agendaTemplate(series.agendaTemplateId),
      packSections: packSectionsOf(tx, series),
    };
  });
}

/** A row of the week view. */
export interface MeetingListRow {
  readonly ref: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly state: MeetingInstance['state'];
  readonly agendaTemplateId: string;
}

export interface MeetingViewSection {
  readonly sectionId: string;
  readonly workstreamId?: string;
  readonly absorbedFrom?: string;
  readonly title: string;
  readonly type: string;
  readonly timeboxMinutes: number;
  readonly status: 'pending' | 'done' | 'skipped';
  readonly allowedOutputs: readonly string[];
  readonly rows: readonly { ref: string; title: string; flags: readonly string[] }[];
}

/** What the meeting runner shows (`meetings.get`). */
export interface MeetingView {
  readonly meeting: MeetingInstance;
  readonly title: string;
  readonly agendaTemplateId: string;
  readonly timeZone: string;
  readonly workstreams: readonly { id: string; slug: string; name: string }[];
  readonly sections: readonly MeetingViewSection[];
  readonly readBack: readonly {
    kind: 'action_item' | 'decision';
    ref: string;
    owner: string;
    ownerPresent: boolean;
    deliverable: string;
    due?: string;
    doneMeans?: string;
    state: string;
  }[];
}

export interface DismissOutcome {
  readonly status: 'ok' | 'no-op';
  /** The local date of the daily start the entry returns to. */
  readonly until: string;
}

/** The day after a local date. */
function nextDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** The attention entries dismissed in an instance (02 §5.7 rule 2). */
function dismissedEntries(tx: ReadTx, instance: MeetingInstance): Set<string> {
  return new Set(
    tx
      .history('meeting_instance', instance.id)
      .filter((event) => event.type === 'meeting_instance.attention_dismissed')
      .map((event) => (event.after as { entry?: string } | undefined)?.entry)
      .filter((entry): entry is string => entry !== undefined),
  );
}

/** A display title for a ref an agenda input found: the record's title, or the ref itself. */
function titler(tx: ReadTx): (ref: string) => string {
  const zone = workspaceTimeZone(tx);
  return (ref) => {
    const find = <T extends { ref: string }>(rows: readonly T[]) =>
      rows.find((row) => row.ref === ref);
    switch (ref.charAt(0)) {
      case 'A':
        return find(tx.list('action_items'))?.title ?? ref;
      case 'D':
        return find(tx.list('decisions'))?.question ?? ref;
      case 'I':
        return find(tx.list('issues'))?.title ?? ref;
      case 'R':
        return find(tx.list('risks'))?.description ?? ref;
      case 'G':
        return find(tx.list('goals'))?.title ?? ref;
      case 'K':
        return find(tx.list('measures'))?.name ?? ref;
      case 'M': {
        const instance = find(tx.list('meeting_instances'));
        if (instance === undefined) return ref;
        const name = tx.get('meeting_series', instance.seriesId)?.name ?? instance.seriesId;
        return `${name} at ${localDateTime(instance.scheduledStart, zone).slice(11, 16)}`;
      }
      default:
        return ref.startsWith('dst:') ? 'US daylight-saving change: check meeting times' : ref;
    }
  };
}

export class Meetings {
  readonly #store: Store;
  readonly #records: StoreRecordStore;
  readonly #options: MeetingsOptions;
  readonly #blobsDir: string;

  constructor(store: Store, options: MeetingsOptions) {
    this.#store = store;
    this.#records = new StoreRecordStore(store);
    this.#options = options;
    this.#blobsDir = options.blobsDir ?? store.blobsDir;
  }

  /** Everything the inputs resolve against, in the command's snapshot (02 §6.1). */
  #data(tx: ReadTx): MeetingData {
    const attention = this.#options.attention?.();
    return {
      workspaceTimeZone: workspaceTimeZone(tx),
      workstreams: tx.list('workstreams'),
      actionItems: tx.list('action_items'),
      evidence: tx.list('evidence').map((e) => stripVersion<Evidence>(e)),
      measures: tx.list('measures'),
      measureValues: tx.list('measure_values').map((v) => stripVersion<MeasureValue>(v)),
      goals: tx.list('goals'),
      decisions: tx.list('decisions'),
      issues: tx.list('issues'),
      risks: tx.list('risks'),
      series: tx.list('meeting_series'),
      instances: tx.list('meeting_instances'),
      ...(attention === undefined ? {} : { attention }),
    };
  }

  #build(tx: ReadTx, series: MeetingSeries, instance: MeetingInstance, now: string): BuiltPreread {
    const backupState = this.#options.backupState?.();
    const built = buildPreread({
      series,
      instance,
      template: agendaTemplate(series.agendaTemplateId),
      packSections: packSectionsOf(tx, series),
      absorbed: absorbedOf(tx, instance),
      data: this.#data(tx),
      ...(backupState === undefined ? {} : { backupState }),
      now,
      sha256,
    });
    writeBlob(this.#blobsDir, built.json);
    writeBlob(this.#blobsDir, built.markdown);
    return built;
  }

  #prepareIn(view: RecordView, caller: Caller, ref: string) {
    const ctx = domainContext(view, this.#options.clock);
    const instance = findInstance(view.tx, ref);
    const series = seriesOf(view.tx, instance);
    const built = this.#build(view.tx, series, instance, ctx.clock.now());
    const outcome = applyPreread(ctx, caller, series, instance, built);
    return { outcome, built };
  }

  /** Builds or rebuilds an instance's pre-read (02 §6.2); the user or the rhythm engine. */
  prepare(caller: Caller, ref: string): PrereadResult {
    return this.#records.command(caller.actor, (view) => {
      const { outcome, built } = this.#prepareIn(view, caller, ref);
      return {
        result: {
          status: outcome.status,
          instance: outcome.record,
          notify: outcome.notify,
          markdown: built.markdown,
        },
        changes: outcome.changes,
      };
    });
  }

  /**
   * The scheduled job (02 §4.7): builds the pre-read of every instance whose time has come, each
   * in its own command. Returns the instances prepared and those to notify about once.
   */
  runPrereads(): { prepared: string[]; notify: string[] } {
    const now = this.#options.clock.now().toISOString();
    const due = this.#store.read((tx) => {
      const series = new Map(tx.list('meeting_series').map((s) => [s.id as string, s]));
      return tx
        .list('meeting_instances')
        .filter((instance) => {
          const owner = series.get(instance.seriesId);
          return owner !== undefined && isDuePreread(owner, instance, now);
        })
        .map((instance) => instance.ref);
    });
    const prepared: string[] = [];
    const notify: string[] = [];
    for (const ref of due) {
      const result = this.prepare(RHYTHM_CALLER, ref);
      if (result.status === 'ok') prepared.push(ref);
      if (result.notify) notify.push(ref);
    }
    return { prepared, notify };
  }

  /**
   * "Start" (02 §4.7): the user only. An instance started before its pre-read time gets its
   * pre-read built first, in the same transaction, so the agenda it runs is the snapshot.
   */
  start(caller: Caller, ref: string): MeetingInstance {
    return this.#records.command(caller.actor, (view) => {
      const ctx = domainContext(view, this.#options.clock);
      let instance = findInstance(view.tx, ref);
      const series = seriesOf(view.tx, instance);
      const changes = [];
      if (instance.preread === undefined && canBuildPreread(series, instance)) {
        const built = this.#build(view.tx, series, instance, ctx.clock.now());
        const prepared = applyPreread(ctx, caller, series, instance, built);
        changes.push(...prepared.changes);
        instance = prepared.record;
      }
      const started = startMeeting(ctx, caller, instance);
      changes.push(...started.changes);
      return { result: started.record, changes };
    });
  }

  /** Captures one output into a section of a meeting in progress (02 §6.3). */
  capture(
    caller: Caller,
    ref: string,
    section: SectionKey,
    request: CaptureRequest,
  ): CaptureOutcome {
    return this.#records.command(caller.actor, (view) => {
      const ctx = domainContext(view, this.#options.clock);
      const { tx } = view;
      const instance = findInstance(tx, ref);
      const series = seriesOf(tx, instance);
      const row = findSection(instance, section);
      const absorbed = absorbedOf(tx, instance);
      const template = sectionTemplateOf(
        row,
        {
          template: agendaTemplate(series.agendaTemplateId),
          packSections: packSectionsOf(tx, series),
        },
        absorbed.map((meeting) => ({
          instanceId: meeting.instance.id,
          template: meeting.template,
          ...(meeting.packSections === undefined ? {} : { packSections: meeting.packSections }),
        })),
      );
      const owner = absorbed.find((meeting) => meeting.instance.id === row.absorbedFrom)?.series;
      const output = this.#output(tx, request, view);
      const outcome = captureOutput(
        ctx,
        caller,
        {
          series,
          instance,
          section,
          template,
          workstreamIds: (owner ?? series).workstreamIds,
        },
        output,
      );
      return { result: outcome, changes: outcome.changes };
    });
  }

  #output(tx: ReadTx, request: CaptureRequest, view: RecordView): MeetingOutput {
    switch (request.kind) {
      case 'issue_resolution':
        return {
          kind: 'issue_resolution',
          issue: byRef(tx.list('issues'), request.issueRef, 'issue'),
          resolution: request.resolution,
        };
      case 'measure_value': {
        const measure = byRef(tx.list('measures'), request.measureRef, 'measure');
        const existing = tx
          .list('measure_values')
          .find((v) => v.measureId === measure.id && v.periodStart === request.periodStart);
        return {
          kind: 'measure_value',
          measure,
          ...(existing === undefined ? {} : { existing: stripVersion<MeasureValue>(existing) }),
          periodStart: request.periodStart,
          ...(request.value === undefined ? {} : { value: request.value }),
          ...(request.normal === undefined ? {} : { normal: request.normal }),
          ...(request.note === undefined ? {} : { note: request.note }),
        };
      }
      case 'goal_grade': {
        const goal: Goal = byRef(tx.list('goals'), request.goalRef, 'goal');
        const framework = tx.get('framework_instances', goal.frameworkInstanceId);
        if (framework === undefined) {
          throw new CoreError('E_INTERNAL', `${goal.ref} names a missing framework instance`);
        }
        return { kind: 'goal_grade', goal, goalModel: framework.goalModel, grade: request.grade };
      }
      case 'status_update': {
        const { ref, kind: _kind, ...rest } = request;
        void _kind;
        if (ref.startsWith('G-')) {
          return { kind: 'status_update', goal: byRef(tx.list('goals'), ref, 'goal'), ...rest };
        }
        const item = view.item(ref);
        if (item === undefined) throw new CoreError('E_NOT_FOUND', `no item ${ref}`);
        return { kind: 'status_update', item, ...rest };
      }
      case 'verification': {
        const item = view.item(request.ref);
        if (item === undefined) throw new CoreError('E_NOT_FOUND', `no item ${request.ref}`);
        return {
          kind: 'verification',
          item,
          result: request.result,
          evidence: view.evidenceOf(item.id),
          ...(request.note === undefined ? {} : { note: request.note }),
        };
      }
      default:
        return request;
    }
  }

  #outcomeRecords(
    tx: ReadTx,
    instance: MeetingInstance,
  ): { items: ActionItem[]; decisions: Decision[] } {
    const itemIds = new Set<string>([
      ...instance.outputs.actionItemIds,
      ...instance.outputs.verifications.map((v) => v.actionItemId),
    ]);
    const droppedRefs = new Set(
      instance.outputs.statusUpdates.filter((u) => u.to === 'dropped').map((u) => u.ref),
    );
    const decisionIds = new Set<string>(instance.outputs.decisionIds);
    return {
      items: tx
        .list('action_items')
        .filter((item) => itemIds.has(item.id) || droppedRefs.has(item.ref)),
      decisions: tx.list('decisions').filter((decision) => decisionIds.has(decision.id)),
    };
  }

  /** The conclude section's list (02 §6.4 rule 1). */
  readBack(ref: string): ReadBackLine[] {
    return this.#records.read((view) => {
      const instance = findInstance(view.tx, ref);
      return readBackList({
        series: seriesOf(view.tx, instance),
        instance,
        selfPersonId: view.selfPersonId,
        ...this.#outcomeRecords(view.tx, instance),
      });
    });
  }

  /** "Read back done" (02 §6.4 rule 1); human-only. */
  confirmReadBack(
    caller: Caller,
    ref: string,
    acceptances: readonly { ref: string; note: string }[] = [],
  ): ReadBackOutcome {
    return this.#records.command(caller.actor, (view) => {
      const ctx = domainContext(view, this.#options.clock);
      const instance = findInstance(view.tx, ref);
      const outcome = confirmReadBack(ctx, caller, {
        series: seriesOf(view.tx, instance),
        instance,
        ...this.#outcomeRecords(view.tx, instance),
        acceptances,
      });
      return { result: outcome, changes: outcome.changes };
    });
  }

  /**
   * Close (02 §6.4 rule 3, §4.7): C-02-04, then `completed`, the carry counts of the items
   * this review counts (02 §7.1, once per item and instance, C-02-05) and the escalation job
   * (02 §7.2), in one transaction. The health each item had at the review is recorded as an
   * `action_item.reviewed` event, for the next review's "two consecutive" check.
   */
  close(caller: Caller, ref: string): CloseOutcome {
    return this.#records.command(caller.actor, (view) => {
      const { tx } = view;
      const ctx = domainContext(view, this.#options.clock);
      const instance = findInstance(tx, ref);
      const history = historian(tx);
      const outcome = closeMeeting(ctx, caller, {
        instance,
        ...this.#outcomeRecords(tx, instance),
        review: {
          series: seriesOf(tx, instance),
          items: tx.list('action_items'),
          goals: tx.list('goals'),
          issues: tx.list('issues').filter((issue) => issue.status === 'open'),
          workspaceTimeZone: workspaceTimeZone(tx),
          thresholds: (workstreamId) =>
            escalationThresholds(tx)(workstreamId) ?? DEFAULT_ESCALATION_THRESHOLDS,
          counted: (itemId) =>
            history(itemId).some(
              (event) =>
                event.type === 'action_item.carried' &&
                (event.after as { meetingId?: string } | undefined)?.meetingId === instance.id,
            ),
          history: (item) => itemHistory(history(item.id)),
        },
      });
      return {
        result: outcome,
        changes: outcome.changes,
        events: sightingEvents(outcome.escalation?.reviewed ?? []),
      };
    });
  }

  /**
   * The week view (09 P1-11): the instances whose local start date, in the workspace's time
   * zone, falls between `from` and `to` inclusive, earliest first, with their series' names.
   */
  list(from: string, to: string): { timeZone: string; meetings: MeetingListRow[] } {
    return this.#store.read((tx) => {
      const zone = workspaceTimeZone(tx);
      const series = new Map(tx.list('meeting_series').map((s) => [s.id as string, s]));
      const meetings = tx
        .list('meeting_instances')
        .filter((instance) => {
          const date = localDate(instance.scheduledStart, zone);
          return from <= date && date <= to;
        })
        .sort(
          (a, b) => a.scheduledStart.localeCompare(b.scheduledStart) || a.ref.localeCompare(b.ref),
        )
        .map((instance) => {
          const owner = series.get(instance.seriesId);
          return {
            ref: instance.ref,
            title: owner?.name ?? instance.seriesId,
            start: instance.scheduledStart,
            end: instance.scheduledEnd,
            state: instance.state,
            agendaTemplateId: owner?.agendaTemplateId ?? 'unknown',
          };
        });
      return { timeZone: zone, meetings };
    });
  }

  /**
   * One meeting as the runner shows it (02 §6, 09 P1-11): its agenda rows with their section
   * titles, types, timeboxes and allowed outputs, the rows each section's inputs found in the
   * pre-read snapshot, and the read-back list. Attention entries dismissed in this instance
   * are left out until tomorrow's daily start (02 §5.7 rule 2, owner decision Q6).
   */
  view(ref: string): MeetingView {
    return this.#records.read((view) => {
      const { tx } = view;
      const instance = findInstance(tx, ref);
      const series = seriesOf(tx, instance);
      const own = {
        template: agendaTemplate(series.agendaTemplateId),
        packSections: packSectionsOf(tx, series),
      };
      const absorbed = absorbedOf(tx, instance).map((meeting) => ({
        instanceId: meeting.instance.id,
        template: meeting.template,
        ...(meeting.packSections === undefined ? {} : { packSections: meeting.packSections }),
      }));
      const dismissed = dismissedEntries(tx, instance);
      const title = titler(tx);
      const sections = instance.agenda.map((row): MeetingViewSection => {
        const template = sectionTemplateOf(row, own, absorbed);
        const seen = new Set<string>();
        const rows = row.inputResults.flatMap((result) =>
          result.itemRefs
            .filter((rowRef) => {
              if (seen.has(rowRef)) return false;
              seen.add(rowRef);
              return !(template.type === 'attention' && dismissed.has(rowRef));
            })
            .map((rowRef) => ({ ref: rowRef, title: title(rowRef), flags: [...result.flags] })),
        );
        return {
          sectionId: row.sectionId,
          ...(row.workstreamId === undefined ? {} : { workstreamId: row.workstreamId }),
          ...(row.absorbedFrom === undefined ? {} : { absorbedFrom: row.absorbedFrom }),
          title: template.title,
          type: template.type,
          timeboxMinutes: row.timeboxMinutes,
          status: row.status,
          allowedOutputs: [...template.allowedOutputs],
          rows,
        };
      });
      const readBack = readBackList({
        series,
        instance,
        selfPersonId: view.selfPersonId,
        ...this.#outcomeRecords(tx, instance),
      }).map((line) => ({
        kind: line.kind,
        ref: line.ref,
        owner:
          line.ownerId === view.selfPersonId
            ? 'self'
            : (view.person(line.ownerId)?.displayName ?? line.ownerId),
        ownerPresent: line.ownerPresent,
        deliverable: line.deliverable,
        ...(line.due === undefined ? {} : { due: line.due }),
        ...(line.doneMeans === undefined ? {} : { doneMeans: line.doneMeans }),
        state: line.state,
      }));
      return {
        meeting: instance,
        title: series.name,
        agendaTemplateId: series.agendaTemplateId,
        timeZone: workspaceTimeZone(tx),
        workstreams: series.workstreamIds.flatMap((id) => {
          const workstream: Workstream | undefined = tx.get('workstreams', id);
          return workstream === undefined
            ? []
            : [{ id: workstream.id, slug: workstream.slug, name: workstream.name }];
        }),
        sections,
        readBack,
      };
    });
  }

  /**
   * Dismisses an attention entry of a daily start (02 §5.7 rule 2, owner decision Q6): it is
   * snoozed to tomorrow's daily start, not resolved, so an entry whose cause remains returns the
   * next day. Recorded as one `meeting_instance.attention_dismissed` event; the user only.
   */
  dismiss(caller: Caller, ref: string, entry: string): DismissOutcome {
    if (!isUser(caller)) {
      throw forbidden('02 §5.7', 'only the user dismisses an attention entry');
    }
    return this.#records.command(caller.actor, (view): CommandOutcome<DismissOutcome> => {
      const { tx } = view;
      const instance = findInstance(tx, ref);
      const series = seriesOf(tx, instance);
      const template = agendaTemplate(series.agendaTemplateId);
      const attentionIds = new Set(
        template.sections.filter((s) => s.type === 'attention').map((s) => s.id),
      );
      const listed = instance.agenda
        .filter((row) => attentionIds.has(row.sectionId))
        .some((row) => row.inputResults.some((result) => result.itemRefs.includes(entry)));
      if (!listed) {
        throw new CoreError('E_NOT_FOUND', `${instance.ref} lists no attention entry ${entry}`, [
          "Dismiss an entry of the daily start's attention list",
        ]);
      }
      const zone = workspaceTimeZone(tx);
      const today = localDate(instance.scheduledStart, zone);
      const until = nextDate(today);
      if (dismissedEntries(tx, instance).has(entry)) {
        return { result: { status: 'no-op' as const, until }, changes: [] };
      }
      return {
        result: { status: 'ok' as const, until },
        changes: [],
        events: [
          {
            type: 'meeting_instance.attention_dismissed',
            entity: { kind: 'meeting_instance', id: instance.id, ref: instance.ref },
            after: { entry, until },
            actor: caller.actor,
            correlationId: instance.id,
          },
        ],
      };
    });
  }

  /**
   * The nightly escalation run (02 §7.2 rule 1), actor `system:escalation`, in one
   * transaction. Returns the level changes, E2 issues, E0 reminders and nudge drafts, and the
   * items to notify about (E1 and above, once per item per day; delivery is the desktop's).
   */
  escalate(): EscalationResult {
    return this.#records.command(ESCALATION_CALLER.actor, (view) => {
      const { tx } = view;
      const ctx = domainContext(view, this.#options.clock);
      const history = historian(tx);
      const thresholdsOf = escalationThresholds(tx);
      const result = runEscalation(ctx, ESCALATION_CALLER, {
        items: tx.list('action_items'),
        goals: tx.list('goals'),
        issues: tx.list('issues').filter((issue) => issue.status === 'open'),
        workspaceTimeZone: workspaceTimeZone(tx),
        thresholds: (workstreamId) => thresholdsOf(workstreamId) ?? DEFAULT_ESCALATION_THRESHOLDS,
        history: (item) => itemHistory(history(item.id)),
      });
      return { result, changes: result.changes };
    });
  }

  /**
   * The .ics export (02 §9.1; `cc-axi meetings export-ics --weeks <n>`): `weeks` weeks of every
   * series with no calendar binding, from the start of today. Each instance's `SEQUENCE` is
   * read from its events, and the exported `planned` instances become `scheduled`, in one
   * transaction. The caller writes `ics` to the file.
   */
  exportIcs(weeks: number): IcsExport {
    return this.#records.command(RHYTHM_CALLER.actor, (view) => {
      const { tx } = view;
      const ctx = domainContext(view, this.#options.clock);
      const exported = exportIcs(ctx, RHYTHM_CALLER, {
        series: tx.list('meeting_series'),
        instances: tx.list('meeting_instances'),
        weeks,
        workspaceTimeZone: workspaceTimeZone(tx),
        sequenceOf: (instance) => icsSequence(tx.history('meeting_instance', instance.id)),
      });
      return { result: exported, changes: exported.changes };
    });
  }
}
