/**
 * What every command handler gets, and the small helpers they share.
 */
import type { LocalApiClient } from '@cc/core/client';
import type { methods } from '@cc/schemas';

import type { Globals, Parsed } from '../args.js';
import { usageError } from '../errors.js';
import type { Output } from '../render.js';

/** The output type of a local API method, read from its schema in @cc/schemas. */
export type ResultOf<M extends { result: { parse(value: unknown): unknown } }> = ReturnType<
  M['result']['parse']
>;

export type HomeResult = ResultOf<typeof methods.homeGet>;
export type ItemsListResult = ResultOf<typeof methods.itemsList>;
export type ItemResult = ResultOf<typeof methods.itemsGet>;
export type ItemMutationResult = ResultOf<typeof methods.itemsCreate>;
export type ClaimResult = ResultOf<typeof methods.itemsClaim>;
export type EvidenceAddResult = ResultOf<typeof methods.evidenceAdd>;
export type HistoryResult = ResultOf<typeof methods.itemsHistory>;
export type SearchResult = ResultOf<typeof methods.searchQuery>;
export type DecisionsListResult = ResultOf<typeof methods.decisionsList>;
export type DecisionResult = ResultOf<typeof methods.decisionsGet>;
export type DecisionMutationResult = ResultOf<typeof methods.decisionsPropose>;
export type IssuesListResult = ResultOf<typeof methods.issuesList>;
export type IssueResult = ResultOf<typeof methods.issuesGet>;
export type IssueMutationResult = ResultOf<typeof methods.issuesRaise>;
export type MeasuresListResult = ResultOf<typeof methods.measuresList>;
export type MeasureRecordResult = ResultOf<typeof methods.measuresRecord>;
export type GoalsListResult = ResultOf<typeof methods.goalsList>;
export type WorkstreamsListResult = ResultOf<typeof methods.workstreamsList>;
export type WorkstreamResult = ResultOf<typeof methods.workstreamsGet>;

export interface Session {
  readonly globals: Globals;
  /** Connects on first use, so `--help` and usage errors never need the app. */
  api(): Promise<LocalApiClient>;
  /** The working directory, for `file:` evidence paths. */
  readonly cwd: string;
}

export type Handler = (parsed: Parsed, session: Session) => Promise<Output>;

/** Deep links of 04 §4.3 that open the right screen in the app. */
export function deepLink(kind: 'items' | 'decisions' | 'issues', ref: string): string {
  return `commandcenter://${kind}/${ref}`;
}

const REF_KINDS = {
  A: { prefix: 'act', list: 'cc-axi items list' },
  D: { prefix: 'dec', list: 'cc-axi decisions list' },
  I: { prefix: 'iss', list: 'cc-axi issues list' },
  K: { prefix: 'msr', list: 'cc-axi measures list' },
  M: { prefix: 'mtg', list: 'cc-axi search "<text>" --types meetings' },
} as const;

/** Checks a HumanRef (`A-0142`) or ID (`act_...`) argument before any API call. */
export function refValue(value: string, letter: keyof typeof REF_KINDS, what = 'ref'): string {
  const { prefix, list } = REF_KINDS[letter];
  if (
    new RegExp(`^${letter}-\\d{4,}$`).test(value) ||
    new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(value)
  ) {
    return value;
  }
  throw usageError(`invalid ${what} "${value}"`, [
    `Refs look like ${letter}-0142 or ${prefix}_...; run \`${list}\` to find one`,
  ]);
}

/** Who did something, in one word: `user`, `agent:agt_cli`, `system:scheduler`. */
export function actorText(actor: { kind: string; [key: string]: unknown }): string {
  switch (actor.kind) {
    case 'agent':
      return `agent:${String(actor['principalId'])}`;
    case 'connector':
      return `connector:${String(actor['bindingId'])}`;
    case 'system':
      return `system:${String(actor['component'])}`;
    default:
      return actor.kind;
  }
}

/** Drops undefined values, so optional API parameters are left out rather than sent empty. */
export function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/** The slug of a workstream ID, or the ID itself when it cannot be read. */
export async function workstreamSlug(api: LocalApiClient, id: string): Promise<string> {
  try {
    const result = await api.call<WorkstreamResult>('workstreams.get', { workstream: id });
    return result.workstream.slug;
  } catch {
    return id;
  }
}

/** ` --workstream alderwick` when the list was filtered by it, so help lines carry it forward (07 §4.1 rule 9). */
export function workstreamSuffix(workstream: string | undefined): string {
  return workstream === undefined ? '' : ` --workstream ${workstream}`;
}
