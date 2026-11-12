/**
 * Local API methods (docs/design/04-platform.md §4.1): JSON-RPC 2.0, `<namespace>.<verb>`,
 * parameters and results validated with these schemas. `pnpm cc:gen` writes one JSON Schema
 * per method to packages/schemas/api/<method>.json.
 *
 * 04 §4.1 names the methods; their parameters follow the `cc-axi` flags of 07 §4.2 (the CLI,
 * MCP and AI layer call the same handlers, C-07-03), results carry the records of 03 §5, and
 * list results carry the minimal summaries and total counts of 07 §4.1 rules 2 and 4.
 *
 * The namespaces in `pendingNamespaces` return records specified outside 03 §5 (meetings,
 * connectors, sessions, confirmations, onboarding, development requests, backups). Their
 * methods are added here by the build steps named there, with their record types.
 */
import { z } from 'zod';

import { ActionItem, ActionKind, Lifecycle } from '../records/action-item.js';
import { AgentPrincipal, PrincipalName, type Scope } from '../records/agent-principal.js';
import { HumanRef, humanRef, LocalDate, LocalTime, Health } from '../records/common.js';
import { Decision, DecisionStatus } from '../records/decision.js';
import { DomainEvent } from '../records/event.js';
import { Evidence } from '../records/evidence.js';
import { Goal, GoalKind } from '../records/goal.js';
import { Issue } from '../records/issue.js';
import { Measure, MeasureValue } from '../records/measure.js';
import { Slug, Workstream, WorkstreamKind } from '../records/workstream.js';
import { Limit, MutationStatus, PersonRef, recordRef, WorkstreamRef } from './common.js';

export interface ApiMethod<P extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType> {
  /** `<namespace>.<verb>`. */
  readonly method: string;
  /** Where the method and its fields are specified. */
  readonly spec: string;
  /** One sentence, used in the generated schema and later in tool definitions (07 §7). */
  readonly description: string;
  /**
   * The principal scope a CLI or MCP caller needs (07 §5). Absent when no scope applies:
   * `auth.hello` runs before authentication, and human-only methods are refused to every
   * principal with E_HUMAN_REQUIRED.
   */
  readonly scope?: Scope;
  /** Human-only (04 §4.3): only the app UI may call it; never the CLI, MCP or AI layer. */
  readonly humanOnly: boolean;
  readonly params: P;
  readonly result: R;
}

function method<P extends z.ZodType, R extends z.ZodType>(
  definition: ApiMethod<P, R>,
): ApiMethod<P, R> {
  return definition;
}

const ItemRef = recordRef('A', 'act');
const DecisionRef = recordRef('D', 'dec');
const IssueRef = recordRef('I', 'iss');
const MeasureRef = recordRef('K', 'msr');
const GoalRef = recordRef('G', 'goal');

/** In lists, `overdue` when the due date has passed and the item is not claimed (07 §4.3). */
export const DisplayState = z.union([Lifecycle, z.literal('overdue')]);
export type DisplayState = z.infer<typeof DisplayState>;

/** A list row: `ref,title,due,state`, plus the fields `--fields` adds (07 §4.1 rule 2). */
export const ItemSummary = z.strictObject({
  ref: humanRef('A'),
  title: z.string(),
  due: LocalDate,
  state: DisplayState,
  owner: z.string().optional(),
  health: Health.optional(),
  carry: z.int().min(0).optional(),
  workstream: Slug.optional(),
});
export type ItemSummary = z.infer<typeof ItemSummary>;

/** The optional fields of an item row (07 §4.1 rule 2). */
export const ItemField = z.enum(['owner', 'health', 'carry', 'workstream']);

/**
 * Evidence handed in with a claim or attached on its own: the `--evidence` forms of 07 §4.2
 * (`<url>`, `file:<path>`, `record:<binding>/<type>/<externalId>`), plus a note, which only
 * the user's attestation path accepts (03 §13.3).
 */
