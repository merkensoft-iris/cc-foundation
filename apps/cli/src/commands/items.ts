/**
 * `cc-axi items list | view | create | update | claim | attach | history` (07 §4.2).
 */
import path from 'node:path';

import type { ActionItem, EvidenceInput } from '@cc/schemas';

import { dateValue, flag, listValue, many, positiveInt, single, type Parsed } from '../args.js';
import { usageError } from '../errors.js';
import { countLine, shellArg, table, truncate, type Output } from '../render.js';
import { DEFAULT_LIMIT, ITEM_FIELDS } from '../spec.js';
import {
  actorText,
  deepLink,
  defined,
  refValue,
  workstreamSlug,
  type ClaimResult,
  type EvidenceAddResult,
  type Handler,
  type HistoryResult,
  type ItemMutationResult,
  type ItemResult,
  type ItemsListResult,
} from './common.js';

const BASE_COLUMNS = ['ref', 'title', 'due', 'state'] as const;

function itemRef(parsed: Parsed): string {
  return refValue(parsed.positionals[0] ?? '', 'A');
}

/** "active items owned by you in workstream alderwick due before 2026-11-20". */
function describeItems(filters: {
  state: string;
  owner?: string | undefined;
  workstream?: string | undefined;
  health?: string | undefined;
  dueBefore?: string | undefined;
}): string {
  const parts = [`${filters.state} items`];
  if (filters.owner !== undefined) {
    parts.push(filters.owner === 'me' ? 'owned by you' : `owned by ${filters.owner}`);
  }
  if (filters.workstream !== undefined) parts.push(`in workstream ${filters.workstream}`);
  if (filters.health !== undefined) parts.push(`with health ${filters.health}`);
  if (filters.dueBefore !== undefined) parts.push(`due before ${filters.dueBefore}`);
  return parts.join(' ');
}

export const itemsList: Handler = async (parsed, session) => {
  const workstream = single(parsed, '--workstream');
  const owner = single(parsed, '--owner');
  const state = single(parsed, '--state') ?? 'active';
  const health = single(parsed, '--health');
  const dueBefore = dateValue(parsed, '--due-before');
  const fields = listValue(parsed, '--fields', ITEM_FIELDS) ?? [];
  const limit = positiveInt(parsed, '--limit') ?? DEFAULT_LIMIT;
  const api = await session.api();
  const result = await api.call<ItemsListResult>(
    'items.list',
    defined({
      workstream,
      owner,
      state,
      health,
      dueBefore,
      fields: fields.length > 0 ? fields : undefined,
      limit,
    }),
  );
  const noun = describeItems({ state, owner, workstream, health, dueBefore });
  if (result.items.length === 0) {
    return { items: `0 ${noun}` };
  }
  const help = [`Run \`cc-axi items view <ref>\` for details`];
  if (result.total > result.items.length) {
    help.push(
      `Run \`cc-axi items list${listFlags(parsed)} --limit ${result.total}\` for all ${result.total}`,
    );
  }
  return {
    items: table(result.items, [...BASE_COLUMNS, ...fields]),
    count: countLine(result.items.length, result.total, noun),
    help,
  };
};

/** The filters of this `items list` call, carried into its help lines (07 §4.1 rule 9). */
function listFlags(parsed: Parsed): string {
  const names = ['--workstream', '--owner', '--state', '--health', '--due-before', '--fields'];
  return names
    .flatMap((name) => {
      const value = single(parsed, name);
      return value === undefined ? [] : [` ${name} ${shellArg(value)}`];
    })
    .join('');
}

function evidenceProgress(item: ActionItem): string {
  const required = item.evidenceRequirements.filter((requirement) => requirement.required);
  if (required.length === 0) return 'none required';
  const passed = new Set(
    (item.verification?.checks ?? [])
      .filter((check) => check.status === 'pass')
      .map((check) => check.requirementId),
  );
  const count = required.filter((requirement) => passed.has(requirement.id)).length;
  return `${count}/${required.length} checks passed`;
}

function stepsProgress(item: ActionItem): string | undefined {
  const steps = item.execution.steps;
  if (steps.length === 0) return undefined;
  const done = steps.filter((step) => step.status === 'succeeded' || step.status === 'skipped');
  const open = steps
    .filter((step) => !['succeeded', 'skipped', 'pending', 'ready'].includes(step.status))
    .map((step) => {
      const waitingRef =
        step.status === 'waiting_confirmation' && item.waitingOn?.kind === 'confirmation'
          ? item.waitingOn.ref
          : undefined;
      return [step.id, step.status, waitingRef].filter((part) => part !== undefined).join(' ');
    });
  const detail = open.length > 0 ? ` (${open.join(', ')})` : '';
  return `${done.length}/${steps.length} done${detail}`;
}

