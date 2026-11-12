/**
 * Output capture and validation (02 §6.3). Outputs are captured into an `in_progress` instance,
 * in one agenda section, as one of the kinds that section allows (02 §3 `allowedOutputs`). Each
 * output is created or changed through the @cc/domain command for its record, so the invariants
 * of 03 §6 hold, and carries `source = { kind: 'meeting', meetingId, sectionId }`. The instance
 * records it in `outputs` (or `notes`), with one event per write (INV-03-09).
 *
 * | Output | Validation at capture |
 * |---|---|
 * | action_item | INV-03-04 even as a draft: one owner, a due date, a done-means, at least one required evidence requirement (prefilled when none is given). Always `draft`, accepted at read-back (02 §6.4). |
 * | decision | One decider who is a person (INV-03-02); reversibility set explicitly; a one-way door needs a memo, or a waiver note when memos are off (03 §10 rule 3). The user may decide it on the spot. |
 * | issue resolution | Links a decision or action item, or is dropped with a note (E-6, INV-03-11). |
 * | verification | The user only (INV-03-07). |
 * | measure_value | Unit and period match the measure; manual values record the actor. |
 * | goal_grade | rocks: 0 or 1; okr: 0.0 to 1.0; wig: the lag value at `target.by`. |
 *
 * Readings where 02 §6.3 is silent:
 * - Agents (`meetings:capture`, 07 §5 "add draft outputs") capture drafts only: action items
 *   (draft), decisions (proposed) and notes; the scope stands in for `items:write` and
 *   `decisions:propose` for those. Every other output changes a record and is the user's.
 * - A new action item or decision after read-back clears `readBackConfirmedAt`: read-back covers
 *   every new item, so it is done again (C-02-04).
 * - 02 §5.1 rules: a not-normal scorecard line with no explanation creates a draft follow-up for
 *   the measure's owner, due 7 days after the meeting's local date (the default todo horizon,
 *   eos-lite E-4), and the value notes the follow-up; an at-risk or off-track priority raises an
 *   issue from the meeting (issues have no draft state, 03 §5.6).
 */
import {
  attestItem,
  type Caller,
  type Change,
  change,
  checkGoal,
  checkMeasureValue,
  confirmItem,
  created,
  createActionItem,
  decide,
  DomainError,
  type DomainContext,
  dropItem,
  forbidden,
  hasScope,
  invariantError,
  isUser,
  type IssueResolution,
  type NewActionItem,
  oneWayDoorViolations,
  omitKeys,
  openDecision,
  proposeDecision,
  raiseIssue,
  recordRisk,
  rejectClaim,
  replanItem,
  resolveIssue,
  setItemHealth,
  startItem,
  touched,
  assertNoViolations,
} from '@cc/domain';
import type {
  ActionItem,
  AgendaSectionInstance,
  AgendaSectionTemplate,
  AgendaTemplate,
  Decision,
  Evidence,
  EvidenceRequirement,
  Goal,
  GoalModel,
  Issue,
  ItemSource,
  Measure,
  MeasureValue,
  MeetingInstance,
  MeetingSeries,
  OutputKind,
  Risk,
} from '@cc/schemas';

import type { PackSection } from './preread.js';
import { instanceChange } from './state.js';
import { addDays, localDate } from './time.js';
import { periodStartOf } from './inputs.js';

type WorkstreamId = MeetingSeries['workstreamIds'][number];

/** Which agenda row an output belongs to. */
export interface SectionKey {
  readonly sectionId: string;
  readonly workstreamId?: string;
  readonly absorbedFrom?: string;
}

export function sameSection(row: AgendaSectionInstance, key: SectionKey): boolean {
  return (
    row.sectionId === key.sectionId &&
    row.workstreamId === key.workstreamId &&
    row.absorbedFrom === key.absorbedFrom
  );
}

/** The agenda row of an instance, or `E_NOT_FOUND`. */
export function findSection(instance: MeetingInstance, key: SectionKey): AgendaSectionInstance {
  const row = instance.agenda.find((candidate) => sameSection(candidate, key));
  if (row === undefined) {
    const where = [key.workstreamId, key.absorbedFrom].filter(Boolean).join(', ');
    throw new DomainError(
      'E_NOT_FOUND',
      '02 §6.3',
      `${instance.ref} has no section ${key.sectionId}${where === '' ? '' : ` (${where})`}`,
    );
  }
  return row;
}

