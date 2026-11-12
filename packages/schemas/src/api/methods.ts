/**
 * Local API methods (docs/design/04-platform.md §4.1): JSON-RPC 2.0, `<namespace>.<verb>`,
 * parameters and results validated with these schemas. `pnpm cc:gen` writes one JSON Schema
 * per method to packages/schemas/api/<method>.json.
 *
 * 04 §4.1 names the methods; their parameters follow the `cc-axi` flags of 07 §4.2 (the CLI,
 * MCP and AI layer call the same handlers, C-07-03), results carry the records of 03 §5, and
 * list results carry the minimal summaries and total counts of 07 §4.1 rules 2 and 4.
 *
 * The namespaces in `pendingNamespaces` return records specified outside 03 §5 (
 * connectors, sessions, confirmations, onboarding, development requests, backups). Their
 * methods are added here by the build steps named there, with their record types.
 */
import { z } from 'zod';

import { ActionItem, ActionKind, Lifecycle } from '../records/action-item.js';
import { AgentPrincipal, PrincipalName, Scope } from '../records/agent-principal.js';
import {
  HumanRef,
  humanRef,
  LocalDate,
  LocalTime,
  Health,
  UtcTimestamp,
} from '../records/common.js';
import { Decision, DecisionStatus } from '../records/decision.js';
import { DomainEvent } from '../records/event.js';
import { Evidence } from '../records/evidence.js';
import { Goal, GoalKind } from '../records/goal.js';
import { Issue, Risk } from '../records/issue.js';
import { InstanceState, MeetingInstance } from '../records/meeting.js';
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

// The review queue and the item detail (09 P1-11; 03 §7, §9.2)

/**
 * What the review queue offers for a claimed item (03 §9.2 step 4, owner decision Q5): Confirm
 * only when every required requirement has checkable evidence, otherwise disabled with its
 * reason, and Attest offered instead.
 */
export const ReviewOptions = z.strictObject({
  confirm: z.strictObject({ enabled: z.boolean(), reason: z.string().min(1).optional() }),
  attest: z.strictObject({ enabled: z.boolean() }),
  reject: z.strictObject({ enabled: z.boolean() }),
  /** Required requirements backed only by a note, or by nothing checkable. */
  notCheckable: z.array(z.string().min(1)),
});
export type ReviewOptions = z.infer<typeof ReviewOptions>;

export const itemsReview = method({
  method: 'items.review',
  spec: '03 §9.2, owner decision Q5, 09 P1-11',
  description:
    "Returns an item with its evidence and the review queue's options: Confirm, Attest, Reject.",
  scope: 'read',
  humanOnly: false,
  params: z.strictObject({ ref: ItemRef }),
  result: z.strictObject({ item: ActionItem, evidence: z.array(Evidence), review: ReviewOptions }),
});

export const itemsAccept = method({
  method: 'items.accept',
  spec: '04 §4.3, 03 §7',
  description:
    'Accepts a draft item (draft → open), also on behalf of an absent owner with a note.',
  humanOnly: true,
  params: z.strictObject({ ref: ItemRef, note: z.string().min(1).optional() }),
  result: z.strictObject({ status: MutationStatus, item: ActionItem }),
});

export const itemsConfirm = method({
  method: 'items.confirm',
  spec: '04 §4.3, 03 §9.2, owner decision Q5',
  description: 'Confirms a claim; refused while a required requirement has no checkable evidence.',
  humanOnly: true,
  params: z.strictObject({ ref: ItemRef }),
  result: z.strictObject({ status: MutationStatus, item: ActionItem }),
});

export const itemsAttest = method({
  method: 'items.attest',
  spec: '04 §4.3, 03 §9.2, §9.3, owner decision Q5',
  description: 'Attests a claim with a note: verified_done with method attested, counted apart.',
  humanOnly: true,
  params: z.strictObject({ ref: ItemRef, note: z.string().min(1) }),
  result: z.strictObject({ status: MutationStatus, item: ActionItem }),
});

export const itemsReject = method({
  method: 'items.reject',
  spec: '04 §4.3, 03 §7, §9.2 step 5',
  description: 'Rejects a claim with a reason: back to in_progress, health at_risk.',
  humanOnly: true,
  params: z.strictObject({ ref: ItemRef, reason: z.string().min(1) }),
  result: z.strictObject({ status: MutationStatus, item: ActionItem }),
});