const evidenceBase = {
  /** The evidence requirement it answers, such as "er1". */
  requirementId: z.string().min(1).optional(),
  /** At most 200 characters (03 §5.9); the core writes one when absent. */
  summary: z.string().min(1).max(200).optional(),
};
export const EvidenceInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('url'), url: z.url(), ...evidenceBase }),
  z.strictObject({ kind: z.literal('file'), path: z.string().min(1), ...evidenceBase }),
  z.strictObject({
    kind: z.literal('connector_record'),
    /** The binding's label (as the CLI writes it) or its bnd_ ID. */
    binding: z.string().min(1),
    recordType: z.string().min(1),
    externalId: z.string().min(1),
    ...evidenceBase,
  }),
  z.strictObject({ kind: z.literal('note'), text: z.string().min(1), ...evidenceBase }),
]);
export type EvidenceInput = z.infer<typeof EvidenceInput>;

// auth

/** A random value of at least 128 bits, base64url (ADR 0002 decision 6). */
const Nonce = z
  .string()
  .regex(/^[A-Za-z0-9_-]{22,128}$/)
  .describe('Random nonce, base64url, at least 128 bits');

/** HMAC-SHA-256, base64url (ADR 0002 decision 6). */
const Proof = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .describe('HMAC-SHA-256 proof, base64url');

export const authHello = method({
  method: 'auth.hello',
  spec: '04 §4.2 rule 1, 07 §5, ADR 0002 decision 6',
  description:
    'Starts authentication as an agent principal; the server first proves it knows the token.',
  humanOnly: false,
  params: z.strictObject({ principal: PrincipalName, nonce: Nonce }),
  result: z.strictObject({
    serverNonce: Nonce,
    /** HMAC over the client nonce and the server nonce, keyed with the principal's token. */
    serverProof: Proof,
  }),
});

export const authProve = method({
  method: 'auth.prove',
  spec: '04 §4.2 rule 1, ADR 0002 decision 6',
  description:
    "Completes authentication with the client's proof; every other method needs it first.",
  humanOnly: false,
  params: z.strictObject({ proof: Proof }),
  result: z.strictObject({
    principal: AgentPrincipal.pick({
      id: true,
      name: true,
      kind: true,
      scopes: true,
      workstreamFilter: true,
      sensitiveAccess: true,
    }),
  }),
});

// home

export const homeGet = method({
  method: 'home.get',
  spec: '04 §4.1, 07 §4.3',
  description: "Today's meetings, attention counts and the most urgent items.",
  scope: 'read',
  humanOnly: false,
  params: z.strictObject({ workstream: WorkstreamRef.optional() }),
  result: z.strictObject({
    workspace: z.string().min(1),
    /** Local time with the workspace's UTC offset, e.g. 2026-11-13T09:02:00+05:30. */
    now: z.iso.datetime({ offset: true }),
    today: z.array(z.strictObject({ ref: humanRef('M'), time: LocalTime, title: z.string() })),
    attention: z.strictObject({
      overdue: z.int().min(0),
      atRisk: z.int().min(0),
      awaitingReview: z.int().min(0),
      confirmationsPending: z.int().min(0),
      sessionsNeedingYou: z.int().min(0),
    }),
    /** Up to 3: overdue first, then by due date. */
    items: z.array(ItemSummary).max(3),
    counts: z.strictObject({
      /** Items overdue or due within 7 days. */
      dueSoon: z.int().min(0),
      open: z.int().min(0),
    }),
  }),
});

// items

export const itemsList = method({
  method: 'items.list',
  spec: '04 §4.1, 07 §4.2',
  description: 'Lists action items, filtered by workstream, owner, state, health or due date.',
  scope: 'read',
  humanOnly: false,
  params: z.strictObject({
    workstream: WorkstreamRef.optional(),
    owner: PersonRef.optional(),
    /** `active` is every lifecycle except verified_done and dropped. */
    state: z.union([Lifecycle, z.literal('active')]).optional(),
    health: Health.optional(),
    dueBefore: LocalDate.optional(),
    fields: z.array(ItemField).optional(),
    limit: Limit.optional(),
  }),
  result: z.strictObject({ items: z.array(ItemSummary), total: z.int().min(0) }),
});