/**
 * The section template of an agenda row: from the absorbed meeting's template when the row was
 * absorbed (02 §4.3), else from the series' template, pack sections included.
 */
export function sectionTemplateOf(
  row: AgendaSectionInstance,
  own: { readonly template: AgendaTemplate; readonly packSections?: readonly PackSection[] },
  absorbed: readonly {
    readonly instanceId: string;
    readonly template: AgendaTemplate;
    readonly packSections?: readonly PackSection[];
  }[] = [],
): AgendaSectionTemplate {
  const source =
    row.absorbedFrom === undefined
      ? own
      : absorbed.find((meeting) => meeting.instanceId === row.absorbedFrom);
  const sections = [
    ...(source?.template.sections ?? []),
    ...(source?.packSections ?? []).map((pack) => pack.section),
  ];
  const found = sections.find((section) => section.id === row.sectionId);
  if (found === undefined) {
    throw new DomainError('E_NOT_FOUND', '02 §5', `no section template ${row.sectionId}`);
  }
  return found;
}

export interface CaptureTarget {
  readonly series: MeetingSeries;
  readonly instance: MeetingInstance;
  readonly section: SectionKey;
  readonly template: AgendaSectionTemplate;
  /** The workstreams of the section's meeting: the absorbed series' for an absorbed row. */
  readonly workstreamIds: readonly WorkstreamId[];
}

type NewItemInput = Omit<NewActionItem, 'source' | 'lifecycle' | 'workstreamId'> & {
  readonly workstreamId?: WorkstreamId;
};

export type MeetingOutput =
  | { readonly kind: 'action_item'; readonly item: NewItemInput }
  | {
      readonly kind: 'decision';
      readonly workstreamId?: WorkstreamId;
      readonly question: string;
      readonly options?: readonly string[];
      readonly deciderId?: Decision['deciderId'];
      readonly reversibility: Decision['reversibility'];
      readonly memoSha256?: Decision['memoSha256'];
      /** Framework parameter `decision.memoForOneWayDoors` (01 §5.2), default true. */
      readonly memoForOneWayDoors?: boolean;
      readonly waiverNote?: string;
      readonly informIds?: Decision['informIds'];
      readonly dueBy?: string;
      /** Decided on the spot, by the user only. */
      readonly outcome?: {
        readonly optionId?: string;
        readonly text: string;
        readonly why: string;
        readonly actionItems?: readonly Omit<
          NewActionItem,
          'source' | 'lifecycle' | 'workstreamId'
        >[];
      };
    }
  | {
      readonly kind: 'issue';
      readonly workstreamId?: WorkstreamId;
      readonly title: string;
      readonly rank?: number;
    }
  | {
      readonly kind: 'issue_resolution';
      readonly issue: Issue;
      readonly resolution: IssueResolution;
    }
  | {
      readonly kind: 'risk';
      readonly workstreamId?: WorkstreamId;
      readonly description: string;
      readonly trigger: string;
      readonly watcherId?: Risk['watcherId'];
    }
  | {
      readonly kind: 'measure_value';
      readonly measure: Measure;
      /** The value already recorded for this period, if any. */
      readonly existing?: MeasureValue;
      readonly id?: string;
      readonly periodStart: string;
      readonly value?: number | boolean;
      /** The scorecard reading: normal, not normal, or not yet read. */
      readonly normal?: boolean | null;
      readonly note?: string;
    }
  | {
      readonly kind: 'goal';
      readonly goal: Omit<
        Goal,
        | 'id'
        | 'ref'
        | 'status'
        | 'health'
        | 'createdAt'
        | 'createdBy'
        | 'updatedAt'
        | 'updatedBy'
        | 'version'
      >;
    }
  | {
      readonly kind: 'goal_grade';
      readonly goal: Goal;
      readonly goalModel: GoalModel;
      readonly grade: number;
    }
  | {
      readonly kind: 'status_update';
      readonly item?: ActionItem;
      readonly goal?: Goal;
      readonly field: 'health' | 'due' | 'lifecycle';
      readonly health?: ActionItem['health'];
      readonly note?: string;
      readonly due?: string;
      readonly reason?: string;
      readonly lifecycle?: 'in_progress' | 'dropped';
    }
  | {
      readonly kind: 'verification';
      readonly item: ActionItem;
      readonly result: 'confirmed' | 'attested' | 'rejected';
      readonly evidence?: readonly Evidence[];
      /** The attestation note, or the rejection reason. */
      readonly note?: string;
    }
  | { readonly kind: 'note'; readonly text: string };