// decisions (human-only decide)

export const decisionsDecide = method({
  method: 'decisions.decide',
  spec: '04 §4.3, 03 §10, INV-03-02',
  description: 'Decides an open decision with the outcome and why.',
  humanOnly: true,
  params: z.strictObject({
    ref: DecisionRef,
    /** One of the decision's options, when the outcome is one of them. */
    optionId: z.string().min(1).optional(),
    text: z.string().min(1),
    why: z.string().min(1),
    /** Waives the memo of a one-way door (03 §10). */
    waiverNote: z.string().min(1).optional(),
  }),
  result: z.strictObject({ status: MutationStatus, decision: Decision }),
});

// goals (the Scorecard's Goals tab, owner decision Q2)

export const goalsUpdate = method({
  method: 'goals.update',
  spec: '03 §5.3, owner decision Q2, AC-03-10',
  description: 'Changes a goal outside any meeting; one goal.updated event with before and after.',
  humanOnly: true,
  params: z.strictObject({
    ref: GoalRef,
    title: z.string().min(1).optional(),
    doneMeans: z.string().min(1).optional(),
    target: Goal.shape.target.unwrap().optional(),
    health: z.strictObject({ value: Health, note: z.string().min(1).optional() }).optional(),
    /** The version read; a stale one fails with E_CONFLICT (03 §12). */
    version: z.int().min(1).optional(),
  }),
  result: z.strictObject({ status: MutationStatus, goal: Goal }),
});

export const goalsHistory = method({
  method: 'goals.history',
  spec: '03 §5.3, owner decision Q2, C-03-04',
  description: "Lists a goal's domain events with their actors, oldest first.",
  scope: 'read',
  humanOnly: false,
  params: z.strictObject({ ref: GoalRef, limit: Limit.optional() }),
  result: z.strictObject({ events: z.array(DomainEvent), total: z.int().min(0) }),
});

// risks (03 §5.6, §11; workspace-level risks on the Workspace pseudo-workstream, Q4)

const RiskRef = recordRef('R', 'rsk');

export const risksList = method({
  method: 'risks.list',
  spec: '03 §5.6, §11, owner decision Q4',
  description: 'Lists risks, filtered by workstream or status.',
  scope: 'read',
  humanOnly: false,
  params: z.strictObject({
    workstream: WorkstreamRef.optional(),
    status: Risk.shape.status.optional(),
    limit: Limit.optional(),
  }),
  result: z.strictObject({
    risks: z.array(
      z.strictObject({
        ref: humanRef('R'),
        description: z.string(),
        trigger: z.string(),
        status: Risk.shape.status,
        workstream: Slug,
      }),
    ),
    total: z.int().min(0),
  }),
});

export const risksRecord = method({
  method: 'risks.record',
  spec: '03 §5.6, §11 rule 4, owner decision Q4',
  description: 'Records a risk; workspace-wide ones go on the workspace pseudo-workstream.',
  scope: 'items:write',
  humanOnly: false,
  params: z.strictObject({
    workstream: WorkstreamRef,
    description: z.string().min(1),
    trigger: z.string().min(1),
    watcher: PersonRef.optional(),
  }),
  result: z.strictObject({ status: MutationStatus, risk: Risk }),
});

export const risksGet = method({
  method: 'risks.get',
  spec: '03 §5.6',
  description: 'Returns one risk by ref or ID.',
  scope: 'read',
  humanOnly: false,
  params: z.strictObject({ ref: RiskRef }),
  result: z.strictObject({ risk: Risk }),
});

// meetings (02 §4.7, §5, §6; the Meetings screen)

const MeetingRef = recordRef('M', 'mtg');

/** A row of the week view. */
export const MeetingSummary = z.strictObject({
  ref: humanRef('M'),
  /** The series name, e.g. "Weekly CEO review". */
  title: z.string().min(1),
  start: UtcTimestamp,
  end: UtcTimestamp,
  state: InstanceState,
  agendaTemplateId: z.string().min(1),
});
export type MeetingSummary = z.infer<typeof MeetingSummary>;

