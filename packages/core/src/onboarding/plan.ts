/**
 * The onboarding commit as a plan (01 §3 S4 to S9, C-01-01, C-01-07): from a complete
 * `OnboardingProfile`, every record the commit writes, the full preview, the warnings and the
 * blockers. Planning writes nothing; `apply` writes the plan's records in one transaction and
 * `preview` (`--dry-run`) only shows them.
 *
 * In order:
 * 1. S4: `recommend()` (01 §6, pure, C-01-02); a workstream with no S4 answer takes the
 *    recommendation, as accepting it does. A client engagement or project with a parent (R5)
 *    gets no instance of its own (C-01-05); its block goes into its root's weekly meeting.
 * 2. S5: each instance's parameters are the template defaults for its mode with the Q-T01 and
 *    Q-T05 answers over them, checked against their bounds (`E_PARAM_BOUNDS`, C-01-04).
 * 3. S6: the series are composed (compose.ts), placed (02 §4.6) and checked by the rhythm
 *    engine; T1 and T2 run (01 §6.4). A soft block or a time outside working hours without the
 *    user's confirmation, T1 over budget with no fix picked, and T2 block the commit.
 * 4. Every template validator runs on each new instance (C-01-03). A broken backbone invariant
 *    about the meetings (E-1, E-8, PO-1, PO-4, X-3) blocks the commit. The others are about
 *    content the user fills in as the rhythm runs (scorecard lines and their targets, priorities
 *    and their done-means): onboarding creates goals as drafts (01 §3 S5) and lets a line's
 *    target be "per plan" (01 §4), so those are warnings, not blockers.
 * 5. S7 and S8 add no record before P2 and P3: connector bindings, the AI provider config and
 *    the backup policy have no record type yet, so those answers stay in the onboarding record
 *    and the preview lists the outward actions they lead to (sign-ins, the first calendar
 *    batch, discovery), each confirmed on its own later (C-01-01).
 */
import {
  createWorkspaceWorkstream,
  type Caller,
  type DomainContext,
  type IdPrefix,
} from '@cc/domain';
import {
  builtPacks,
  builtTemplates,
  checkInvariants,
  checkParameters,
  effectiveParameters,
  findPack,
  findTemplate,
  FrameworkError,
  recommend,
  RECOMMENDER_VERSION,
  type InstanceState,
  type AgendaSectionType,
} from '@cc/frameworks';
import {
  addDays,
  agendaTemplate,
  blockIntervals,
  canonicalRule,
  checkNoSlot,
  checkSeries,
  checkTimeBudget,
  firstOccurrenceOnOrAfter,
  HORIZON_DAYS,
  isoWeekday,
  localDate,
  localDateTime,
  materialise,
  packSection,
  RHYTHM_CALLER,
  SERIES_DEFAULTS,
  seriesIntervals,
  startOfDay,
  type PlacementContext,
  type PlacementViolation,
} from '@cc/rhythm';
import type {
  AcceptedFramework,
  Actor,
  CalendarMapping,
  FrameworkInstance,
  FrameworkRecommendation,
  FrameworkTemplate,
  Goal,
  HumanRefKind,
  Measure,
  MeetingInstance,
  MeetingSeries,
  OnboardingNotice,
  OnboardingPreview,
  OnboardingProfile,
  Person,
  TailoringAnswers,
  Workspace,
  Workstream,
  WorkstreamAnswers,
} from '@cc/schemas';

import { CoreError } from '../errors.js';
import { composeRhythm, type ComposedSeries, type InstanceInput } from './compose.js';

type TimeBudgetFix = NonNullable<NonNullable<OnboardingProfile['rhythm']>['timeBudgetFix']>;

/** The invariants about the meetings a commit composes: broken, they block it (rule 4 above). */
export const MEETING_INVARIANTS: ReadonlySet<string> = new Set([
  'E-1',
  'E-8',
  'PO-1',
  'PO-4',
  'X-3',
]);

/** Q-T07 and Q-T08 defaults (01 §8). */
export const DEFAULT_TAILORING: Omit<TailoringAnswers, 'workstreamKey' | 'aiDataPolicy'> = {
  parameters: {},
  merge: true,
  measures: [],
  goals: [],
  owners: { '*': 'self' },
  verification: { policy: 'require_review', autoCloseOn: ['calendar_event', 'measure_threshold'] },
  escalation: { e2CarryCount: 2, e3CarryCount: 4, e3OverdueDays: 30 },
  informRoles: [],
};

export interface PlanInput {
  readonly profile: OnboardingProfile;
  readonly calendarMapping?: CalendarMapping;
  /** RFC 3339 UTC: the commit time. */
  readonly now: string;
  /** Who commits: the user in the app, or an agent with `onboarding:apply` (C-01-07). */
  readonly actor: Actor;
  /** Record IDs (`<prefix>_<ULID>` in the core; counting in tests). */
  readonly id: (prefix: IdPrefix) => string;
}