/** A measure has one value per period (03 §5.4), so a new value's ID names both. */
export function measureValueId(measure: Pick<Measure, 'id'>, periodStart: string): string {
  return `mv_${measure.id.slice(4)}_${periodStart.replace(/-/g, '')}`;
}

/** The `OutputKind` an output counts as for `allowedOutputs`. */
export function outputKindOf(output: MeetingOutput): OutputKind {
  return output.kind === 'issue_resolution' ? 'issue' : output.kind;
}

const AGENT_KINDS: ReadonlySet<MeetingOutput['kind']> = new Set([
  'action_item',
  'decision',
  'note',
]);

/** The evidence requirement prefilled when an item captured in a meeting names none. */
export function defaultRequirement(doneMeans: string): EvidenceRequirement {
  return {
    id: 'er1',
    description: `Shows: ${doneMeans}`.slice(0, 200),
    required: true,
    acceptedKinds: ['url', 'file', 'connector_record', 'note'],
  };
}

export interface CaptureOutcome {
  readonly status: 'ok' | 'no-op';
  readonly instance: MeetingInstance;
  /** The main record the output created or changed. */
  readonly record?: unknown;
  readonly changes: readonly Change[];
}

function requireCapturable(
  ctx: DomainContext,
  caller: Caller,
  target: CaptureTarget,
  output: MeetingOutput,
): void {
  const { instance } = target;
  if (instance.state !== 'in_progress') {
    throw invariantError({
      rule: '02 §6.3',
      message: `${instance.ref} is ${instance.state}; outputs are captured into a meeting in progress`,
    });
  }
  if (caller.actor.kind === 'agent') {
    if (!hasScope(caller, 'meetings:capture')) {
      throw forbidden('02 §4.2', 'capturing meeting outputs needs the meetings:capture scope');
    }
    if (!AGENT_KINDS.has(output.kind)) {
      throw forbidden('02 §6.3', `agents capture drafts only; ${output.kind} is the user's`);
    }
  } else if (!isUser(caller)) {
    throw forbidden('02 §6.3', 'only the user and agents with meetings:capture capture outputs');
  }
  const kind = outputKindOf(output);
  if (!target.template.allowedOutputs.includes(kind)) {
    throw invariantError({
      rule: '02 §5',
      message: `${target.template.title} (${target.section.sectionId}) does not take ${kind} outputs; it takes ${target.template.allowedOutputs.join(', ')}`,
    });
  }
  findSection(instance, target.section);
  void ctx;
}

/** The workstream an output lands in: given, the section's own, or the only one. */
function workstreamOf(target: CaptureTarget, given: WorkstreamId | undefined): WorkstreamId {
  const own = target.section.workstreamId as WorkstreamId | undefined;
  const chosen =
    given ?? own ?? (target.workstreamIds.length === 1 ? target.workstreamIds[0] : undefined);
  if (chosen === undefined) {
    throw new DomainError(
      'E_USAGE',
      '02 §4.4',
      'this section covers several workstreams; name the workstream of the output',
      [`one of ${target.workstreamIds.join(', ')}`],
    );
  }
  if (!target.workstreamIds.includes(chosen)) {
    throw invariantError({
      rule: '02 §4.4',
      message: `${chosen} is not a workstream of this meeting (${target.workstreamIds.join(', ')})`,
    });
  }
  return chosen;
}

function meetingSource(target: CaptureTarget): Extract<ItemSource, { kind: 'meeting' }> {
  return { kind: 'meeting', meetingId: target.instance.id, sectionId: target.section.sectionId };
}

/** Agents capture drafts under `meetings:capture` (07 §5); see the module comment. */
function draftCaller(caller: Caller): Caller {
  return caller.actor.kind === 'agent'
    ? {
        actor: caller.actor,
        scopes: [...(caller.scopes ?? []), 'items:write', 'decisions:propose'],
      }
    : caller;
}

type Outputs = MeetingInstance['outputs'];