export const meetingsList = method({
  method: 'meetings.list',
  spec: '04 §4.1, 07 §4.2, 02 §4.7',
  description:
    'Lists meeting instances between two local dates (default: this week, Monday to Sunday).',
  scope: 'read',
  humanOnly: false,
  params: z.strictObject({
    from: LocalDate.optional(),
    /** Inclusive. */
    to: LocalDate.optional(),
    limit: Limit.optional(),
  }),
  result: z.strictObject({
    from: LocalDate,
    to: LocalDate,
    timeZone: z.string().min(1),
    meetings: z.array(MeetingSummary),
    total: z.int().min(0),
  }),
});

/** One agenda row of a running meeting, with its timebox and the rows its inputs found. */
export const MeetingSection = z.strictObject({
  sectionId: z.string().min(1),
  workstreamId: z.string().min(1).optional(),
  absorbedFrom: z.string().min(1).optional(),
  title: z.string().min(1),
  type: z.string().min(1),
  timeboxMinutes: z.int().min(0),
  status: z.enum(['pending', 'done', 'skipped']),
  allowedOutputs: z.array(z.string().min(1)),
  rows: z.array(
    z.strictObject({
      ref: z.string().min(1),
      title: z.string(),
      flags: z.array(z.string()),
    }),
  ),
});
export type MeetingSection = z.infer<typeof MeetingSection>;

/** A line of the conclude section's read-back (02 §6.4 rule 1). */
export const ReadBackLine = z.strictObject({
  kind: z.enum(['action_item', 'decision']),
  ref: z.string().min(1),
  owner: z.string().min(1),
  ownerPresent: z.boolean(),
  deliverable: z.string(),
  due: z.string().optional(),
  doneMeans: z.string().optional(),
  state: z.string().min(1),
});

export const meetingsGet = method({
  method: 'meetings.get',
  spec: '04 §4.1, 07 §4.2, 02 §5.7, §6',
  description:
    'Returns a meeting with its agenda sections, timeboxes, input rows and read-back list.',
  scope: 'read',
  humanOnly: false,
  params: z.strictObject({ ref: MeetingRef }),
  result: z.strictObject({
    meeting: MeetingInstance,
    title: z.string().min(1),
    agendaTemplateId: z.string().min(1),
    timeZone: z.string().min(1),
    sections: z.array(MeetingSection),
    readBack: z.array(ReadBackLine),
  }),
});

export const meetingsStart = method({
  method: 'meetings.start',
  spec: '02 §4.7, §4.2',
  description: 'Starts a meeting; only the user starts one (02 §4.2), so agents are refused.',
  scope: 'meetings:capture',
  humanOnly: false,
  params: z.strictObject({ ref: MeetingRef }),
  result: z.strictObject({ meeting: MeetingInstance }),
});

/** The section an output belongs to (`SectionKey` of @cc/rhythm). */
const SectionKeyParams = z.strictObject({
  sectionId: z.string().min(1),
  workstreamId: z.string().min(1).optional(),
  absorbedFrom: z.string().min(1).optional(),
});

export const meetingsCapture = method({
  method: 'meetings.capture',
  spec: '02 §6.3, 02 §5.7 rule 3 (owner decision Q7), 07 §4.2',
  description: 'Captures a draft action item or a note into a section of a meeting in progress.',
  scope: 'meetings:capture',
  humanOnly: false,
  params: z.strictObject({
    ref: MeetingRef,
    section: SectionKeyParams,
    output: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('note'), text: z.string().min(1) }),
      z.strictObject({
        kind: z.literal('action_item'),
        title: z.string().min(1),
        due: LocalDate,
        doneMeans: z.string().min(1),
        owner: PersonRef.optional(),
        workstream: WorkstreamRef.optional(),
      }),
    ]),
  }),
  result: z.strictObject({ status: MutationStatus, meeting: MeetingInstance }),
});

export const meetingsConfirm = method({
  method: 'meetings.confirm',
  spec: '04 §4.3, 02 §6.4 rule 1',
  description: 'Confirms the read-back: accepts the drafts of present owners.',
  humanOnly: true,
  params: z.strictObject({
    ref: MeetingRef,
    /** Drafts of absent owners accepted on their behalf, each with a note. */
    acceptances: z
      .array(z.strictObject({ ref: humanRef('A'), note: z.string().min(1) }))
      .optional(),
  }),
  result: z.strictObject({
    status: MutationStatus,
    meeting: MeetingInstance,
    accepted: z.array(z.string()),
    pending: z.array(z.string()),
  }),
});

