/**
 * The onboarding wizard's working state (01 §3, 09 P1-12): the answers as one
 * `OnboardingProfile` being edited, the S7 calendar mapping, and the small add-forms of each
 * step. The answers are saved through `onboarding.save` after every step, so the wizard can be
 * left and resumed; the app keeps the working copy across screen changes (`ui.keep`).
 *
 * Types come from @cc/schemas as types only: the renderer loads no package code (rule D3).
 */
import type {
  CalendarMapping,
  FrameworkRecommendation,
  FrameworkTemplate,
  methods,
  OnboardingProfile,
  OnboardingStep,
  Pack,
  TailoringAnswers,
  WorkstreamAnswers,
} from '@cc/schemas';

import type { Ui } from '../../app/screen.js';
import { h, type Child, type VNode } from '../../ui/vnode.js';
import { question } from './questions.js';

type ResultOf<M extends { result: { parse(value: unknown): unknown } }> = ReturnType<
  M['result']['parse']
>;
export type StatusResult = ResultOf<typeof methods.onboardingStatus>;
export type RecommendResult = ResultOf<typeof methods.onboardingRecommend>;
export type Preview = ResultOf<typeof methods.onboardingPreview>['preview'];
export type Notice = Preview['warnings'][number];

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const WEEKDAY_NAMES: Readonly<Record<Weekday, string>> = {
  MO: 'Mon',
  TU: 'Tue',
  WE: 'Wed',
  TH: 'Thu',
  FR: 'Fri',
  SA: 'Sat',
  SU: 'Sun',
};

/** The add-forms of the steps: what is typed before it joins the answers. */
export interface Forms {
  hours: { start: string; end: string };
  quiet: { start: string; end: string };
  block: {
    label: string;
    days: Weekday[];
    start: string;
    minutes: string;
    policy: 'hard' | 'soft';
  };
  backup: { label: string; path: string; passphrase: string; confirm: string };
  stream: {
    kind: WorkstreamAnswers['kind'];
    name: string;
    key: string;
    parentKey: string;
    principal: 'self' | 'other';
    displayName: string;
    relationship: string;
    consentNote: string;
    principalTimeZone: string;
    timeZone: string;
  };
  measure: Record<
    string,
    {
      name: string;
      role: 'lead' | 'lag';
      unit: string;
      cadence: string;
      op: string;
      value: string;
      value2: string;
      ownerRole: string;
      source: 'manual' | 'derived';
    }
  >;
  goal: Record<
    string,
    {
      title: string;
      ownerRole: string;
      doneMeans: string;
      from: string;
      to: string;
      unit: string;
      by: string;
    }
  >;
  tool: {
    category: string;
    toolName: string;
    workstreamKeys: string[];
    accountLabel: string;
    choice: 'connector' | 'manual' | 'discover' | 'later';
    connectorId: string;
  };
  tracker: { answer: '' | 'jira' | 'linear' | 'sheet'; workstreamKeys: string[] };
  route: { workstreams: string[]; binding: string; calendar: string; role: 'primary' | 'mirror' };
}

export interface Work {
  /** Set once the saved answers were read into it. */
  loaded: boolean;
  profile: OnboardingProfile;
  calendarMapping: CalendarMapping;
  forms: Forms;
  /** The S4 choice per workstream key, before saving. */
  choices: Record<string, string>;
}

export interface WizardState {
  readonly step: OnboardingStep;
  readonly status: StatusResult;
  readonly work: Work;
  readonly recommend?: RecommendResult;
  readonly preview?: Preview;
  /** Why the recommendation or preview could not be computed from the answers so far. */
  readonly problem?: string;
}

/** The host's zone, as a starting answer for S1 (Q2). */
export function hostTimeZone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** A profile with the S1 defaults and nothing else, for a workspace nobody onboarded yet. */
export function emptyProfile(timeZone: string): OnboardingProfile {
  return {
    version: 1,
    completedSteps: [],
    workspace: {
      displayName: 'Main',
      timeZone,
      workweek: ['MO', 'TU', 'WE', 'TH', 'FR'],
      workingHours: [{ start: '09:00', end: '17:30' }],
      protectedBlocks: [],
      weeklyManagementMinutes: 240,
      quietHours: [],
    },
    workstreams: [],
    tools: [],
    ai: { provider: 'none' },
  };
}

export function emptyForms(): Forms {
  return {
    hours: { start: '09:00', end: '17:30' },
    quiet: { start: '22:00', end: '07:00' },
    block: {
      label: '',
      days: ['MO', 'TU', 'WE', 'TH', 'FR'],
      start: '14:00',
      minutes: '60',
      policy: 'hard',
    },
    backup: { label: '', path: '', passphrase: '', confirm: '' },
    stream: {
      kind: 'company',
      name: '',
      key: '',
      parentKey: '',
      principal: 'self',
      displayName: '',
      relationship: '',
      consentNote: '',
      principalTimeZone: '',
      timeZone: '',
    },
    measure: {},
    goal: {},
    tool: {
      category: 'email',
      toolName: '',
      workstreamKeys: [],
      accountLabel: '',
      choice: 'manual',
      connectorId: '',
    },
    tracker: { answer: '', workstreamKeys: [] },
    route: { workstreams: [], binding: '', calendar: '', role: 'primary' },
  };
}