function withOutputs(
  instance: MeetingInstance,
  add: Partial<{ [K in keyof Outputs]: Outputs[K] }>,
  newCommitment: boolean,
): MeetingInstance {
  const outputs: Outputs = { ...instance.outputs };
  for (const key of Object.keys(add) as (keyof Outputs)[]) {
    const extra = add[key] as unknown[];
    const merged = [...(outputs[key] as unknown[])];
    for (const value of extra) {
      if (!merged.some((existing) => JSON.stringify(existing) === JSON.stringify(value))) {
        merged.push(value);
      }
    }
    (outputs as Record<string, unknown>)[key] = merged;
  }
  const base = newCommitment ? omitKeys(instance, 'readBackConfirmedAt') : instance;
  return { ...base, outputs };
}

function finish(
  ctx: DomainContext,
  caller: Caller,
  target: CaptureTarget,
  next: MeetingInstance,
  output: MeetingOutput,
  changes: readonly Change[],
  record: { readonly id?: string; readonly ref?: string } | undefined,
): CaptureOutcome {
  const before = target.instance;
  const touchedInstance = { ...touched(ctx, next, caller.actor) };
  const write = instanceChange(ctx, caller, before, touchedInstance, 'output_captured', {
    output: outputKindOf(output),
    sectionId: target.section.sectionId,
    ...(record?.ref === undefined ? {} : { ref: record.ref }),
  });
  return { status: 'ok', instance: touchedInstance, record, changes: [...changes, write] };
}

function captureActionItem(
  ctx: DomainContext,
  caller: Caller,
  target: CaptureTarget,
  output: Extract<MeetingOutput, { kind: 'action_item' }>,
): CaptureOutcome {
  const { item } = output;
  const problems: string[] = [];
  if (item.title.trim() === '') problems.push('a title');
  if (item.doneMeans.trim() === '') problems.push('a done-means');
  if (item.due.date.trim() === '') problems.push('a due date');
  if (problems.length > 0) {
    throw invariantError({
      rule: 'INV-03-04',
      message: `an action item captured in a meeting needs ${problems.join(', ')}`,
    });
  }
  const requirements =
    item.evidenceRequirements === undefined || item.evidenceRequirements.length === 0
      ? [defaultRequirement(item.doneMeans)]
      : item.evidenceRequirements;
  if (!requirements.some((r) => r.required)) {
    throw invariantError({
      rule: 'INV-03-04',
      message:
        'an action item captured in a meeting needs at least one required evidence requirement',
    });
  }
  const workstreamId = workstreamOf(target, item.workstreamId);
  const outcome = createActionItem(ctx, draftCaller(caller), {
    ...item,
    workstreamId,
    evidenceRequirements: requirements,
    source: meetingSource(target),
    lifecycle: 'draft',
    correlationId: target.instance.id,
  });
  const next = withOutputs(target.instance, { actionItemIds: [outcome.record.id] }, true);
  return finish(ctx, caller, target, next, output, outcome.changes, outcome.record);
}

function captureDecision(
  ctx: DomainContext,
  caller: Caller,
  target: CaptureTarget,
  output: Extract<MeetingOutput, { kind: 'decision' }>,
): CaptureOutcome {
  const deciderId = output.deciderId ?? ctx.registry.selfPersonId;
  if (ctx.registry.person(deciderId) === undefined) {
    throw invariantError({
      rule: 'INV-03-02',
      message: `decider ${deciderId} is not a person in this workspace`,
    });
  }
  const memoForOneWayDoors = output.memoForOneWayDoors ?? true;
  const draft = { reversibility: output.reversibility, memoSha256: output.memoSha256 } as Decision;
  assertNoViolations(oneWayDoorViolations(draft, { memoForOneWayDoors }, output.waiverNote));
  if (output.outcome !== undefined && !isUser(caller)) {
    throw forbidden('INV-03-02', 'only the user decides; agents propose');
  }
  const workstreamId = workstreamOf(target, output.workstreamId);
  const proposed = proposeDecision(ctx, draftCaller(caller), {
    workstreamId,
    question: output.question,
    ...(output.options === undefined ? {} : { options: output.options }),
    deciderId,
    reversibility: output.reversibility,
    ...(output.informIds === undefined ? {} : { informIds: output.informIds }),
    ...(output.dueBy === undefined ? {} : { dueBy: output.dueBy }),
    ...(output.memoSha256 === undefined ? {} : { memoSha256: output.memoSha256 }),
    source: meetingSource(target),
  });
  const changes: Change[] = [...proposed.changes];
  let decision = proposed.record;
  if (isUser(caller)) {
    const opened = openDecision(ctx, caller, decision);
    decision = opened.record;
    changes.push(...opened.changes);
    if (output.outcome !== undefined) {
      const decided = decide(ctx, caller, decision, {
        ...(output.outcome.optionId === undefined ? {} : { optionId: output.outcome.optionId }),
        text: output.outcome.text,
        why: output.outcome.why,
        memoForOneWayDoors,
        ...(output.waiverNote === undefined ? {} : { waiverNote: output.waiverNote }),
        ...(output.outcome.actionItems === undefined
          ? {}
          : { actionItems: output.outcome.actionItems }),
      });
      decision = decided.record;
      changes.push(...decided.changes);
    }
  }
  const next = withOutputs(
    target.instance,
    { decisionIds: [decision.id], actionItemIds: [...decision.actionItemIds] },
    true,
  );
  return finish(ctx, caller, target, next, output, changes, decision);
}