export const itemsGet = method({
  method: 'items.get',
  spec: '04 §4.1, 07 §4.2',
  description: 'Returns one action item by ref or ID.',
  scope: 'read',
  humanOnly: false,
  params: z.strictObject({ ref: ItemRef }),
  result: z.strictObject({ item: ActionItem }),
});

export const itemsCreate = method({
  method: 'items.create',
  spec: '04 §4.1, 07 §4.2, 03 §7',
  description: 'Creates an action item as a draft for the user to accept.',
  scope: 'items:write',
  humanOnly: false,
  params: z.strictObject({
    workstream: WorkstreamRef,
    /** Verb + deliverable, at most 120 characters. */
    title: z.string().min(1).max(120),
    due: LocalDate,
    doneMeans: z.string().min(1),
    owner: PersonRef.optional(),
    /** Evidence requirement descriptions; each becomes a required requirement. */
    evidence: z.array(z.string().min(1)).optional(),
    kind: ActionKind.optional(),
    /** The meeting that captured it (M-NNNN). */
    meeting: humanRef('M').optional(),
  }),
  result: z.strictObject({ status: MutationStatus, item: ActionItem }),
});

export const itemsUpdate = method({
  method: 'items.update',
  spec: '04 §4.1, 07 §4.2, 07 §5',
  description: "Sets an item's health with a note, or proposes a new due date with a reason.",
  scope: 'items:write',
  humanOnly: false,
  params: z.strictObject({
    ref: ItemRef,
    health: z.strictObject({ value: Health, note: z.string().min(1).optional() }).optional(),
    proposeDue: z.strictObject({ date: LocalDate, reason: z.string().min(1) }).optional(),
    /** The version read; a stale one fails with E_CONFLICT (03 §12). */
    version: z.int().min(1).optional(),
  }),
  result: z.strictObject({ status: MutationStatus, item: ActionItem }),
});

export const itemsClaim = method({
  method: 'items.claim',
  spec: '04 §4.1, 07 §4.2, 03 §9.2, C-03-01',
  description: 'Claims an item as done with evidence; a repeat with the same evidence is a no-op.',
  scope: 'items:claim',
  humanOnly: false,
  params: z.strictObject({
    ref: ItemRef,
    /** May be empty when every required requirement already has evidence. */
    evidence: z.array(EvidenceInput),
    note: z.string().min(1).optional(),
  }),
  result: z.strictObject({
    status: MutationStatus,
    item: ActionItem,
    evidence: z.array(Evidence),
  }),
});

export const itemsDrop = method({
  method: 'items.drop',
  spec: '04 §4.1, 04 §4.3, 03 §7',
  description: 'Drops an item with a reason; human-only, so the CLI and MCP get E_HUMAN_REQUIRED.',
  humanOnly: true,
  params: z.strictObject({ ref: ItemRef, reason: z.string().min(1) }),
  result: z.strictObject({ status: MutationStatus, item: ActionItem }),
});

export const itemsHistory = method({
  method: 'items.history',
  spec: '04 §4.1, 07 §4.2, C-03-04',
  description: "Lists an item's domain events with their actors, oldest first.",
  scope: 'read',
  humanOnly: false,
  params: z.strictObject({ ref: ItemRef, limit: Limit.optional() }),
  result: z.strictObject({ events: z.array(DomainEvent), total: z.int().min(0) }),
});

