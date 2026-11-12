/**
 * `cc-axi decisions | issues | measures | goals | workstreams` (07 §4.2).
 */
import { dateValue, many, positiveInt, single, type Parsed } from '../args.js';
import { usageError } from '../errors.js';
import { countLine, table, type Output } from '../render.js';
import { DEFAULT_LIMIT } from '../spec.js';
import {
  actorText,
  deepLink,
  defined,
  refValue,
  workstreamSlug,
  workstreamSuffix,
  type DecisionMutationResult,
  type DecisionResult,
  type DecisionsListResult,
  type GoalsListResult,
  type Handler,
  type IssueMutationResult,
  type IssueResult,
  type IssuesListResult,
  type MeasureRecordResult,
  type MeasuresListResult,
  type WorkstreamResult,
  type WorkstreamsListResult,
} from './common.js';

function inWorkstream(workstream: string | undefined): string {
  return workstream === undefined ? '' : ` in workstream ${workstream}`;
}

function limitOf(parsed: Parsed): number {
  return positiveInt(parsed, '--limit') ?? DEFAULT_LIMIT;
}

/** The help of a non-empty list: how to view a row, and how to see every row (07 §4.1 rule 9). */
function listHelp(view: string, again: string, shown: number, total: number): string[] {
  const help = [view];
  if (total > shown) help.push(`Run \`${again} --limit ${total}\` for all ${total}`);
  return help;
}

// decisions

export const decisionsList: Handler = async (parsed, session) => {
  const workstream = single(parsed, '--workstream');
  const status = single(parsed, '--status');
  const api = await session.api();
  const result = await api.call<DecisionsListResult>(
    'decisions.list',
    defined({ workstream, status, limit: limitOf(parsed) }),
  );
  const noun = `${status === undefined ? '' : `${status} `}decisions${inWorkstream(workstream)}`;
  if (result.decisions.length === 0) return { decisions: `0 ${noun}` };
  const rows = result.decisions.map((decision) => ({
    ref: decision.ref,
    question: decision.question,
    status: decision.status,
    due_by: decision.dueBy ?? null,
  }));
  const again = `cc-axi decisions list${workstreamSuffix(workstream)}${status === undefined ? '' : ` --status ${status}`}`;
  return {
    decisions: table(rows, ['ref', 'question', 'status', 'due_by']),
    count: countLine(rows.length, result.total, noun),
    help: listHelp(
      'Run `cc-axi decisions view <ref>` for details',
      again,
      rows.length,
      result.total,
    ),
  };
};

export const decisionsView: Handler = async (parsed, session) => {
  const ref = refValue(parsed.positionals[0] ?? '', 'D');
  const api = await session.api();
  const { decision } = await api.call<DecisionResult>('decisions.get', { ref });
  const view: Output = {
    ref: decision.ref,
    question: decision.question,
    workstream: await workstreamSlug(api, decision.workstreamId),
    status: decision.status,
    decider: decision.deciderId,
    reversibility: decision.reversibility,
  };
  if (decision.driverId !== undefined) view['driver'] = decision.driverId;
  if (decision.dueBy !== undefined) view['due_by'] = decision.dueBy;
  view['options'] =
    decision.options.length === 0
      ? '0 options proposed'
      : table(
          decision.options.map((option) => ({
            id: option.id,
            text: option.text,
            by: actorText(option.proposedBy),
          })),
          ['id', 'text', 'by'],
        );
  if (decision.recommendation !== undefined) {
    view['recommendation'] =
      `${decision.recommendation.optionId}: ${decision.recommendation.rationale}`;
  }
  if (decision.outcome !== undefined) {
    view['outcome'] = decision.outcome.text;
    view['why'] = decision.outcome.why;
    view['decided_at'] = decision.outcome.decidedAt;
  }
  if (decision.dropReason !== undefined) view['drop_reason'] = decision.dropReason;
  view['action_items'] = decision.actionItemIds.length;
  return { decision: view };
};