function captureMeasureValue(
  ctx: DomainContext,
  caller: Caller,
  target: CaptureTarget,
  output: Extract<MeetingOutput, { kind: 'measure_value' }>,
): CaptureOutcome {
  const { measure, existing } = output;
  if (!measure.workstreamIds.some((id) => target.workstreamIds.includes(id))) {
    throw invariantError({
      rule: '02 §6.3',
      message: `${measure.ref} is not on this meeting's scorecard`,
    });
  }
  const value = output.value ?? existing?.value;
  if (value === undefined) {
    throw new DomainError(
      'E_USAGE',
      '02 §6.3',
      `${measure.ref} has no value for ${output.periodStart}; give one`,
    );
  }
  if ((measure.unit === 'boolean') !== (typeof value === 'boolean')) {
    throw invariantError({
      rule: '02 §6.3',
      message: `${measure.ref} is measured in ${measure.unit}; the value must be ${measure.unit === 'boolean' ? 'true or false' : 'a number'}`,
    });
  }
  if (periodStartOf(measure.cadence, output.periodStart) !== output.periodStart) {
    throw invariantError({
      rule: '02 §6.3',
      message: `${output.periodStart} does not start a ${measure.cadence} period of ${measure.ref}`,
    });
  }
  if (
    existing !== undefined &&
    (existing.measureId !== measure.id || existing.periodStart !== output.periodStart)
  ) {
    throw invariantError({
      rule: '02 §6.3',
      message: 'the existing value is for another measure or period',
    });
  }
  const normal = output.normal === undefined ? (existing?.normal ?? null) : output.normal;
  const changes: Change[] = [];
  let note = output.note ?? existing?.note;
  let followUp: ActionItem | undefined;
  if (normal === false && (note === undefined || note.trim() === '')) {
    // 02 §5.1: a not-normal line with no explanation creates a draft follow-up.
    const meetingDate = localDate(target.instance.scheduledStart, target.series.timeZone);
    const workstreamId =
      measure.workstreamIds.find((id) => target.workstreamIds.includes(id)) ??
      measure.workstreamIds[0];
    const workstream =
      workstreamId === undefined ? undefined : ctx.registry.workstream(workstreamId);
    const doneMeans = `${measure.ref} ${measure.name} for ${output.periodStart} is explained or a fix is planned.`;
    const created_ = createActionItem(ctx, caller, {
      workstreamId: workstreamId as WorkstreamId,
      kind: 'follow_up',
      title: `Explain ${measure.ref} not normal for ${output.periodStart}`.slice(0, 120),
      doneMeans,
      evidenceRequirements: [defaultRequirement(doneMeans)],
      ownerId: measure.ownerId,
      due: {
        date: addDays(meetingDate, 7),
        timeZone: workstream?.timeZone ?? target.series.timeZone,
      },
      source: meetingSource(target),
      links: { measureIds: [measure.id] },
      lifecycle: 'draft',
      correlationId: target.instance.id,
    });
    followUp = created_.record;
    changes.push(...created_.changes);
    note = `Not normal, no explanation yet: follow-up ${followUp.ref}`;
  }
  const record: MeasureValue = {
    id: existing?.id ?? output.id ?? measureValueId(measure, output.periodStart),
    measureId: measure.id,
    periodStart: output.periodStart,
    value,
    source: existing?.source ?? 'manual',
    recordedAt:
      output.value === undefined && existing !== undefined ? existing.recordedAt : ctx.clock.now(),
    recordedBy:
      output.value === undefined && existing !== undefined ? existing.recordedBy : caller.actor,
    normal,
    ...(note === undefined ? {} : { note }),
  };
  assertNoViolations(checkMeasureValue(record));
  if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(record)) {
    return { status: 'no-op', instance: target.instance, record: existing, changes: [] };
  }
  changes.push(
    change(ctx, {
      kind: 'measure_value',
      verb: existing === undefined ? 'recorded' : 'read',
      entity: { id: record.id },
      before: existing,
      after: record,
      actor: caller.actor,
      correlationId: measure.id,
    }),
  );
  const next = withOutputs(
    target.instance,
    {
      measureValueIds: [record.id],
      ...(followUp === undefined ? {} : { actionItemIds: [followUp.id] }),
    },
    followUp !== undefined,
  );
  return finish(ctx, caller, target, next, output, changes, record);
}