export const itemsHandoff = method({
  method: 'items.handoff',
  spec: '04 §4.1, 07 §4.2, 07 §6.3',
  description: 'Prepares the handoff brief for an item done by an external agent framework.',
  scope: 'read',
  humanOnly: false,
  params: z.strictObject({ ref: ItemRef, to: z.enum(['firstmate', 'grok', 'other']) }),
  result: z.strictObject({
    handoff: z.strictObject({
      item: humanRef('A'),
      title: z.string().min(1),
      intent: z.string().min(1),
      acceptance: z.array(z.string().min(1)),
      /** The command that reports back, e.g. `cc-axi items claim A-0144 --evidence <pr-url>`. */
      reportBack: z.string().min(1),
    }),
  }),
});

export const itemsLink = method({
  method: 'items.link',
  spec: '04 §4.1, 07 §4.2, 07 §6.3',
  description: 'Links an item to a firstmate task so CC can follow it in the fleet ledger.',
  scope: 'items:write',
  humanOnly: false,
  params: z.strictObject({
    ref: ItemRef,
    firstmateTask: z.string().min(1),
    /** The firstmate home path. */
    home: z.string().min(1),
  }),
  result: z.strictObject({ status: MutationStatus, item: ActionItem }),
});

// evidence

export const evidenceAdd = method({
  method: 'evidence.add',
  spec: '04 §4.1, 07 §4.2 (items attach), 07 §7',
  description: 'Attaches one piece of evidence to an item, optionally for one requirement.',
  scope: 'items:claim',
  humanOnly: false,
  params: z.strictObject({ ref: ItemRef, evidence: EvidenceInput }),
  result: z.strictObject({ status: MutationStatus, evidence: Evidence }),
});

// search

export const SearchType = z.enum(['items', 'decisions', 'issues', 'meetings']);

export const searchQuery = method({
  method: 'search.query',
  spec: '04 §4.1, 07 §4.2, 03 §12 (fts_items)',
  description: 'Full-text search over items, decisions, issues and meetings.',
  scope: 'read',
  humanOnly: false,
  params: z.strictObject({
    text: z.string().min(1),
    types: z.array(SearchType).min(1).optional(),
    limit: Limit.optional(),
  }),
  result: z.strictObject({
    hits: z.array(
      z.strictObject({
        type: SearchType,
        ref: HumanRef,
        title: z.string(),
        snippet: z.string().optional(),
      }),
    ),
    total: z.int().min(0),
  }),
});

// decisions

export const decisionsList = method({
  method: 'decisions.list',
  spec: '04 §4.1, 07 §4.2',
  description: 'Lists decisions, filtered by workstream or status.',
  scope: 'read',
  humanOnly: false,
  params: z.strictObject({
    workstream: WorkstreamRef.optional(),
    status: DecisionStatus.optional(),
    limit: Limit.optional(),
  }),
  result: z.strictObject({
    decisions: z.array(
      z.strictObject({
        ref: humanRef('D'),
        question: z.string(),
        status: DecisionStatus,
        dueBy: LocalDate.optional(),
      }),
    ),
    total: z.int().min(0),
  }),
});

export const decisionsGet = method({
  method: 'decisions.get',
  spec: '04 §4.1, 07 §4.2',
  description: 'Returns one decision by ref or ID.',
  scope: 'read',
  humanOnly: false,
  params: z.strictObject({ ref: DecisionRef }),
  result: z.strictObject({ decision: Decision }),
});

export const decisionsPropose = method({
  method: 'decisions.propose',
  spec: '04 §4.1, 07 §4.2, 03 §10',
  description: 'Proposes a decision as a question with options; only its person decider decides.',
  scope: 'decisions:propose',
  humanOnly: false,
  params: z.strictObject({
    workstream: WorkstreamRef,
    /** Phrased as a question. */
    question: z.string().min(1),
    options: z.array(z.string().min(1)).optional(),
    decider: PersonRef.optional(),
    reversibility: z.enum(['two_way', 'one_way']).optional(),
    dueBy: LocalDate.optional(),
  }),
  result: z.strictObject({ status: MutationStatus, decision: Decision }),
});

// issues

