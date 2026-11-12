/**
 * The `onboarding.*` methods (01 §3, §9.1; 09 P1-12) and the two S1 backup answers of
 * `backups.*` (04 §9.1; the rest of `backups.*` is P1-17).
 *
 * The answers live in the `onboarding` table, one row per workspace: the wizard saves them
 * after every step (`onboarding.save`), so each step can be skipped and resumed; the S9 commit
 * (`onboarding.apply`) writes every record in one transaction and marks the row committed
 * (C-01-01). `onboarding.preview` is `apply --dry-run`: the same plan, nothing written
 * (C-01-07, AC-01-06). The app-only answers (01 §3.1 rows 9, 10, 66 and 67) are human-only:
 * a profile from the CLI or MCP may not carry them, and only the app sets them.
 */
import { localDate } from '@cc/rhythm';
import { builtPacks, builtTemplates, FrameworkError, recommend } from '@cc/frameworks';
import {
  methods,
  type Actor,
  type CalendarMapping,
  type Onboarding,
  type OnboardingProfile,
  type OnboardingStep,
} from '@cc/schemas';
import type { Store, WriteTx } from '@cc/store';

import type { Clock } from '../clock.js';
import type { Dispatcher, HandlerContext } from '../dispatch.js';
import { CoreError } from '../errors.js';
import { newId } from '../ids.js';
import { exportProfile } from '../onboarding/export.js';
import { planOnboarding, type OnboardingPlan } from '../onboarding/plan.js';

/** The workspace's one onboarding record. */
export const ONBOARDING_ID = 'onb_main' as Onboarding['id'];

/** S1 to S9 (01 §3). */
export const STEPS: readonly OnboardingStep[] = [
  'workspace',
  'workstreams',
  'profiles',
  'recommendation',
  'tailoring',
  'rhythm',
  'tools',
  'ai',
  'commit',
];

/** 01 §3.1 rows 9, 10, 66 and 67: answered in the app only. */
const APP_ONLY = [
  { row: 9, question: 'Backup passphrase' },
  { row: 10, question: 'Off-machine backup destination' },
  { row: 66, question: 'Approve the first calendar write batch' },
  { row: 67, question: 'Sign in to each service' },
] as const;

const APP_ONLY_HELP = [
  'The backup passphrase and destination are app-only answers (01 §3.1 rows 9 and 10)',
  'Leave workspace.backup out of the profile and set them in the app at S1',
];

/** Called after a commit, with the committed answers (the shell's notification policy). */
export type CommittedListener = (profile: OnboardingProfile) => void;

export interface OnboardingOptions {
  readonly onCommitted?: CommittedListener;
}

function readRow(store: Store): Onboarding | undefined {
  return store.read((tx) => tx.get('onboarding', ONBOARDING_ID));
}

function nextStepOf(completed: readonly OnboardingStep[]): OnboardingStep | undefined {
  return STEPS.find((step) => !completed.includes(step));
}

function isAgent(context: HandlerContext): boolean {
  return context.actor.kind !== 'user';
}

/** A profile from an agent may not carry the app-only answers (01 §3.2 item 2). */
function refuseAppOnly(context: HandlerContext, profile: OnboardingProfile | undefined): void {
  if (isAgent(context) && profile?.workspace.backup !== undefined) {
    throw new CoreError(
      'E_USAGE',
      'the profile carries /workspace/backup, which only the app can set',
      APP_ONLY_HELP,
    );
  }
}

/** The answers to plan: the given profile with the stored backup answers, or the saved ones. */
function answersFor(
  store: Store,
  profile: OnboardingProfile | undefined,
): { profile: OnboardingProfile; row: Onboarding | undefined } {
  const row = readRow(store);
  if (profile === undefined) {
    if (row === undefined) {
      throw new CoreError('E_NOT_FOUND', 'onboarding has no answers yet', [
        'Answer the onboarding steps in the app, or pass --file <profile.json>',
      ]);
    }
    return { profile: row.profile, row };
  }
  const backup = row?.profile.workspace.backup;
  return {
    profile: {
      ...profile,
      workspace: {
        ...profile.workspace,
        ...(backup === undefined ? {} : { backup }),
      },
    },
    row,
  };
}