function gradeProblem(
  model: Extract<MeetingOutput, { kind: 'goal_grade' }>['goalModel'],
  grade: number,
): string | undefined {
  switch (model) {
    case 'rocks':
    case 'priorities':
    case 'personal_goals':
      return grade === 0 || grade === 1 ? undefined : 'is graded done (1) or not done (0) only';
    case 'okr':
      return grade >= 0 && grade <= 1 ? undefined : 'is graded from 0.0 to 1.0';
    case 'wig':
      return Number.isFinite(grade) ? undefined : 'is graded by its lag value at target.by';
  }
}

function captureGoalGrade(
  ctx: DomainContext,
  caller: Caller,
  target: CaptureTarget,
  output: Extract<MeetingOutput, { kind: 'goal_grade' }>,
): CaptureOutcome {
  const { goal, grade } = output;
  if (!target.workstreamIds.includes(goal.workstreamId)) {
    throw invariantError({ rule: '02 §6.3', message: `${goal.ref} is not a goal of this meeting` });
  }
  const problem = gradeProblem(output.goalModel, grade);
  if (problem !== undefined) {
    throw invariantError({
      rule: '02 §6.3',
      message: `${goal.ref} (${output.goalModel}) ${problem}`,
    });
  }
  // Rocks and personal goals: the grade is the outcome. A WIG is done when its lag value at
  // target.by reached target.to. An OKR keeps its status: its grade is a score, not an outcome.
  const status: Goal['status'] =
    output.goalModel === 'rocks' ||
    output.goalModel === 'priorities' ||
    output.goalModel === 'personal_goals'
      ? grade === 1
        ? 'done'
        : 'not_done'
      : output.goalModel === 'wig' && goal.target !== undefined
        ? grade >= goal.target.to
          ? 'done'
          : 'not_done'
        : goal.status;
  const next: Goal = { ...touched(ctx, goal, caller.actor), grade, status };
  assertNoViolations(checkGoal(next));
  const write = change(ctx, {
    kind: 'goal',
    verb: 'graded',
    entity: { id: goal.id, ref: goal.ref },
    before: goal,
    after: next,
    actor: caller.actor,
  });
  const nextInstance = withOutputs(
    target.instance,
    { statusUpdates: [{ ref: goal.ref, field: 'lifecycle', from: goal.status, to: status }] },
    false,
  );
  return finish(ctx, caller, target, nextInstance, output, [write], next);
}

function captureGoal(
  ctx: DomainContext,
  caller: Caller,
  target: CaptureTarget,
  output: Extract<MeetingOutput, { kind: 'goal' }>,
): CaptureOutcome {
  workstreamOf(target, output.goal.workstreamId);
  if (output.goal.doneMeans === undefined && output.goal.measureIds.length === 0) {
    throw invariantError({
      rule: '02 §6.3',
      message: 'a goal set in a meeting needs a done-means or a measure (E-3, PO-3)',
    });
  }
  if (ctx.registry.person(output.goal.ownerId) === undefined) {
    throw invariantError({
      rule: '02 §6.3',
      message: `owner ${output.goal.ownerId} is not a person`,
    });
  }
  const goal: Goal = {
    ...output.goal,
    id: ctx.ids.id('goal'),
    ref: ctx.ids.ref('G'),
    status: 'active',
    health: 'on_track',
    ...created(ctx, caller.actor),
  };
  assertNoViolations(checkGoal(goal));
  const write = change(ctx, {
    kind: 'goal',
    verb: 'created',
    entity: { id: goal.id, ref: goal.ref },
    before: undefined,
    after: goal,
    actor: caller.actor,
    correlationId: target.instance.id,
  });
  const next = withOutputs(target.instance, { goalIds: [goal.id] }, false);
  return finish(ctx, caller, target, next, output, [write], goal);
}