export const IssueStatus = z.enum(['open', 'resolved', 'dropped']);

export const issuesList = method({
  method: 'issues.list',
  spec: '04 §4.1, 07 §4.2',
  description: 'Lists issues, filtered by workstream or status.',
  scope: 'read',
  humanOnly: false,
  params: z.strictObject({
    workstream: WorkstreamRef.optional(),
    status: IssueStatus.optional(),
    limit: Limit.optional(),
  }),
  result: z.strictObject({
    issues: z.array(
      z.strictObject({
        ref: humanRef('I'),
        title: z.string(),
        status: IssueStatus,
        rank: z.int().min(0).optional(),
      }),
    ),
    total: z.int().min(0),
  }),
});

export const issuesGet = method({
  method: 'issues.get',
  spec: '04 §4.1, 07 §4.2',
  description: 'Returns one issue by ref or ID.',
  scope: 'read',
  humanOnly: false,
  params: z.strictObject({ ref: IssueRef }),
  result: z.strictObject({ issue: Issue }),
});

export const issuesRaise = method({
  method: 'issues.raise',
  spec: '04 §4.1, 07 §4.2, 03 §11',
  description: 'Raises an issue in a workstream for its next issues section.',
  /** 07 §5 names no issues scope; `items:write` is this schema's reading. */
  scope: 'items:write',
  humanOnly: false,
  params: z.strictObject({ workstream: WorkstreamRef, title: z.string().min(1) }),
  result: z.strictObject({ status: MutationStatus, issue: Issue }),
});

// measures

export const measuresList = method({
  method: 'measures.list',
  spec: '04 §4.1, 07 §4.2',
  description: 'Lists scorecard measures with their targets and latest values.',
  scope: 'read',
  humanOnly: false,
  params: z.strictObject({ workstream: WorkstreamRef.optional(), limit: Limit.optional() }),
  result: z.strictObject({
    measures: z.array(
      z.strictObject({
        ref: humanRef('K'),
        name: z.string(),
        unit: Measure.shape.unit,
        target: Measure.shape.target,
        latest: MeasureValue.pick({ periodStart: true, value: true, normal: true }).optional(),
      }),
    ),
    total: z.int().min(0),
  }),
});

export const measuresGet = method({
  method: 'measures.get',
  spec: '04 §4.1, 07 §7 (cc_get)',
  description: 'Returns one measure by ref or ID.',
  scope: 'read',
  humanOnly: false,
  params: z.strictObject({ ref: MeasureRef }),
  result: z.strictObject({ measure: Measure }),
});

export const measuresRecord = method({
  method: 'measures.record',
  spec: '04 §4.1, 07 §4.2',
  description: 'Records a manual measure value for a period, by default the current one.',
  scope: 'measures:write',
  humanOnly: false,
  params: z.strictObject({
    ref: MeasureRef,
    value: z.union([z.number(), z.boolean()]),
    /** Any date in the period; the core maps it to the period start. */
    period: LocalDate.optional(),
    note: z.string().min(1).optional(),
  }),
  result: z.strictObject({ status: MutationStatus, value: MeasureValue }),
});

// goals

export const goalsList = method({
  method: 'goals.list',
  spec: '04 §4.1, 07 §4.2',
  description: 'Lists goals of the current, previous or next period.',
  scope: 'read',
  humanOnly: false,
  params: z.strictObject({
    workstream: WorkstreamRef.optional(),
    period: z.enum(['current', 'previous', 'next']).optional(),
    limit: Limit.optional(),
  }),
  result: z.strictObject({
    goals: z.array(
      z.strictObject({
        ref: humanRef('G'),
        title: z.string(),
        kind: GoalKind,
        status: Goal.shape.status,
        health: Health,
      }),
    ),
    total: z.int().min(0),
  }),
});