export const itemsView: Handler = async (parsed, session) => {
  const ref = itemRef(parsed);
  const full = flag(parsed, '--full');
  const api = await session.api();
  const { item } = await api.call<ItemResult>('items.get', { ref });
  const workstream = await workstreamSlug(api, item.workstreamId);
  let truncated = false;
  const text = (value: string): string => {
    const cut = truncate(value, full);
    truncated ||= cut.truncated;
    return cut.text;
  };
  const view: Output = {
    ref: item.ref,
    title: item.title,
    workstream,
    kind: item.kind,
    owner: item.ownerId,
    due: item.due.time === undefined ? item.due.date : `${item.due.date} ${item.due.time}`,
    state: item.lifecycle,
  };
  if (item.waitingOn !== undefined) {
    view['waiting_on'] = [
      item.waitingOn.kind,
      item.waitingOn.ref,
      `since ${item.waitingOn.since.slice(0, 10)}`,
    ]
      .filter((part) => part !== undefined)
      .join(' ');
  }
  view['health'] = item.health;
  if (item.healthNote !== undefined) view['health_note'] = text(item.healthNote);
  view['done_means'] = text(item.doneMeans);
  view['evidence'] = evidenceProgress(item);
  const steps = stepsProgress(item);
  if (steps !== undefined) view['steps'] = steps;
  view['carry'] = item.carryCount;
  view['source'] = item.source.kind;
  if (item.claim !== undefined) {
    view['claimed'] = `${item.claim.at.slice(0, 10)} by ${actorText(item.claim.by)}`;
    if (item.claim.note !== undefined) view['claim_note'] = text(item.claim.note);
  }
  const output: Output = { item: view };
  // Detail views carry no suggestions unless something was cut (07 §4.1 rules 3 and 9).
  if (truncated)
    output['help'] = [`Run \`cc-axi items view ${item.ref} --full\` for the full text`];
  return output;
};

function itemSummary(item: ActionItem): Output {
  return {
    ref: item.ref,
    title: item.title,
    due: item.due.date,
    state: item.lifecycle,
    health: item.health,
  };
}

export const itemsCreate: Handler = async (parsed, session) => {
  const title = single(parsed, '--title') ?? '';
  if (title.length > 120) {
    throw usageError(`--title is ${title.length} characters; at most 120`, [
      '--title takes a verb and a deliverable, such as "Send the signed SOW to the client"',
    ]);
  }
  const meeting = single(parsed, '--meeting');
  const params = defined({
    workstream: single(parsed, '--workstream'),
    title,
    due: dateValue(parsed, '--due'),
    doneMeans: single(parsed, '--done-means'),
    owner: single(parsed, '--owner'),
    evidence: many(parsed, '--evidence').length > 0 ? [...many(parsed, '--evidence')] : undefined,
    kind: single(parsed, '--kind'),
    meeting: meeting === undefined ? undefined : refValue(meeting, 'M', '--meeting'),
  });
  const api = await session.api();
  const result = await api.call<ItemMutationResult>('items.create', params);
  const ref = result.item.ref;
  return {
    status: result.status,
    item: itemSummary(result.item),
    help: [
      `Run \`cc-axi items view ${ref}\` for details`,
      `The user accepts or drops the draft in the app: ${deepLink('items', ref)}`,
    ],
  };
};

export const itemsUpdate: Handler = async (parsed, session) => {
  const ref = itemRef(parsed);
  const health = single(parsed, '--health');
  const note = single(parsed, '--note');
  const proposeDue = dateValue(parsed, '--propose-due');
  const reason = single(parsed, '--reason');
  if (health === undefined && proposeDue === undefined) {
    throw usageError('nothing to update', [
      'Give --health <health> --note "<text>", or --propose-due <YYYY-MM-DD> --reason "<text>"',
    ]);
  }
  if (note !== undefined && health === undefined) {
    throw usageError('--note goes with --health', ['Give --health <health> --note "<text>"']);
  }
  if ((proposeDue === undefined) !== (reason === undefined)) {
    throw usageError('--propose-due and --reason go together', [
      'Give --propose-due <YYYY-MM-DD> --reason "<text>"',
    ]);
  }
  const api = await session.api();
  const result = await api.call<ItemMutationResult>(
    'items.update',
    defined({
      ref,
      health: health === undefined ? undefined : defined({ value: health, note }),
      proposeDue: proposeDue === undefined ? undefined : { date: proposeDue, reason },
    }),
  );
  const item: Output = itemSummary(result.item);
  if (result.item.healthNote !== undefined)
    item['health_note'] = truncate(result.item.healthNote, false).text;
  return {
    status: result.status,
    item,
    help: [`Run \`cc-axi items view ${result.item.ref}\` for details`],
  };
};