function captureStatusUpdate(
  ctx: DomainContext,
  caller: Caller,
  target: CaptureTarget,
  output: Extract<MeetingOutput, { kind: 'status_update' }>,
): CaptureOutcome {
  const changes: Change[] = [];
  const updates: Outputs['statusUpdates'] = [];
  const issueIds: Issue['id'][] = [];
  let record: unknown;
  if (output.item !== undefined) {
    const item = output.item;
    if (!target.workstreamIds.includes(item.workstreamId)) {
      throw invariantError({
        rule: '02 §6.3',
        message: `${item.ref} is not in this meeting's scope`,
      });
    }
    let outcome;
    switch (output.field) {
      case 'health':
        if (output.health === undefined)
          throw new DomainError('E_USAGE', '02 §6.3', 'give the new health');
        outcome = setItemHealth(ctx, caller, item, output.health, output.note);
        updates.push({ ref: item.ref, field: 'health', from: item.health, to: output.health });
        break;
      case 'due':
        if (output.due === undefined || output.reason === undefined) {
          throw new DomainError('E_USAGE', '02 §7.1', 'a new due date needs the date and a reason');
        }
        outcome = replanItem(ctx, caller, item, { date: output.due }, output.reason);
        updates.push({ ref: item.ref, field: 'due', from: item.due.date, to: output.due });
        break;
      case 'lifecycle':
        if (output.lifecycle === 'dropped') {
          outcome = dropItem(ctx, caller, item, output.reason ?? '');
        } else if (output.lifecycle === 'in_progress') {
          outcome = startItem(ctx, caller, item);
        } else {
          throw new DomainError(
            'E_USAGE',
            '02 §6.3',
            'a lifecycle update is in_progress or dropped',
          );
        }
        updates.push({
          ref: item.ref,
          field: 'lifecycle',
          from: item.lifecycle,
          to: output.lifecycle,
        });
        break;
    }
    changes.push(...outcome.changes);
    record = outcome.record;
  } else if (output.goal !== undefined) {
    const goal = output.goal;
    if (output.field !== 'health' || output.health === undefined) {
      throw new DomainError('E_USAGE', '02 §6.3', 'a goal takes health updates in a meeting');
    }
    if (!target.workstreamIds.includes(goal.workstreamId)) {
      throw invariantError({
        rule: '02 §6.3',
        message: `${goal.ref} is not a goal of this meeting`,
      });
    }
    const base = omitKeys(goal, 'healthNote');
    const next: Goal = {
      ...touched(ctx, base as Goal, caller.actor),
      health: output.health,
      ...(output.note === undefined || output.note.trim() === ''
        ? {}
        : { healthNote: output.note }),
    };
    assertNoViolations(checkGoal(next));
    changes.push(
      change(ctx, {
        kind: 'goal',
        verb: 'health_set',
        entity: { id: goal.id, ref: goal.ref },
        before: goal,
        after: next,
        actor: caller.actor,
      }),
    );
    updates.push({ ref: goal.ref, field: 'health', from: goal.health, to: output.health });
    record = next;
    if (output.health !== 'on_track' && goal.health === 'on_track') {
      // 02 §5.1 goals_review: an at-risk or off-track priority raises an issue.
      const raised = raiseIssue(
        ctx,
        caller,
        {
          workstreamId: goal.workstreamId,
          title: `${goal.ref} ${goal.title} is ${output.health.replace('_', ' ')}`.slice(0, 200),
          raisedFrom: {
            kind: 'meeting',
            meetingId: target.instance.id,
            sectionId: target.section.sectionId,
          },
        },
        target.instance.id,
      );
      changes.push(...raised.changes);
      issueIds.push(raised.record.id);
    }
  } else {
    throw new DomainError('E_USAGE', '02 §6.3', 'a status update names an item or a goal');
  }
  const next = withOutputs(
    target.instance,
    { statusUpdates: updates, ...(issueIds.length === 0 ? {} : { issueIds }) },
    false,
  );
  return finish(
    ctx,
    caller,
    target,
    next,
    output,
    changes,
    record as { id?: string; ref?: string },
  );
}

