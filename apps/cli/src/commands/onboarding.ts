/**
 * `cc-axi onboarding status | recommend | apply | export` (07 §4.2, 01 §3, §9.1; 09 P1-12).
 *
 * Onboarding works without prompts from the command line (01 §1 item 6, C-01-07): `apply
 * --file profile.json` takes a whole `OnboardingProfile` and `--dry-run` previews every record
 * and outward action without writing anything (AC-01-06). The file is read here and sent as the
 * method's params; the core checks it like any other answers. Committing needs the
 * `onboarding:apply` scope, which the user grants in Settings → Agent access (07 §5 rule 3).
 * The app-only answers (backup passphrase and destination, the first calendar batch, sign-ins)
 * stay in the app (01 §3.1 rows 9, 10, 66 and 67).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import type { methods } from '@cc/schemas';

import { flag, single } from '../args.js';
import { usageError } from '../errors.js';
import type { Handler, ResultOf, Session } from './common.js';

type StatusResult = ResultOf<typeof methods.onboardingStatus>;
type RecommendResult = ResultOf<typeof methods.onboardingRecommend>;
type PreviewResult = ResultOf<typeof methods.onboardingPreview>;
type ApplyResult = ResultOf<typeof methods.onboardingApply>;
type ExportResult = ResultOf<typeof methods.onboardingExport>;
type Preview = PreviewResult['preview'];

function pathOf(session: Session, file: string): string {
  return isAbsolute(file) ? file : resolve(session.cwd, file);
}

/** Reads `--file` as JSON; the core validates it as an OnboardingProfile (C-01-07). */
function readProfile(session: Session, file: string | undefined): unknown {
  if (file === undefined) throw usageError('--file <profile.json> is required');
  const path = pathOf(session, file);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw usageError(`cannot read ${file}`, ['--file names a profile.json the CLI can read']);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw usageError(`${file} is not JSON`, ['A profile.json is one OnboardingProfile (01 §4)']);
  }
}

const words = (values: readonly string[]): string => values.join(' ');

/** The preview as TOON reads best: one row per record, lists joined into one cell. */
function previewOutput(preview: Preview) {
  return {
    today: preview.today,
    rhythm_starts_on: preview.rhythmStartsOn,
    workspace: {
      name: preview.workspace.displayName,
      time_zone: preview.workspace.timeZone,
      weekly_budget_minutes: preview.workspace.weeklyManagementMinutes,
    },
    persons: preview.persons.map((person) => ({
      role: person.role,
      name: person.name,
      principal_of: words(person.principalOf),
    })),
    workstreams: preview.workstreams.map((workstream) => ({
      key: workstream.key,
      kind: workstream.kind,
      parent: workstream.parent ?? '',
      framework: workstream.framework ?? (workstream.parent === undefined ? 'none' : 'parent'),
      privacy: workstream.privacy,
      ai_data_policy: workstream.aiDataPolicy,
    })),
    framework_instances: preview.frameworkInstances.map((instance) => ({
      workstream: instance.workstream,
      template: `${instance.templateId} ${instance.templateVersion}`,
      mode: instance.mode,
      goal_model: instance.goalModel,
      packs: words(instance.packs),
      fired_rules: words(instance.firedRules),
    })),
    measures: preview.measures.map((measure) => ({
      ref: measure.ref,
      workstreams: words(measure.workstreams),
      name: measure.name,
      role: measure.role,
      unit: measure.unit,
      target: measure.target,
    })),
    goals: preview.goals.map((goal) => ({
      ref: goal.ref,
      workstream: goal.workstream,
      kind: goal.kind,
      title: goal.title,
      period: goal.period,
    })),
    series: preview.series.map((series) => ({
      name: series.name,
      cadence: series.cadence,
      rrule: series.rrule,
      first: series.dtstart,
      minutes: series.durationMinutes,
      workstreams: words(series.workstreams),
      absorbs: series.absorbs ?? '',
    })),
    meetings: {
      count: preview.instances.count,
      first: preview.instances.first ?? '',
      last: preview.instances.last ?? '',
    },
    time_budget: {
      average_weekly_minutes: preview.timeBudget.averageWeeklyMinutes,
      budget: preview.timeBudget.weeklyManagementMinutes,
    },
    warnings: preview.warnings.map((warning) => `${warning.code}: ${warning.text}`),
    blockers: preview.blockers.map(
      (blocker) => `${blocker.code}: ${[blocker.text, ...blocker.help].join(' ')}`,
    ),
    outward_actions: preview.outwardActions.map((action) => `${action.kind}: ${action.text}`),
  };
}