/** Every record the commit writes, in the order it writes them. */
export interface PlanRecords {
  readonly workspace: Workspace;
  readonly persons: readonly Person[];
  readonly workstreams: readonly Workstream[];
  readonly instances: readonly FrameworkInstance[];
  readonly measures: readonly Measure[];
  readonly goals: readonly Goal[];
  readonly series: readonly MeetingSeries[];
  readonly meetings: readonly MeetingInstance[];
}

export interface OnboardingPlan {
  readonly preview: OnboardingPreview;
  readonly records: PlanRecords;
  /** The profile as committed: S4's output and choices filled in, `commit` answered. */
  readonly profile: OnboardingProfile;
}

const notice = (code: string, text: string, help: readonly string[] = []): OnboardingNotice => ({
  code,
  text,
  help: [...help],
});

/** The Monday after `today`: the meetings start in the next week (README §4, 02 §4.1). */
export function rhythmStart(today: string): string {
  return addDays(today, 8 - isoWeekday(today));
}

function quarterOf(date: string): { start: string; end: string; label: string } {
  const year = Number(date.slice(0, 4));
  const quarter = Math.ceil(Number(date.slice(5, 7)) / 3);
  const startMonth = (quarter - 1) * 3 + 1;
  const start = `${String(year)}-${String(startMonth).padStart(2, '0')}-01`;
  const next =
    quarter === 4
      ? `${String(year + 1)}-01-01`
      : `${String(year)}-${String(startMonth + 3).padStart(2, '0')}-01`;
  return { start, end: addDays(next, -1), label: `${String(year)}-Q${String(quarter)}` };
}

function targetText(target: Measure['target']): string {
  if (target.op === 'between')
    return `between ${String(target.value)} and ${String(target.value2)}`;
  return `${target.op} ${String(target.value)}`;
}

/** 03 §5.4: how a period's values combine, by unit. */
function aggregationOf(unit: Measure['unit']): Measure['aggregation'] {
  switch (unit) {
    case 'percent':
    case 'days':
      return 'avg';
    case 'boolean':
      return 'last';
    default:
      return 'sum';
  }
}

function frameworkError(error: unknown): unknown {
  if (error instanceof FrameworkError) return new CoreError(error.code, error.message, error.help);
  return error;
}

/** Converts a recommender or bounds failure into the API's error (C-01-04, C-01-07). */
function runFramework<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw frameworkError(error);
  }
}

/** Refs: a counter per kind; refs a measure line already names stay its own (03 §3). */
class Refs {
  readonly #next: Record<HumanRefKind, number> = { A: 1, D: 1, I: 1, R: 1, M: 1, G: 1, K: 1 };
  readonly #taken = new Set<string>();

  reserve(ref: string): void {
    this.#taken.add(ref);
  }

  next(kind: HumanRefKind): string {
    for (;;) {
      const ref = `${kind}-${String(this.#next[kind]).padStart(4, '0')}`;
      this.#next[kind] += 1;
      if (!this.#taken.has(ref)) {
        this.#taken.add(ref);
        return ref;
      }
    }
  }