export const decisionsPropose: Handler = async (parsed, session) => {
  const options = many(parsed, '--option');
  const api = await session.api();
  const result = await api.call<DecisionMutationResult>(
    'decisions.propose',
    defined({
      workstream: single(parsed, '--workstream'),
      question: single(parsed, '--question'),
      options: options.length > 0 ? [...options] : undefined,
      decider: single(parsed, '--decider'),
      reversibility: single(parsed, '--reversibility'),
      dueBy: dateValue(parsed, '--due-by'),
    }),
  );
  const { decision } = result;
  return {
    status: result.status,
    decision: {
      ref: decision.ref,
      question: decision.question,
      status: decision.status,
      decider: decision.deciderId,
      options: decision.options.length,
    },
    help: [
      `Run \`cc-axi decisions view ${decision.ref}\` for details`,
      `Only its decider decides it, in the app: ${deepLink('decisions', decision.ref)}`,
    ],
  };
};

// issues

export const issuesList: Handler = async (parsed, session) => {
  const workstream = single(parsed, '--workstream');
  const status = single(parsed, '--status');
  const api = await session.api();
  const result = await api.call<IssuesListResult>(
    'issues.list',
    defined({ workstream, status, limit: limitOf(parsed) }),
  );
  const noun = `${status === undefined ? '' : `${status} `}issues${inWorkstream(workstream)}`;
  if (result.issues.length === 0) return { issues: `0 ${noun}` };
  const again = `cc-axi issues list${workstreamSuffix(workstream)}${status === undefined ? '' : ` --status ${status}`}`;
  return {
    issues: table(result.issues, ['ref', 'title', 'status', 'rank']),
    count: countLine(result.issues.length, result.total, noun),
    help: listHelp(
      'Run `cc-axi issues view <ref>` for details',
      again,
      result.issues.length,
      result.total,
    ),
  };
};

export const issuesView: Handler = async (parsed, session) => {
  const ref = refValue(parsed.positionals[0] ?? '', 'I');
  const api = await session.api();
  const { issue } = await api.call<IssueResult>('issues.get', { ref });
  const view: Output = {
    ref: issue.ref,
    title: issue.title,
    workstream: await workstreamSlug(api, issue.workstreamId),
    status: issue.status,
    raised_from: issue.raisedFrom.kind,
  };
  if (issue.rank !== undefined) view['rank'] = issue.rank;
  if (issue.resolution !== undefined) {
    view['resolution'] = {
      kind: issue.resolution.kind,
      refs: issue.resolution.refs,
      note: issue.resolution.note,
      at: issue.resolution.at,
    };
  }
  return { issue: view };
};

export const issuesRaise: Handler = async (parsed, session) => {
  const api = await session.api();
  const result = await api.call<IssueMutationResult>('issues.raise', {
    workstream: single(parsed, '--workstream'),
    title: single(parsed, '--title'),
  });
  return {
    status: result.status,
    issue: { ref: result.issue.ref, title: result.issue.title, status: result.issue.status },
    help: [`Run \`cc-axi issues view ${result.issue.ref}\` for details`],
  };
};

// measures

const OPS: Record<string, string> = { gte: '>=', lte: '<=', eq: '=', between: 'between' };

function targetText(
  target: { op: string; value: number | boolean; value2?: number | undefined },
  unit: string,
): string {
  const value =
    target.op === 'between'
      ? `${String(target.value)} and ${String(target.value2)}`
      : String(target.value);
  return `${OPS[target.op] ?? target.op} ${value}${unit === 'boolean' ? '' : ` ${unit}`}`;
}