function frameworkErrors<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof FrameworkError) {
      throw new CoreError(error.code, error.message, [...error.help]);
    }
    throw error;
  }
}

function plan(
  profile: OnboardingProfile,
  calendarMapping: CalendarMapping | undefined,
  actor: Actor,
  clock: Clock,
): OnboardingPlan {
  return frameworkErrors(() =>
    planOnboarding({
      profile,
      ...(calendarMapping === undefined ? {} : { calendarMapping }),
      now: clock.now().toISOString(),
      actor,
      id: (prefix) => newId(prefix, clock),
    }),
  );
}

/** Inserts the row, or writes over the version read. */
function writeRow(tx: WriteTx, row: Onboarding, previous: Onboarding | undefined): void {
  if (previous === undefined) tx.insert('onboarding', row);
  else tx.update('onboarding', row, previous.version);
}

function nextRow(
  previous: Onboarding | undefined,
  fields: Pick<Onboarding, 'profile'> &
    Partial<Pick<Onboarding, 'calendarMapping' | 'committedAt'>>,
  actor: Actor,
  now: string,
): Onboarding {
  const calendarMapping = fields.calendarMapping ?? previous?.calendarMapping;
  const committedAt = fields.committedAt ?? previous?.committedAt;
  return {
    id: ONBOARDING_ID,
    profile: fields.profile,
    ...(calendarMapping === undefined ? {} : { calendarMapping }),
    ...(committedAt === undefined ? {} : { committedAt }),
    createdAt: previous?.createdAt ?? now,
    createdBy: previous?.createdBy ?? actor,
    updatedAt: now,
    updatedBy: actor,
    version: (previous?.version ?? 0) + 1,
  };
}

/** Writes every record of a plan in one command (C-01-01, 03 §12 point 4). */
function commit(
  store: Store,
  context: HandlerContext,
  result: OnboardingPlan,
  row: Onboarding | undefined,
  calendarMapping: CalendarMapping | undefined,
): string {
  const now = context.clock.now().toISOString();
  const { records } = result;
  store.command({ actor: context.actor, correlationId: 'onboarding.commit' }, (tx) => {
    if (tx.list('workspace', { limit: 1 }).length > 0) {
      throw new CoreError('E_CONFLICT', 'this profile already has a workspace', [
        'Onboarding sets up a new workspace; re-running a step comes with `onboarding rerun` (C-01-06)',
      ]);
    }
    const created = (kind: string, id: string, ref?: string) =>
      tx.event({
        type: `${kind}.created`,
        entity: { kind, id, ...(ref === undefined ? {} : { ref }) },
      });
    tx.insert('workspace', records.workspace);
    created('workspace', records.workspace.id);
    for (const person of records.persons) {
      tx.insert('persons', person);
      created('person', person.id);
    }
    for (const workstream of records.workstreams) {
      tx.insert('workstreams', workstream);
      created('workstream', workstream.id);
    }
    for (const instance of records.instances) {
      tx.insert('framework_instances', instance);
      created('framework_instance', instance.id);
    }
    for (const measure of records.measures) {
      tx.insert('measures', measure);
      created('measure', measure.id, measure.ref);
    }
    for (const goal of records.goals) {
      tx.insert('goals', goal);
      created('goal', goal.id, goal.ref);
    }
    for (const series of records.series) {
      tx.insert('meeting_series', series);
      created('meeting_series', series.id);
    }
    for (const meeting of records.meetings) {
      tx.insert('meeting_instances', meeting);
      tx.event({
        type: 'meeting_instance.created',
        entity: { kind: 'meeting_instance', id: meeting.id, ref: meeting.ref },
        actor: meeting.createdBy,
      });
    }
    const next = nextRow(
      row,
      {
        profile: result.profile,
        committedAt: now,
        ...(calendarMapping === undefined ? {} : { calendarMapping }),
      },
      context.actor,
      now,
    );
    writeRow(tx, next, row);
    tx.event({
      type: 'onboarding.committed',
      entity: { kind: 'onboarding', id: ONBOARDING_ID },
      after: {
        workstreams: records.workstreams.length,
        frameworkInstances: records.instances.length,
        series: records.series.length,
      },
    });
  });
  return now;
}