export const meetingsClose = method({
  method: 'meetings.close',
  spec: '02 §4.7, §6.4 rule 3, §7',
  description: 'Closes a meeting after its read-back: carries items and runs the escalation job.',
  scope: 'meetings:capture',
  humanOnly: false,
  params: z.strictObject({ ref: MeetingRef }),
  result: z.strictObject({
    status: MutationStatus,
    meeting: MeetingInstance,
    carried: z.array(z.string()),
  }),
});

export const meetingsDismiss = method({
  method: 'meetings.dismiss',
  spec: '02 §5.7 rule 2 (owner decision Q6)',
  description:
    "Dismisses a daily-start attention entry: snoozed to tomorrow's daily start, not resolved.",
  scope: 'meetings:capture',
  humanOnly: false,
  params: z.strictObject({ ref: MeetingRef, entry: z.string().min(1) }),
  result: z.strictObject({ status: MutationStatus, until: LocalDate }),
});

// principals (Settings → Agent access, 07 §5)

/** A principal as Settings → Agent access lists it; never its token. */
export const PrincipalSummary = AgentPrincipal.pick({
  name: true,
  kind: true,
  scopes: true,
  workstreamFilter: true,
  sensitiveAccess: true,
  lastUsedAt: true,
  revokedAt: true,
});

export const principalsList = method({
  method: 'principals.list',
  spec: '07 §5, 04 §4.2',
  description: 'Lists the agent principals with their scopes; never their tokens.',
  scope: 'read',
  humanOnly: false,
  params: z.strictObject({}),
  result: z.strictObject({ principals: z.array(PrincipalSummary), total: z.int().min(0) }),
});

export const principalsCreate = method({
  method: 'principals.create',
  spec: '04 §4.3, 07 §5 rule 1, 04 §4.2',
  description: 'Creates an agent principal and writes its token file.',
  humanOnly: true,
  params: z.strictObject({
    name: PrincipalName,
    kind: AgentPrincipal.shape.kind,
    scopes: z.array(Scope),
    workstreamFilter: AgentPrincipal.shape.workstreamFilter.optional(),
    sensitiveAccess: z.boolean().optional(),
  }),
  result: z.strictObject({ principal: PrincipalSummary, tokenPath: z.string().min(1) }),
});

export const principalsUpdate = method({
  method: 'principals.update',
  spec: '04 §4.3, 07 §5 rules 1 and 3',
  description: "Grants or revokes a principal's scopes, or changes its workstreams.",
  humanOnly: true,
  params: z.strictObject({
    name: PrincipalName,
    scopes: z.array(Scope).optional(),
    workstreamFilter: AgentPrincipal.shape.workstreamFilter.optional(),
    sensitiveAccess: z.boolean().optional(),
  }),
  result: z.strictObject({ principal: PrincipalSummary }),
});

export const principalsRevoke = method({
  method: 'principals.revoke',
  spec: '04 §4.3, 04 §4.2 rule 2',
  description: 'Revokes a principal and deletes its token file.',
  humanOnly: true,
  params: z.strictObject({ name: PrincipalName }),
  result: z.strictObject({ principal: PrincipalSummary }),
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
  itemsReview,
  itemsAccept,
  itemsConfirm,
  itemsAttest,
  itemsReject,
  evidenceAdd,
  searchQuery,
  decisionsList,
  decisionsGet,
  decisionsPropose,
  decisionsDecide,
  issuesList,
  issuesGet,
  issuesRaise,
  risksList,
  risksGet,
  risksRecord,
  meetingsList,
  meetingsGet,
  meetingsStart,
  meetingsCapture,
  meetingsConfirm,
  meetingsClose,
  meetingsDismiss,
  measuresList,
  measuresGet,
  measuresRecord,
  goalsList,
  goalsGet,
  goalsUpdate,
  goalsHistory,
  workstreamsList,
  workstreamsGet,
  principalsList,
  principalsCreate,
  principalsUpdate,
  principalsRevoke,
  exportRun,
];

/**
 * The 04 §4.1 namespaces whose methods return records specified outside 03 §5. Each is
 * added, with its records, by the build step named here (09 §6.1).
 */
export const pendingNamespaces: readonly { namespace: string; spec: string; step: string }[] = [
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