function captureVerification(
  ctx: DomainContext,
  caller: Caller,
  target: CaptureTarget,
  output: Extract<MeetingOutput, { kind: 'verification' }>,
): CaptureOutcome {
  const { item } = output;
  if (!target.workstreamIds.includes(item.workstreamId)) {
    throw invariantError({
      rule: '02 §6.3',
      message: `${item.ref} is not in this meeting's scope`,
    });
  }
  const outcome =
    output.result === 'confirmed'
      ? confirmItem(ctx, caller, item, output.evidence ?? [])
      : output.result === 'attested'
        ? attestItem(ctx, caller, item, output.note ?? '')
        : rejectClaim(ctx, caller, item, output.note ?? '');
  const next = withOutputs(
    target.instance,
    { verifications: [{ actionItemId: item.id, result: output.result }] },
    false,
  );
  return finish(ctx, caller, target, next, output, outcome.changes, outcome.record);
}

/** Captures one output into one section of an in-progress meeting (02 §6.3). */
export function captureOutput(
  ctx: DomainContext,
  caller: Caller,
  target: CaptureTarget,
  output: MeetingOutput,
): CaptureOutcome {
  requireCapturable(ctx, caller, target, output);
  switch (output.kind) {
    case 'action_item':
      return captureActionItem(ctx, caller, target, output);
    case 'decision':
      return captureDecision(ctx, caller, target, output);
    case 'issue': {
      const raised = raiseIssue(
        ctx,
        caller,
        {
          workstreamId: workstreamOf(target, output.workstreamId),
          title: output.title,
          raisedFrom: {
            kind: 'meeting',
            meetingId: target.instance.id,
            sectionId: target.section.sectionId,
          },
          ...(output.rank === undefined ? {} : { rank: output.rank }),
        },
        target.instance.id,
      );
      const next = withOutputs(target.instance, { issueIds: [raised.record.id] }, false);
      return finish(ctx, caller, target, next, output, raised.changes, raised.record);
    }
    case 'issue_resolution': {
      const { issue } = output;
      if (!target.workstreamIds.includes(issue.workstreamId)) {
        throw invariantError({
          rule: '02 §6.3',
          message: `${issue.ref} is not in this meeting's scope`,
        });
      }
      const resolved = resolveIssue(ctx, caller, issue, output.resolution);
      const next = withOutputs(
        target.instance,
        {
          statusUpdates: [
            { ref: issue.ref, field: 'lifecycle', from: issue.status, to: resolved.record.status },
          ],
        },
        false,
      );
      return finish(ctx, caller, target, next, output, resolved.changes, resolved.record);
    }
    case 'risk': {
      const recorded = recordRisk(ctx, caller, {
        workstreamId: workstreamOf(target, output.workstreamId),
        description: output.description,
        trigger: output.trigger,
        ...(output.watcherId === undefined ? {} : { watcherId: output.watcherId }),
      });
      const next = withOutputs(target.instance, { riskIds: [recorded.record.id] }, false);
      return finish(ctx, caller, target, next, output, recorded.changes, recorded.record);
    }
    case 'measure_value':
      return captureMeasureValue(ctx, caller, target, output);
    case 'goal':
      return captureGoal(ctx, caller, target, output);
    case 'goal_grade':
      return captureGoalGrade(ctx, caller, target, output);
    case 'status_update':
      return captureStatusUpdate(ctx, caller, target, output);
    case 'verification':
      return captureVerification(ctx, caller, target, output);
    case 'note': {
      const text = output.text.trim();
      if (text === '') throw new DomainError('E_USAGE', '02 §6.3', 'a note needs text');
      const line = `[${target.section.sectionId}] ${text}`;
      const notes = target.instance.notes === '' ? line : `${target.instance.notes}\n${line}`;
      return finish(ctx, caller, target, { ...target.instance, notes }, output, [], undefined);
    }
  }
}