export function registerOnboardingHandlers(
  dispatcher: Dispatcher,
  store: Store,
  options: OnboardingOptions = {},
): void {
  dispatcher.register(methods.onboardingStatus, (_params, context) => {
    const row = readRow(store);
    const completed = row?.profile.completedSteps ?? [];
    const committed = row?.committedAt !== undefined;
    const backup = row?.profile.workspace.backup;
    const next = committed ? undefined : nextStepOf(completed);
    return {
      state: (row === undefined ? 'not_started' : committed ? 'committed' : 'in_progress') as
        'not_started' | 'committed' | 'in_progress',
      completedSteps: [...completed],
      ...(next === undefined ? {} : { nextStep: next }),
      ...(row?.committedAt === undefined ? {} : { committedAt: row.committedAt }),
      workstreams: row?.profile.workstreams.length ?? 0,
      appOnly: APP_ONLY.map((entry) => ({
        ...entry,
        answered:
          entry.row === 9
            ? backup?.passphraseSet === true
            : entry.row === 10
              ? backup?.destination !== undefined
              : false,
      })),
      ...(context.actor.kind === 'user' && row !== undefined
        ? {
            profile: row.profile,
            ...(row.calendarMapping === undefined ? {} : { calendarMapping: row.calendarMapping }),
          }
        : {}),
    };
  });

  dispatcher.register(methods.onboardingSave, (params, context) => {
    refuseAppOnly(context, params.profile);
    const row = readRow(store);
    if (row?.committedAt !== undefined) {
      throw new CoreError('E_CONFLICT', 'onboarding is committed', [
        'Re-running a step produces a diff and a migration plan; that comes with `onboarding rerun` (C-01-06)',
      ]);
    }
    const completed: OnboardingStep[] = params.profile.completedSteps.filter((s) => s !== 'commit');
    const step = params.step;
    if (step !== undefined && step !== 'commit' && !completed.includes(step)) completed.push(step);
    if (completed.includes('recommendation') && !completed.includes('profiles')) {
      throw new CoreError('E_USAGE', 'S4 runs only once S3 is answered for every workstream', [
        '01 §3 rule 1: answer S3 (profiles) first',
      ]);
    }
    // The backup answers are set by backups.* only: the stored ones are kept as they are.
    const backup = row?.profile.workspace.backup;
    const workspace = { ...params.profile.workspace };
    delete workspace.backup;
    const profile: OnboardingProfile = {
      ...params.profile,
      completedSteps: STEPS.filter((step) => completed.includes(step)),
      workspace: { ...workspace, ...(backup === undefined ? {} : { backup }) },
    };
    const calendarMapping = params.calendarMapping;
    const same =
      row !== undefined &&
      JSON.stringify(row.profile) === JSON.stringify(profile) &&
      JSON.stringify(row.calendarMapping) ===
        JSON.stringify(calendarMapping ?? row.calendarMapping);
    if (!same) {
      const now = context.clock.now().toISOString();
      store.command({ actor: context.actor }, (tx) => {
        writeRow(
          tx,
          nextRow(
            row,
            { profile, ...(calendarMapping === undefined ? {} : { calendarMapping }) },
            context.actor,
            now,
          ),
          row,
        );
        tx.event({
          type: 'onboarding.saved',
          entity: { kind: 'onboarding', id: ONBOARDING_ID },
          after: {
            completedSteps: profile.completedSteps,
            ...(params.step === undefined ? {} : { step: params.step }),
          },
        });
      });
    }
    const next = nextStepOf(profile.completedSteps);
    return {
      status: same ? ('no-op' as const) : ('ok' as const),
      completedSteps: profile.completedSteps,
      ...(next === undefined ? {} : { nextStep: next }),
    };
  });

  dispatcher.register(methods.onboardingRecommend, (params, context) => {
    const { profile } = answersFor(store, params.profile);
    const today = localDate(context.clock.now().toISOString(), profile.workspace.timeZone);
    const recommendations = frameworkErrors(() => recommend(profile, today));
    return { recommendations, templates: [...builtTemplates], packs: [...builtPacks] };
  });

  dispatcher.register(methods.onboardingPreview, (params, context) => {
    refuseAppOnly(context, params.profile);
    const { profile, row } = answersFor(store, params.profile);
    const result = plan(
      profile,
      params.calendarMapping ?? row?.calendarMapping,
      context.actor,
      context.clock,
    );
    return { preview: result.preview };
  });

  dispatcher.register(methods.onboardingApply, (params, context) => {
    refuseAppOnly(context, params.profile);
    const { profile, row } = answersFor(store, params.profile);
    if (row?.committedAt !== undefined) {
      throw new CoreError('E_CONFLICT', `onboarding was committed at ${row.committedAt}`, [
        'Re-running a step produces a diff and a migration plan; that comes with `onboarding rerun` (C-01-06)',
      ]);
    }
    const calendarMapping = params.calendarMapping ?? row?.calendarMapping;
    const result = plan(profile, calendarMapping, context.actor, context.clock);
    const { blockers } = result.preview;
    if (blockers.length > 0) {
      throw new CoreError(
        'E_INVARIANT',
        `onboarding cannot commit yet: ${blockers.map((b) => b.code).join(', ')}`,
        blockers.flatMap((b) => [b.text, ...b.help]),
      );
    }
    const committedAt = commit(store, context, result, row, calendarMapping);
    options.onCommitted?.(result.profile);
    return { status: 'ok' as const, committedAt, preview: result.preview };
  });

  dispatcher.register(methods.onboardingExport, () => {
    const row = readRow(store);
    if (row === undefined) {
      throw new CoreError('E_NOT_FOUND', 'onboarding has no answers to export yet', [
        'Answer the onboarding steps in the app first',
      ]);
    }
    return { profile: exportProfile(row.profile) };
  });

  const setBackup = (
    context: HandlerContext,
    change: (
      backup: NonNullable<OnboardingProfile['workspace']['backup']>,
    ) => NonNullable<OnboardingProfile['workspace']['backup']>,
  ): 'ok' | 'no-op' => {
    const row = readRow(store);
    if (row === undefined) {
      throw new CoreError('E_NOT_FOUND', 'answer the workspace step (S1) first', [
        'The backup answers belong to the workspace step of onboarding',
      ]);
    }
    const before = row.profile.workspace.backup ?? { passphraseSet: false };
    const after = change(before);
    if (
      JSON.stringify(before) === JSON.stringify(after) &&
      row.profile.workspace.backup !== undefined
    ) {
      return 'no-op';
    }
    const now = context.clock.now().toISOString();
    store.command({ actor: context.actor }, (tx) => {
      const profile = { ...row.profile, workspace: { ...row.profile.workspace, backup: after } };
      writeRow(tx, nextRow(row, { profile }, context.actor, now), row);
      tx.event({
        type: 'onboarding.backup_set',
        entity: { kind: 'onboarding', id: ONBOARDING_ID },
        // The destination's label only: no path, bucket or binding in the event log.
        after: {
          passphraseSet: after.passphraseSet,
          destination: after.destination?.label ?? null,
        },
      });
    });
    return 'ok';
  };

  dispatcher.register(methods.backupsDestination, (params, context) => {
    const status = setBackup(context, (backup) => {
      const next = { ...backup };
      if (params.destination === null) delete next.destination;
      else next.destination = params.destination;
      return next;
    });
    return { status };
  });

  dispatcher.register(methods.backupsPassphrase, (_params, context) => {
    const status = setBackup(context, (backup) => ({ ...backup, passphraseSet: true }));
    return { status, passphraseSet: true };
  });
}