  counters(): Workspace['counters'] {
    const out = { ...this.#next };
    for (const ref of this.#taken) {
      const kind = ref[0] as HumanRefKind;
      out[kind] = Math.max(out[kind], Number(ref.slice(2)) + 1);
    }
    return out;
  }
}

/** The section types of a series' agenda, its packs' sections in their slots (02 §5). */
function agendaTypes(templateId: string, packIds: readonly string[]): AgendaSectionType[] {
  const template = agendaTemplate(templateId);
  const sections = template.sections.map((section) => ({ id: section.id, type: section.type }));
  for (const packId of packIds) {
    for (const entry of findPack(packId)?.agendaSections ?? []) {
      if (!template.slots.includes(entry.slot)) continue;
      if (sections.some((section) => section.id === entry.sectionTemplateId)) continue;
      const [where, anchor] = entry.slot.split(':') as ['before' | 'after', string];
      const index = sections.findIndex((section) => section.id === anchor);
      if (index < 0) continue;
      const added = packSection(entry.sectionTemplateId);
      sections.splice(where === 'before' ? index : index + 1, 0, {
        id: added.id,
        type: added.type,
      });
    }
  }
  return sections.map((section) => section.type as AgendaSectionType);
}

interface Owned {
  readonly self: Person;
  readonly byRole: Map<string, Person>;
}

/** A role token's person: `self` is the user; any other token gets a person of its own. */
function ownerOf(owned: Owned, role: string, make: (role: string) => Person): Person {
  if (role === 'self') return owned.self;
  let person = owned.byRole.get(role);
  if (person === undefined) {
    person = make(role);
    owned.byRole.set(role, person);
  }
  return person;
}

/** 02 §4.6 violations of one series over its first 13 weeks, as the user reads them. */
function placementIssues(record: MeetingSeries, placement: PlacementContext): PlacementViolation[] {
  const from = startOfDay(record.dtstart.slice(0, 10), record.timeZone);
  const to = startOfDay(addDays(record.dtstart.slice(0, 10), HORIZON_DAYS), record.timeZone);
  const intervals = seriesIntervals([record], from, to);
  const blocks = blockIntervals(placement.protectedBlocks, from, to);
  const seen = new Set<string>();
  const out: PlacementViolation[] = [];
  for (const interval of intervals) {
    for (const block of blocks) {
      if (!(interval.start < block.end && block.start < interval.end)) continue;
      const key = `${block.policy}:${block.blockId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: block.policy === 'hard' ? 'hard_block' : 'soft_block',
        interval,
        blockId: block.blockId,
      });
    }
    const local = localDateTime(interval.start, placement.timeZone);
    const day = local.slice(0, 10);
    const start = Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));
    const length = (Date.parse(interval.end) - Date.parse(interval.start)) / 60_000;
    const weekday = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'][isoWeekday(day) - 1] ?? 'MO';
    const inside =
      placement.workweek.includes(weekday as never) &&
      placement.workingHours.some((range) => {
        const a = Number(range.start.slice(0, 2)) * 60 + Number(range.start.slice(3));
        const b = Number(range.end.slice(0, 2)) * 60 + Number(range.end.slice(3));
        return start >= a && start + length <= b;
      });
    if (!inside && !seen.has('hours')) {
      seen.add('hours');
      out.push({ kind: 'outside_working_hours', interval });
    }
  }
  return out;
}

/** Plans the commit of a complete profile. Throws E_USAGE or E_PARAM_BOUNDS on bad answers. */
export function planOnboarding(input: PlanInput): OnboardingPlan {
  const { profile, actor, now } = input;
  const ws = profile.workspace;
  const today = localDate(now, ws.timeZone);
  const startsOn = rhythmStart(today);
  const audit = { createdAt: now, createdBy: actor, updatedAt: now, updatedBy: actor, version: 1 };
  const warnings: OnboardingNotice[] = [];
  const blockers: OnboardingNotice[] = [];
  const refs = new Refs();

  // S4
  const recommendations = runFramework(() => recommend(profile, today));
  const recOf = new Map(recommendations.map((rec) => [rec.workstreamKey, rec]));
  for (const rec of recommendations) {
    for (const warning of rec.warnings) {
      warnings.push(notice(warning.code, `${rec.workstreamKey}: ${warning.text}`));
    }
  }
  if (profile.workstreams.length === 0) {
    blockers.push(
      notice('W-NO-WORKSTREAM', 'Add at least one workstream to run in Command Center (S2).'),
    );
  }

  const answersOf = new Map(profile.workstreams.map((w) => [w.key, w]));
  const isChild = (w: WorkstreamAnswers) => recOf.get(w.key)?.firedRules[0] === 'R5';
  const rootOf = (w: WorkstreamAnswers): WorkstreamAnswers => {
    let root = w;
    while (root.parentKey !== undefined) {
      const parent = answersOf.get(root.parentKey);
      if (parent === undefined) break;
      root = parent;
    }
    return root;
  };

  const accepted: AcceptedFramework[] = [];
  const templateOf = new Map<string, FrameworkTemplate>();
  for (const w of profile.workstreams) {
    if (isChild(w)) continue;
    const rec = recOf.get(w.key) as FrameworkRecommendation;
    const answer = profile.accepted?.find((entry) => entry.workstreamKey === w.key);
    const templateId = answer?.templateId ?? rec.templateId;
    const template = builtTemplates.find((t) => t.id === templateId) ?? findTemplate(templateId);
    if (template === undefined || !builtTemplates.includes(template)) {
      throw new CoreError('E_USAGE', `${w.key}: ${templateId} is not built in this release`, [
        `Pick one of ${builtTemplates.map((t) => t.id).join(', ')} at S4`,
      ]);
    }
    templateOf.set(w.key, template);
    accepted.push({
      workstreamKey: w.key,
      templateId: template.id,
      acceptedAt: answer?.acceptedAt ?? now,
      overrodeRecommendation: template.id !== rec.templateId,
    });
  }

  // People and workstreams
  const selfId = input.id('per') as Person['id'];
  const self: Person = {
    id: selfId,
    displayName: 'Self',
    role: 'self',
    emails: [],
    timeZone: ws.timeZone,
    consents: [],
    ...audit,
  };
  const owned: Owned = { self, byRole: new Map() };
  const persons: Person[] = [self];
  const makeRolePerson = (role: string): Person => {
    const external = role.startsWith('[') && role.endsWith(']');
    const person: Person = {
      id: input.id('per') as Person['id'],
      displayName: external ? role.slice(1, -1) : role,
      role: external ? 'external' : 'collaborator',
      emails: [],
      consents: [],
      ...audit,
    };
    persons.push(person);
    return person;
  };
  const principalOf = new Map<string, string[]>();

  const workstreamId = new Map<string, Workstream['id']>();
  for (const w of profile.workstreams) workstreamId.set(w.key, input.id('ws') as Workstream['id']);
  const instanceId = new Map<string, FrameworkInstance['id']>();
  for (const key of templateOf.keys())
    instanceId.set(key, input.id('fwi') as FrameworkInstance['id']);

  const tailoringOf = (key: string): TailoringAnswers => {
    const found = profile.tailoring?.find((entry) => entry.workstreamKey === key);
    return (
      found ?? {
        ...DEFAULT_TAILORING,
        workstreamKey: key,
        aiDataPolicy: recOf.get(key)?.aiDataPolicy ?? 'allow',
      }
    );
  };

  const ctx: DomainContext = {
    clock: { now: () => now },
    ids: {
      id: ((prefix: IdPrefix) => input.id(prefix)) as DomainContext['ids']['id'],
      ref: (kind) => refs.next(kind),
    },
    registry: {
      selfPersonId: selfId,
      person: (id) => persons.find((p) => p.id === id),
      workstream: () => undefined,
      connectorHasAction: () => false,
      validators: () => [],
    },
  };
  const caller: Caller = { actor };
  const workspaceStream = createWorkspaceWorkstream(ctx, caller, [], {
    timeZone: ws.timeZone,
  }).record;
  const workstreams: Workstream[] = [];
  for (const w of profile.workstreams) {
    const rec = recOf.get(w.key) as FrameworkRecommendation;
    let principalId: Person['id'] = selfId;
    if (w.principal.kind === 'other') {
      const person: Person = {
        id: input.id('per') as Person['id'],
        displayName: w.principal.displayName,
        role: 'external',
        emails: [],
        timeZone: w.principal.timeZone,
        consents: [
          {
            scope: w.kind === 'job_search' ? 'track_my_search' : 'run_this_workstream',
            grantedAt: now,
            recordedBy: actor,
            evidenceNote: w.principal.consentNote,
          },
        ],
        ...audit,
      };
      persons.push(person);
      principalId = person.id;
    }
    principalOf.set(principalId, [...(principalOf.get(principalId) ?? []), w.key]);
    const tailoring = isChild(w) ? undefined : tailoringOf(w.key);
    const own = instanceId.get(w.key);
    workstreams.push({
      id: workstreamId.get(w.key) as Workstream['id'],
      slug: w.key,
      name: w.name,
      kind: w.kind,
      ...(w.parentKey === undefined
        ? {}
        : { parentId: workstreamId.get(w.parentKey) as Workstream['id'] }),
      principalId,
      stewardId: selfId,
      timeZone: w.timeZone ?? (w.principal.kind === 'other' ? w.principal.timeZone : ws.timeZone),
      status: 'active',
      ...(own === undefined ? {} : { frameworkInstanceId: own }),
      privacy: rec.privacy,
      aiDataPolicy: tailoring?.aiDataPolicy ?? rec.aiDataPolicy,
      repoPaths: [],
      groundingRefs: (tailoring?.groundingRefs ?? []).flatMap((ref) =>
        ref.path === null ? [] : [{ kind: ref.kind, path: ref.path }],
      ),
      ...audit,
    });
    for (const ref of tailoring?.groundingRefs ?? []) {
      if (ref.path === null) {
        warnings.push(
          notice(
            'W-DEFERRED',
            `${w.key}: the ${ref.kind.replace('_', ' ')} file is to be written; add it when it exists.`,
          ),
        );
      }
    }
  }

  // S5: instances
  const instanceMeta = new Map<
    string,
    {
      template: FrameworkTemplate;
      rec: FrameworkRecommendation;
      mode: 'solo' | 'team';
      parameters: Record<string, unknown>;
    }
  >();
  for (const [key, template] of templateOf) {
    const rec = recOf.get(key) as FrameworkRecommendation;
    const tailoring = tailoringOf(key);
    const asked = runFramework(() => {
      const bounds = checkParameters(template, tailoring.parameters);
      if (bounds !== undefined)
        throw new FrameworkError({ ...bounds, help: [...bounds.help], details: bounds.details });
      return tailoring.parameters;
    });
    const parameters = effectiveParameters(template, rec.mode, asked);
    instanceMeta.set(key, { template, rec, mode: rec.mode, parameters });
  }

  const compose = (fix: TimeBudgetFix | undefined) => {
    const inputs: InstanceInput[] = [];
    for (const [key, meta] of instanceMeta) {
      const tailoring = tailoringOf(key);
      const keepMerge = fix === 'merge' || tailoring.merge !== false;
      inputs.push({
        instanceId: instanceId.get(key) as string,
        workstreamId: workstreamId.get(key) as string,
        workstreamKey: key,
        template: meta.template,
        mode: meta.mode,
        parameters: meta.parameters,
        ...(meta.rec.mergeGroup !== undefined && keepMerge
          ? { mergeGroup: meta.rec.mergeGroup }
          : {}),
        childWorkstreamIds: profile.workstreams
          .filter((w) => isChild(w) && rootOf(w).key === key)
          .map((w) => workstreamId.get(w.key) as string),
      });
    }
    return {
      inputs,
      composed: composeRhythm({
        workspace: ws,
        selfPersonId: selfId,
        instances: inputs,
        portfolio: profile.workstreams.map((w) => ({
          id: workstreamId.get(w.key) as string,
          key: w.key,
        })),
        dailyStart: profile.rhythm?.dailyStart ?? true,
        dailyShutdown: profile.rhythm?.dailyShutdown ?? true,
        startsOn,
        shorten: fix === 'shorten',
        biweekly: fix === 'biweekly',
      }),
    };
  };

  const draftSeries = (composed: readonly ComposedSeries[]): MeetingSeries[] =>
    composed.map((c) => {
      const rrule = canonicalRule(c.spec.rrule);
      const dtstart =
        firstOccurrenceOnOrAfter(rrule, c.spec.timeZone, startsOn) ?? `${startsOn}T00:00`;
      return {
        ...c.spec,
        rrule,
        id: input.id('ser') as MeetingSeries['id'],
        dtstart,
        status: 'active',
        prereadLeadMinutes:
          c.spec.cadence === 'daily'
            ? SERIES_DEFAULTS.dailyPrereadLeadMinutes
            : SERIES_DEFAULTS.prereadLeadMinutes,
        reminderMinutes: [...SERIES_DEFAULTS.reminderMinutes],
        graceMinutes: SERIES_DEFAULTS.graceMinutes,
        ...audit,
      } as MeetingSeries;
    });

  // T1, with the user's fix when they picked one (01 §6.4): CC never applies one by itself.
  let budget = ws.weeklyManagementMinutes;
  const fix = profile.rhythm?.timeBudgetFix;
  let composition = compose(undefined);
  let series = draftSeries(composition.composed);
  let t1 = checkTimeBudget(series, budget, startsOn);
  if (t1.warning !== undefined) {
    if (fix === undefined) {
      blockers.push(
        notice('W-TIME-BUDGET', t1.warning.text, [
          'Pick one at S6 (rhythm.timeBudgetFix): merge, shorten, biweekly or raise_budget',
        ]),
      );
    } else {
      if (fix === 'raise_budget') budget = Math.ceil(t1.averageWeeklyMinutes);
      else {
        composition = compose(fix);
        series = draftSeries(composition.composed);
      }
      t1 = checkTimeBudget(series, budget, startsOn);
      warnings.push(
        notice(
          'W-TIME-BUDGET',
          t1.warning === undefined
            ? `The rhythm was over the budget; with the fix you picked (${fix}) it averages ${String(Math.round(t1.averageWeeklyMinutes))} minutes a week, within ${String(budget)}.`
            : `With the fix you picked (${fix}) the rhythm still averages ${String(Math.round(t1.averageWeeklyMinutes))} minutes a week, over ${String(budget)}.`,
        ),
      );
    }
  }
  const composed = composition.composed;

  // Placement (02 §4.6): every soft block or out-of-hours time needs the user's confirmation.
  const placement: PlacementContext = {
    timeZone: ws.timeZone,
    workweek: ws.workweek,
    workingHours: ws.workingHours,
    protectedBlocks: ws.protectedBlocks,
    confirmations: [],
  };
  const labels = new Map(ws.protectedBlocks.map((block) => [block.id, block.label]));
  const overlaps = profile.rhythm?.acceptedOverlaps ?? [];
  const confirmations: PlacementContext['confirmations'][number][] = [];
  const records: MeetingSeries[] = [];
  composed.forEach((c, index) => {
    const draft = series[index] as MeetingSeries;
    const confirmedFor = (reason: 'soft_block' | 'outside_working_hours', blockId?: string) =>
      overlaps.some(
        (o) =>
          c.workstreamKeys.includes(o.workstreamKey) &&
          o.meetingKey === draft.backboneMeetingKey &&
          o.reason === reason &&
          (reason !== 'soft_block' || o.blockId === undefined || o.blockId === blockId),
      );
    const local = draft.dtstart.slice(11);
    let blocked = false;
    for (const violation of placementIssues(draft, placement)) {
      const what = `${draft.name} (${
        draft.rrule
          .split(';')
          .find((p) => p.startsWith('BYDAY='))
          ?.slice(6) ?? ''
      } ${local})`;
      if (violation.kind === 'hard_block') {
        blocked = true;
        blockers.push(
          notice(
            'W-PLACEMENT',
            `${what} overlaps the hard protected block ${labels.get(violation.blockId) ?? violation.blockId}; nothing may be booked there (C-02-07).`,
            ['Change the meeting time (S5 or S6) or the block (S1)'],
          ),
        );
      } else if (violation.kind === 'soft_block') {
        if (confirmedFor('soft_block', violation.blockId)) {
          confirmations.push({
            seriesId: draft.id,
            reason: 'soft_block',
            blockId: violation.blockId,
          });
        } else {
          blocked = true;
          blockers.push({
            ...notice(
              'W-PLACEMENT',
              `${what} falls inside the soft protected block ${labels.get(violation.blockId) ?? violation.blockId}; it needs your confirmation (02 §4.6).`,
              [
                `Confirm the overlap at S6: rhythm.acceptedOverlaps {workstreamKey: ${c.workstreamKeys[0] ?? ''}, meetingKey: ${draft.backboneMeetingKey}, blockId: ${violation.blockId}, reason: soft_block}`,
                'Or move the meeting',
              ],
            ),
            overlap: {
              workstreamKey: c.workstreamKeys[0] ?? '',
              meetingKey: draft.backboneMeetingKey,
              blockId: violation.blockId,
              reason: 'soft_block',
            },
          });
        }
      } else if (violation.kind === 'outside_working_hours') {
        if (confirmedFor('outside_working_hours')) {
          confirmations.push({ seriesId: draft.id, reason: 'outside_working_hours' });
        } else {
          blocked = true;
          blockers.push({
            ...notice(
              'W-PLACEMENT',
              `${what} is outside working hours; it needs your confirmation (02 §4.6).`,
              [
                `Confirm the exception at S6: rhythm.acceptedOverlaps {workstreamKey: ${c.workstreamKeys[0] ?? ''}, meetingKey: ${draft.backboneMeetingKey}, reason: outside_working_hours}`,
                'Or move the meeting into working hours',
              ],
            ),
            overlap: {
              workstreamKey: c.workstreamKeys[0] ?? '',
              meetingKey: draft.backboneMeetingKey,
              reason: 'outside_working_hours',
            },
          });
        }
      }
    }
    if (blocked) {
      records.push(draft);
      return;
    }
    try {
      records.push(
        checkSeries(draft, {
          startsOn,
          ...(c.backbone === undefined ? {} : { backbone: c.backbone }),
          activeWorkstreamIds: profile.workstreams.map((w) => workstreamId.get(w.key) as string),
          placement: { ...placement, confirmations },
        }),
      );
    } catch (error) {
      const failed = error as { code?: string; message?: string; help?: readonly string[] };
      if (failed.code === 'E_PARAM_BOUNDS') {
        throw new CoreError('E_PARAM_BOUNDS', `${draft.name}: ${failed.message ?? ''}`, [
          ...(failed.help ?? []),
        ]);
      }
      records.push(draft);
      blockers.push(
        notice('W-PLACEMENT', `${draft.name}: ${failed.message ?? 'cannot be placed'}`, [
          ...(failed.help ?? []),
        ]),
      );
    }
  });

  // T2 (01 §6.4)
  const required = [...instanceMeta.values()].flatMap((meta) =>
    meta.template.backbone.meetings
      .filter((m) => m.required && m.modes.includes(meta.mode))
      .map((m) => ({
        key: `${meta.rec.workstreamKey}.${m.key}`,
        durationMinutes:
          records.find(
            (s) =>
              s.backboneMeetingKey === m.key &&
              s.workstreamIds.includes(workstreamId.get(meta.rec.workstreamKey) as never),
          )?.durationMinutes ?? m.durationMinutes.default,
      })),
  );
  const t2 =
    required.length === 0
      ? undefined
      : checkNoSlot({ ...placement, confirmations }, required, startsOn);
  if (t2 !== undefined) {
    blockers.push(
      notice('W-NO-SLOT', t2.text, ['Change a meeting time (S5) or a protected block (S1)']),
    );
  }

  // S5: measures and goals
  const measures: Measure[] = [];
  const goals: Goal[] = [];
  const quarter = quarterOf(today);
  const seenLines = new Map<string, Measure>();
  for (const key of templateOf.keys()) {
    const tailoring = tailoringOf(key);
    for (const line of tailoring.measures) if (line.ref !== undefined) refs.reserve(line.ref);
  }
  for (const key of templateOf.keys()) {
    const tailoring = tailoringOf(key);
    let order = measures.filter((m) =>
      m.workstreamIds.includes(workstreamId.get(key) as never),
    ).length;
    for (const line of tailoring.measures) {
      const keys = line.workstreamKeys ?? [key];
      const identity = line.ref ?? `${keys.join(',')}:${line.name}`;
      if (seenLines.has(identity)) continue;
      if (line.target === undefined) {
        warnings.push(
          notice(
            'W-DEFERRED',
            `${key}: "${line.name}" has no target yet ("per plan"); it is kept in your answers and becomes a scorecard line once it has one.`,
          ),
        );
        continue;
      }
      const owner = ownerOf(owned, line.ownerRole, makeRolePerson);
      const measure: Measure = {
        id: input.id('msr') as Measure['id'],
        ref: line.ref ?? refs.next('K'),
        workstreamIds: keys
          .map((k) => workstreamId.get(k))
          .filter((id) => id !== undefined) as Measure['workstreamIds'],
        name: line.name,
        ownerId: owner.id,
        unit: line.unit,
        ...(line.currency === undefined ? {} : { currency: line.currency }),
        role: line.role,
        cadence: line.cadence,
        aggregation: aggregationOf(line.unit),
        target: line.target,
        source:
          line.source === 'derived'
            ? { kind: 'derived', formula: 'action_items_closed_on_time_pct' }
            : { kind: 'manual' },
        scorecardOrder: order,
        active: true,
        ...audit,
      };
      order += 1;
      seenLines.set(identity, measure);
      measures.push(measure);
    }
    for (const goal of tailoring.goals) {
      const owner = ownerOf(owned, goal.ownerRole, makeRolePerson);
      if (goal.target !== undefined && goal.target.by === null) {
        warnings.push(
          notice(
            'W-DEFERRED',
            `${key}: the date of "${goal.title}" is to be confirmed with the person it is for; set it on the Scorecard's Goals tab.`,
          ),
        );
      }
      goals.push({
        id: input.id('goal') as Goal['id'],
        ref: refs.next('G'),
        workstreamId: workstreamId.get(key) as Goal['workstreamId'],
        frameworkInstanceId: instanceId.get(key) as Goal['frameworkInstanceId'],
        kind: goal.kind,
        title: goal.title,
        ownerId: owner.id,
        period: quarter,
        ...(goal.doneMeans === undefined || goal.doneMeans.trim() === ''
          ? {}
          : { doneMeans: goal.doneMeans }),
        measureIds: [],
        ...(goal.target === undefined || goal.target.by === null
          ? {}
          : {
              target: {
                from: goal.target.from,
                to: goal.target.to,
                unit: goal.target.unit,
                by: goal.target.by,
              },
            }),
        commitment: 'committed',
        status: 'active',
        health: 'on_track',
        ...audit,
      });
    }
  }

  // Instances, validated (C-01-03)
  const instances: FrameworkInstance[] = [];
  for (const [key, meta] of instanceMeta) {
    const id = instanceId.get(key) as FrameworkInstance['id'];
    const wsId = workstreamId.get(key) as Workstream['id'];
    const mine = records.filter((s) => s.frameworkInstanceIds.includes(id));
    const instance: FrameworkInstance = {
      id,
      workstreamId: wsId,
      templateId: meta.template.id,
      templateVersion: meta.template.version,
      mode: meta.mode,
      goalModel:
        meta.template.id === meta.rec.templateId
          ? meta.rec.goalModel
          : meta.template.backbone.goalModel,
      packIds: [...meta.rec.packIds],
      parameters: meta.parameters,
      vocabularyOverrides: {},
      seriesIds: mine.map((s) => s.id),
      validatedAt: now,
      ...audit,
    };
    instances.push(instance);
    const state: InstanceState = {
      workstreamId: wsId,
      instance,
      series: mine.map((s) => ({
        id: s.id,
        backboneMeetingKey: s.backboneMeetingKey,
        status: s.status,
        workstreamIds: s.workstreamIds,
        rrule: s.rrule,
        durationMinutes: s.durationMinutes,
        agenda: agendaTypes(s.agendaTemplateId, instance.packIds),
      })),
      goals: goals
        .filter((g) => g.workstreamId === wsId)
        .map((g) => ({
          id: g.id,
          kind: g.kind,
          status: g.status,
          ownerId: g.ownerId,
          ...(g.doneMeans === undefined ? {} : { doneMeans: g.doneMeans }),
          measureIds: g.measureIds,
          ...(g.target === undefined ? {} : { target: g.target }),
        })),
      measures: measures
        .filter((m) => m.workstreamIds.includes(wsId))
        .map((m) => ({
          id: m.id,
          role: m.role,
          cadence: m.cadence,
          active: m.active,
          ownerId: m.ownerId,
          target: m.target,
        })),
    };
    const refOf = new Map<string, string>([
      ...goals.map((g) => [g.id as string, g.ref] as const),
      ...measures.map((m) => [m.id as string, m.ref] as const),
    ]);
    for (const violation of checkInvariants(meta.template, state)) {
      const message = violation.message.replace(
        /\b(?:goal|msr)_[A-Za-z0-9_]+/g,
        (id) => refOf.get(id) ?? id,
      );
      const text = `${key}: ${violation.invariantId} ${message}`;
      if (MEETING_INVARIANTS.has(violation.invariantId)) {
        blockers.push(
          notice('W-INVARIANT', text, [
            `${violation.invariantId}: see the ${meta.template.id} backbone (01 §5)`,
          ]),
        );
      } else {
        warnings.push(
          notice('W-INVARIANT', `${text}; complete it on the Scorecard or at the first meeting`),
        );
      }
    }
  }

  // Materialise the horizon (02 §4.1), as the rhythm engine does after a series change.
  let meetings: MeetingInstance[] = [];
  try {
    const result = materialise(ctx, RHYTHM_CALLER, {
      series: records,
      instances: [],
      placement: { ...placement, confirmations },
    });
    meetings = result.changes.map((c) => c.record);
    for (const gap of result.warnings) {
      warnings.push(
        notice(
          'W-DST-GAP',
          `${gap.local} does not exist in the series' time zone; that occurrence is left out.`,
        ),
      );
    }
    for (const move of result.moves) {
      warnings.push(
        notice(
          'W-MOVED',
          `A meeting moved from ${move.from} to ${move.to} to avoid another CC meeting (02 §4.6 rule 3).`,
        ),
      );
    }
  } catch (error) {
    if (blockers.length === 0) throw error;
  }

  // Outward actions, each confirmed on its own after the commit (C-01-01).
  const outward: OnboardingPreview['outwardActions'] = [];
  for (const tool of profile.tools) {
    const label =
      tool.accountLabel === undefined ? tool.toolName : `${tool.toolName} (${tool.accountLabel})`;
    if (tool.choice.kind === 'connector') {
      if (tool.category === 'calendar') {
        outward.push({
          kind: 'calendar_batch',
          text: `The first write of meetings to ${label} asks you to approve one batch, once its connector (${tool.choice.connectorId}) is installed and signed in`,
        });
      }
      outward.push({
        kind: 'sign_in',
        text: `Sign in to ${label} in the app once the ${tool.choice.connectorId} connector is installed`,
      });
    } else if (tool.choice.kind === 'discover') {
      outward.push({
        kind: 'discovery',
        text: `Find a connector for ${tool.toolName} with AI: public research only, and only when you start it (06 §3)`,
      });
    }
  }
  if (profile.ai.discover !== undefined) {
    outward.push({
      kind: 'discovery',
      text: `Find an adapter for the AI provider ${profile.ai.discover.providerName}: only when you start it (06 §3)`,
    });
  }

  const personsOut = persons.map((p) => ({
    role: p.role,
    name: p.displayName,
    principalOf: principalOf.get(p.id) ?? [],
  }));
  const keyOf = new Map([...workstreamId].map(([key, id]) => [id as string, key]));
  const workspace: Workspace = {
    id: input.id('wsp') as Workspace['id'],
    displayName: ws.displayName,
    timeZone: ws.timeZone,
    selfPersonId: selfId,
    counters: refs.counters(),
    ...audit,
  };
  const allStreams = [...workstreams, workspaceStream];
  const meetingDates = meetings.map((m) => localDate(m.occurrenceStart, ws.timeZone)).sort();
  const preview: OnboardingPreview = {
    today,
    rhythmStartsOn: startsOn,
    recommenderVersion: RECOMMENDER_VERSION,
    workspace: {
      displayName: ws.displayName,
      timeZone: ws.timeZone,
      weeklyManagementMinutes: budget,
    },
    persons: personsOut,
    workstreams: allStreams.map((w) => {
      const instance = instances.find((i) => i.workstreamId === w.id);
      return {
        key: w.slug,
        name: w.name,
        kind: w.kind,
        ...(w.parentId === undefined ? {} : { parent: keyOf.get(w.parentId) ?? '' }),
        ...(instance === undefined ? {} : { framework: instance.templateId }),
        privacy: w.privacy,
        aiDataPolicy: w.aiDataPolicy,
      };
    }),
    frameworkInstances: instances.map((i) => {
      const key = keyOf.get(i.workstreamId) ?? '';
      return {
        workstream: key,
        templateId: i.templateId,
        templateVersion: i.templateVersion,
        mode: i.mode,
        goalModel: i.goalModel,
        packs: i.packIds,
        firedRules: recOf.get(key)?.firedRules ?? [],
        overrodeRecommendation:
          accepted.find((a) => a.workstreamKey === key)?.overrodeRecommendation ?? false,
        parameters: i.parameters,
      };
    }),
    measures: measures.map((m) => ({
      ref: m.ref,
      workstreams: m.workstreamIds.map((id) => keyOf.get(id) ?? id),
      name: m.name,
      role: m.role,
      unit: m.unit,
      cadence: m.cadence,
      target: targetText(m.target),
      source: m.source.kind === 'derived' ? 'derived' : 'manual',
    })),
    goals: goals.map((g) => ({
      ref: g.ref,
      workstream: keyOf.get(g.workstreamId) ?? '',
      kind: g.kind,
      title: g.title,
      period: g.period.label,
    })),
    series: records.map((s) => ({
      name: s.name,
      cadence: s.cadence,
      rrule: s.rrule,
      dtstart: s.dtstart,
      durationMinutes: s.durationMinutes,
      workstreams: s.workstreamIds.map((id) => keyOf.get(id) ?? id),
      meeting: s.backboneMeetingKey,
      agendaTemplateId: s.agendaTemplateId,
      ...(s.absorbs.length === 0
        ? {}
        : {
            absorbs: s.absorbs
              .map((a) => `${a.cadence} (${String(a.absorbedMinutes)} min)`)
              .join(', '),
          }),
    })),
    instances: {
      count: meetings.length,
      ...(meetingDates[0] === undefined ? {} : { first: meetingDates[0] }),
      ...(meetingDates.at(-1) === undefined ? {} : { last: meetingDates.at(-1) as string }),
    },
    timeBudget: {
      averageWeeklyMinutes: Math.round(t1.averageWeeklyMinutes * 10) / 10,
      weeklyManagementMinutes: budget,
    },
    warnings,
    blockers,
    outwardActions: outward,
  };

  const committedSteps = [...new Set([...profile.completedSteps, 'commit' as const])];
  return {
    preview,
    records: {
      workspace,
      persons,
      workstreams: allStreams,
      instances,
      measures,
      goals,
      series: records,
      meetings,
    },
    profile: {
      ...profile,
      completedSteps: committedSteps,
      recommendations,
      accepted,
      workspace: { ...ws, weeklyManagementMinutes: budget },
    },
  };
}

/** Every built pack, for S5's suggestions. */
export const packsForS5 = builtPacks;