export const measuresList: Handler = async (parsed, session) => {
  const workstream = single(parsed, '--workstream');
  const api = await session.api();
  const result = await api.call<MeasuresListResult>(
    'measures.list',
    defined({ workstream, limit: limitOf(parsed) }),
  );
  const noun = `measures${inWorkstream(workstream)}`;
  if (result.measures.length === 0) return { measures: `0 ${noun}` };
  const rows = result.measures.map((measure) => ({
    ref: measure.ref,
    name: measure.name,
    target: targetText(measure.target, measure.unit),
    latest:
      measure.latest === undefined
        ? 'none'
        : `${String(measure.latest.value)} for ${measure.latest.periodStart}${measure.latest.normal === false ? ' (not normal)' : ''}`,
  }));
  return {
    measures: table(rows, ['ref', 'name', 'target', 'latest']),
    count: countLine(rows.length, result.total, noun),
    help: listHelp(
      'Run `cc-axi measures record <ref> --value <v>` to record a value',
      `cc-axi measures list${workstreamSuffix(workstream)}`,
      rows.length,
      result.total,
    ),
  };
};

export const measuresRecord: Handler = async (parsed, session) => {
  const ref = refValue(parsed.positionals[0] ?? '', 'K');
  const raw = single(parsed, '--value') ?? '';
  let value: number | boolean;
  if (raw === 'true' || raw === 'false') value = raw === 'true';
  else if (/^-?\d+(?:\.\d+)?$/.test(raw)) value = Number(raw);
  else
    throw usageError(`invalid value "${raw}" for --value`, [
      '--value takes a number, or true or false',
    ]);
  const api = await session.api();
  const result = await api.call<MeasureRecordResult>(
    'measures.record',
    defined({ ref, value, period: dateValue(parsed, '--period'), note: single(parsed, '--note') }),
  );
  return {
    status: result.status,
    value: {
      measure: ref,
      period: result.value.periodStart,
      value: result.value.value,
      normal: result.value.normal,
    },
    help: ['Run `cc-axi measures list` for the scorecard'],
  };
};

// goals

export const goalsList: Handler = async (parsed, session) => {
  const workstream = single(parsed, '--workstream');
  const period = single(parsed, '--period');
  const api = await session.api();
  const result = await api.call<GoalsListResult>(
    'goals.list',
    defined({ workstream, period, limit: limitOf(parsed) }),
  );
  const noun = `goals in the ${period ?? 'current'} period${inWorkstream(workstream)}`;
  if (result.goals.length === 0) return { goals: `0 ${noun}` };
  const again = `cc-axi goals list${workstreamSuffix(workstream)}${period === undefined ? '' : ` --period ${period}`}`;
  return {
    goals: table(result.goals, ['ref', 'title', 'status', 'health']),
    count: countLine(result.goals.length, result.total, noun),
    help: listHelp(
      `Run \`cc-axi items list${workstreamSuffix(workstream)}\` for the work behind them`,
      again,
      result.goals.length,
      result.total,
    ),
  };
};

// workstreams

export const workstreamsList: Handler = async (parsed, session) => {
  const api = await session.api();
  const result = await api.call<WorkstreamsListResult>('workstreams.list', {
    limit: limitOf(parsed),
  });
  if (result.workstreams.length === 0) return { workstreams: '0 workstreams' };
  return {
    workstreams: table(result.workstreams, ['slug', 'name', 'kind', 'status']),
    count: countLine(result.workstreams.length, result.total, 'workstreams'),
    help: listHelp(
      'Run `cc-axi workstreams view <slug>` for details',
      'cc-axi workstreams list',
      result.workstreams.length,
      result.total,
    ),
  };
};

export const workstreamsView: Handler = async (parsed, session) => {
  const slug = parsed.positionals[0] ?? '';
  if (!/^(?:[a-z0-9][a-z0-9-]*|ws_[A-Za-z0-9_]+)$/.test(slug)) {
    throw usageError(`invalid workstream "${slug}"`, [
      'Workstreams are lower-case slugs such as alderwick; run `cc-axi workstreams list`',
    ]);
  }
  const api = await session.api();
  const { workstream } = await api.call<WorkstreamResult>('workstreams.get', { workstream: slug });
  return {
    workstream: {
      slug: workstream.slug,
      name: workstream.name,
      kind: workstream.kind,
      status: workstream.status,
      time_zone: workstream.timeZone,
      privacy: workstream.privacy,
      ai_data_policy: workstream.aiDataPolicy,
      repo_paths: workstream.repoPaths,
    },
  };
};