/** `--evidence <url|file:<path>|record:<binding>/<type>/<externalId>>` (07 §4.2). */
export function parseEvidence(value: string, cwd: string): EvidenceInput {
  const format = '--evidence takes <url>, file:<path> or record:<binding>/<type>/<externalId>';
  if (value.startsWith('file:')) {
    const file = value.slice('file:'.length);
    if (file === '') throw usageError(`invalid evidence "${value}"`, [format]);
    return { kind: 'file', path: path.resolve(cwd, file) };
  }
  if (value.startsWith('record:')) {
    const [binding, recordType, ...rest] = value.slice('record:'.length).split('/');
    const externalId = rest.join('/');
    if (
      binding === undefined ||
      binding === '' ||
      recordType === undefined ||
      recordType === '' ||
      externalId === ''
    ) {
      throw usageError(`invalid evidence "${value}"`, [format]);
    }
    return { kind: 'connector_record', binding, recordType, externalId };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw usageError(`invalid evidence "${value}"`, [format]);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw usageError(`invalid evidence "${value}"`, [format]);
  }
  return { kind: 'url', url: value };
}

export const itemsClaim: Handler = async (parsed, session) => {
  const ref = itemRef(parsed);
  const evidence = many(parsed, '--evidence').map((value) => parseEvidence(value, session.cwd));
  const api = await session.api();
  const result = await api.call<ClaimResult>(
    'items.claim',
    defined({ ref, evidence, note: single(parsed, '--note') }),
  );
  const output: Output = {
    status: result.status,
    item: { ref: result.item.ref, title: result.item.title, state: result.item.lifecycle },
    evidence: `${result.evidence.length} on the item; ${evidenceProgress(result.item)}`,
  };
  if (result.status === 'ok') {
    output['help'] = [
      `The user confirms or rejects the claim in the app: ${deepLink('items', result.item.ref)}`,
      `Run \`cc-axi items view ${result.item.ref}\` to follow it`,
    ];
  }
  return output;
};

export const itemsAttach: Handler = async (parsed, session) => {
  const ref = itemRef(parsed);
  const evidence = parseEvidence(single(parsed, '--evidence') ?? '', session.cwd);
  const requirementId = single(parsed, '--requirement');
  const api = await session.api();
  const result = await api.call<EvidenceAddResult>('evidence.add', {
    ref,
    evidence: requirementId === undefined ? evidence : { ...evidence, requirementId },
  });
  const attached: Output = {
    id: result.evidence.id,
    item: ref,
    kind: result.evidence.kind,
    requirement: result.evidence.requirementId ?? null,
    summary: result.evidence.summary,
  };
  return {
    status: result.status,
    evidence: attached,
    help: [`Run \`cc-axi items claim ${ref}\` once every required requirement has evidence`],
  };
};

export const itemsHistory: Handler = async (parsed, session) => {
  const ref = itemRef(parsed);
  const limit = positiveInt(parsed, '--limit') ?? DEFAULT_LIMIT;
  const api = await session.api();
  const result = await api.call<HistoryResult>('items.history', { ref, limit });
  const noun = `events for ${ref}`;
  if (result.events.length === 0) return { events: `0 ${noun}` };
  const rows = result.events.map((event) => ({
    at: event.at,
    type: event.type,
    actor: actorText(event.actor),
  }));
  const help = [`Run \`cc-axi items view ${ref}\` for the item`];
  if (result.total > result.events.length) {
    help.push(
      `Run \`cc-axi items history ${ref} --limit ${result.total}\` for all ${result.total}`,
    );
  }
  return {
    events: table(rows, ['at', 'type', 'actor']),
    count: countLine(result.events.length, result.total, noun),
    help,
  };
};