/** A lower-case slug for a workstream key: "Alderwick Ltd" → "alderwick-ltd". */
export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The S3 answers a new workstream starts with, changed at S3. */
export function newWorkstream(
  fields: Pick<WorkstreamAnswers, 'key' | 'kind' | 'name' | 'principal'> &
    Partial<Pick<WorkstreamAnswers, 'parentKey' | 'timeZone'>>,
): WorkstreamAnswers {
  return {
    ...fields,
    headcount: 1,
    leadershipGroupSize: 1,
    hasTeamsUnderLeads: false,
    stage: fields.kind === 'company' ? 'early_revenue' : 'n_a',
    businessType: fields.kind === 'company' ? 'services' : 'n_a',
    primaryGoal: fields.kind === 'job_search' ? 'land_role' : 'other',
    goalShape: 'few_priorities',
    existingFramework: 'none',
    weightPreference: 'light',
    confidentiality: 'normal',
  };
}

/** Q-T07 and Q-T08 defaults (01 §8). */
export function defaultTailoring(
  key: string,
  aiDataPolicy: TailoringAnswers['aiDataPolicy'],
): TailoringAnswers {
  return {
    workstreamKey: key,
    parameters: {},
    merge: true,
    measures: [],
    goals: [],
    owners: { '*': 'self' },
    verification: {
      policy: 'require_review',
      autoCloseOn: ['calendar_event', 'measure_threshold'],
    },
    escalation: { e2CarryCount: 2, e3CarryCount: 4, e3OverdueDays: 30 },
    aiDataPolicy,
    informRoles: [],
  };
}

/** The recommendation of a workstream that gets its own instance (not an R5 child). */
export function ownInstance(rec: FrameworkRecommendation): boolean {
  return rec.firedRules[0] !== 'R5';
}

/** The template a workstream runs: its S4 choice, or the recommendation. */
export function chosenTemplate(
  work: Work,
  rec: FrameworkRecommendation,
  templates: readonly FrameworkTemplate[],
): FrameworkTemplate | undefined {
  const id =
    work.choices[rec.workstreamKey] ??
    work.profile.accepted?.find((a) => a.workstreamKey === rec.workstreamKey)?.templateId ??
    rec.templateId;
  return templates.find((template) => template.id === id);
}

/** The tailoring answers of a workstream, made with the defaults on first use. */
export function tailoringOf(work: Work, rec: FrameworkRecommendation): TailoringAnswers {
  const all = (work.profile.tailoring ??= []);
  let found = all.find((entry) => entry.workstreamKey === rec.workstreamKey);
  if (found === undefined) {
    found = defaultTailoring(rec.workstreamKey, rec.aiDataPolicy);
    all.push(found);
  }
  return found;
}

export function packsOf(rec: FrameworkRecommendation, packs: readonly Pack[]): Pack[] {
  return packs.filter((pack) => rec.packIds.includes(pack.id));
}

/** One question of 01 §3.1, tagged `q-<row>` for the tests: its number, text and controls. */
export function ask(row: number, ...children: Child[]): VNode {
  const entry = question(row);
  return h(
    'div',
    { class: 'question', test: `q-${String(row)}` },
    h(
      'p',
      { class: 'question-text' },
      `${String(row)}. ${entry.text}`,
      entry.appOnly === true ? ' (app only)' : '',
    ),
    ...children,
  );
}

/** A number typed into a field, or the fallback when it is not one. */
export function numberOf(text: string, fallback: number): number {
  const value = Number(text);
  return text.trim() === '' || !Number.isFinite(value) ? fallback : value;
}

/** `FREQ=WEEKLY;BYDAY=MO,TU;BYHOUR=9;BYMINUTE=45` → days and "09:45". */
export function readWeeklyRule(rrule: string): { days: Weekday[]; time: string } {
  const parts = new Map(
    rrule.split(';').map((part) => part.split('=') as [string, string | undefined]),
  );
  const days = (parts.get('BYDAY') ?? '')
    .split(',')
    .filter((day): day is Weekday => (WEEKDAYS as readonly string[]).includes(day));
  const hour = (parts.get('BYHOUR') ?? '0').padStart(2, '0');
  const minute = (parts.get('BYMINUTE') ?? '0').padStart(2, '0');
  return { days, time: `${hour}:${minute}` };
}

export function weeklyRule(days: readonly Weekday[], time: string): string {
  const [hour, minute] = time.split(':').map(Number);
  return `FREQ=WEEKLY;BYDAY=${days.join(',')};BYHOUR=${String(hour ?? 0)};BYMINUTE=${String(minute ?? 0)}`;
}

/** The next step in S1 to S9 order. */
export function nextStep(step: OnboardingStep, steps: readonly OnboardingStep[]): OnboardingStep {
  return steps[Math.min(steps.indexOf(step) + 1, steps.length - 1)] ?? step;
}

/** Saves the answers so far, marking `step` answered, then opens `next` (01 §3: persist after every step). */
export async function saveStep(
  ui: Ui,
  work: Work,
  step: OnboardingStep | undefined,
  next: OnboardingStep,
): Promise<boolean> {
  try {
    await ui.call('onboarding.save', {
      profile: work.profile,
      ...(work.calendarMapping.routes.length === 0
        ? {}
        : { calendarMapping: work.calendarMapping }),
      ...(step === undefined ? {} : { step }),
    });
    if (step !== undefined && !work.profile.completedSteps.includes(step)) {
      work.profile.completedSteps = [...work.profile.completedSteps, step];
    }
  } catch (error) {
    ui.flash(
      typeof error === 'object' && error !== null && 'message' in error
        ? String((error as { message: unknown }).message)
        : 'The answers could not be saved',
      'error',
    );
    return false;
  }
  ui.go({ screen: 'onboarding', step: next });
  return true;
}