export const goalsGet = method({
  method: 'goals.get',
  spec: '04 §4.1, 07 §7 (cc_get)',
  description: 'Returns one goal by ref or ID.',
  scope: 'read',
  humanOnly: false,
  params: z.strictObject({ ref: GoalRef }),
  result: z.strictObject({ goal: Goal }),
});

// workstreams

export const workstreamsList = method({
  method: 'workstreams.list',
  spec: '04 §4.1, 07 §4.2',
  description: 'Lists the workstreams of the workspace.',
  scope: 'read',
  humanOnly: false,
  params: z.strictObject({ limit: Limit.optional() }),
  result: z.strictObject({
    workstreams: z.array(
      z.strictObject({
        slug: Slug,
        name: z.string(),
        kind: WorkstreamKind,
        status: Workstream.shape.status,
      }),
    ),
    total: z.int().min(0),
  }),
});

export const workstreamsGet = method({
  method: 'workstreams.get',
  spec: '04 §4.1, 07 §4.2',
  description: 'Returns one workstream by slug or ID.',
  scope: 'read',
  humanOnly: false,
  params: z.strictObject({ workstream: WorkstreamRef }),
  result: z.strictObject({ workstream: Workstream }),
});

// export

export const exportRun = method({
  method: 'export.run',
  spec: '04 §4.1, 03 §12 rule 6, C-03-06',
  description: 'Exports every record as JSONL per table plus blobs and a manifest of hashes.',
  /** 07 §5 names no export scope; `read` is this schema's reading, flagged in the P1-01 PR. */
  scope: 'read',
  humanOnly: false,
  params: z.strictObject({ out: z.string().min(1) }),
  result: z.strictObject({
    out: z.string().min(1),
    /** The manifest file, relative to `out`. */
    manifest: z.string().min(1),
    tables: z.int().min(0),
    blobs: z.int().min(0),
  }),
});

/** Every method `pnpm cc:gen` writes a schema for, in 04 §4.1 order. */
export const apiMethods: readonly ApiMethod[] = [
  authHello,
  authProve,
  homeGet,
  itemsList,
  itemsGet,
  itemsCreate,
  itemsUpdate,
  itemsClaim,
  itemsDrop,
  itemsHistory,
  itemsHandoff,
  itemsLink,
  evidenceAdd,
  searchQuery,
  decisionsList,
  decisionsGet,
  decisionsPropose,
  issuesList,
  issuesGet,
  issuesRaise,
  measuresList,
  measuresGet,
  measuresRecord,
  goalsList,
  goalsGet,
  workstreamsList,
  workstreamsGet,
  exportRun,
];

/**
 * The 04 §4.1 namespaces whose methods return records specified outside 03 §5. Each is
 * added, with its records, by the build step named here (09 §6.1).
 */
export const pendingNamespaces: readonly { namespace: string; spec: string; step: string }[] = [
  { namespace: 'meetings.*', spec: '02 §4 to §6', step: 'P1-07, P1-08' },
  { namespace: 'connectors.*', spec: '05', step: 'P1-13 (empty results), P2-02' },
  { namespace: 'sessions.*', spec: '04 §5', step: 'P4 (browser sandbox)' },
  { namespace: 'confirmations.*', spec: '04 §7.3', step: 'P1-13, P2-01' },
  { namespace: 'onboarding.*', spec: '01 §3, §9.1', step: 'P1-12' },
  { namespace: 'requests.*', spec: '06 §10.4', step: 'P6-05' },
  { namespace: 'backups.*', spec: '04 §9.1', step: 'P1-17' },
];

/** The JSON Schema (draft 2020-12) of one method: its params and result side by side. */
export function methodJsonSchema(definition: ApiMethod): Record<string, unknown> {
  const pair = z
    .strictObject({ params: definition.params, result: definition.result })
    .describe(
      definition.humanOnly
        ? `${definition.description} Human-only (04 §4.3).`
        : definition.scope === undefined
          ? definition.description
          : `${definition.description} Scope: ${definition.scope}.`,
    );
  return z.toJSONSchema(pair, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>;
}