export const onboardingStatus: Handler = async (_parsed, session) => {
  const api = await session.api();
  const status = await api.call<StatusResult>('onboarding.status', {});
  return {
    onboarding: {
      state: status.state,
      completed_steps: words(status.completedSteps),
      next_step: status.nextStep ?? '',
      committed_at: status.committedAt ?? '',
      workstreams: status.workstreams,
    },
    app_only: status.appOnly.map((answer) => ({
      row: answer.row,
      question: answer.question,
      answered: answer.answered,
    })),
  };
};

export const onboardingRecommend: Handler = async (parsed, session) => {
  const profile = readProfile(session, single(parsed, '--file'));
  const api = await session.api();
  const result = await api.call<RecommendResult>('onboarding.recommend', { profile });
  return {
    recommendations: result.recommendations.map((recommendation) => ({
      workstream: recommendation.workstreamKey,
      template: recommendation.templateId,
      mode: recommendation.mode,
      packs: words(recommendation.packIds),
      fired_rules: words(recommendation.firedRules),
      merge_group: recommendation.mergeGroup ?? '',
      privacy: recommendation.privacy,
      alternatives: words(recommendation.alternatives.map((alternative) => alternative.templateId)),
    })),
    rationale: result.recommendations.flatMap((recommendation) =>
      recommendation.rationale.map((line) => `${recommendation.workstreamKey}: ${line}`),
    ),
    warnings: result.recommendations.flatMap((recommendation) =>
      recommendation.warnings.map(
        (warning) => `${recommendation.workstreamKey}: ${warning.code}: ${warning.text}`,
      ),
    ),
  };
};

export const onboardingApply: Handler = async (parsed, session) => {
  const file = single(parsed, '--file');
  const profile = readProfile(session, file);
  const api = await session.api();
  if (flag(parsed, '--dry-run')) {
    const { preview } = await api.call<PreviewResult>('onboarding.preview', { profile });
    const blocked = preview.blockers.length > 0;
    return {
      status: 'ok',
      dry_run: true,
      wrote: 'nothing',
      ...previewOutput(preview),
      help: [
        blocked
          ? 'Answer the blockers above in the profile, then run the dry run again'
          : `Run \`cc-axi onboarding apply --file ${file ?? ''}\` to commit; it needs the onboarding:apply scope (Settings → Agent access)`,
      ],
    };
  }
  const result = await api.call<ApplyResult>('onboarding.apply', { profile });
  return {
    status: result.status,
    committed_at: result.committedAt,
    ...previewOutput(result.preview),
    help: [
      'Calendar writes and sign-ins wait for their own confirmations in the app (C-01-01)',
      'Set the backup passphrase and destination in the app (01 §3.1 rows 9 and 10)',
      'Run `cc-axi meetings list` or `cc-axi home` to see the rhythm',
    ],
  };
};

export const onboardingExport: Handler = async (parsed, session) => {
  const out = single(parsed, '--out');
  if (out === undefined) throw usageError('--out <profile.json> is required');
  const path = pathOf(session, out);
  if (!existsSync(dirname(path))) {
    throw usageError(`the directory of ${out} does not exist`, [
      'Create it first, or pick another --out',
    ]);
  }
  const api = await session.api();
  const { profile } = await api.call<ExportResult>('onboarding.export', {});
  const text = `${JSON.stringify(profile, null, 2)}\n`;
  let same: boolean;
  try {
    same = readFileSync(path, 'utf8') === text;
  } catch {
    same = false;
  }
  if (!same) {
    // Written whole or not at all: a temporary file renamed over the target.
    const temp = join(dirname(path), `.${String(process.pid)}.profile.tmp`);
    writeFileSync(temp, text, { mode: 0o644 });
    renameSync(temp, path);
  }
  return {
    status: same ? 'no-op' : 'ok',
    out,
    workstreams: profile.workstreams.length,
    help: [
      'Review the file before committing it: it holds answers only, no records, secrets or person names (01 §9.1)',
      `Rebuild a workspace from it with \`cc-axi onboarding apply --file ${out}\``,
    ],
  };
};
