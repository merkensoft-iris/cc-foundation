/**
 * The MCP tools of docs/design/07-agent-friendly-design.md §7: the 14 tools `cc-axi mcp`
 * serves (04 §8), each with a one-sentence description, its input schema, the local API
 * methods it calls and the scope those need. `pnpm cc:gen` writes the `tools/list` payload to
 * packages/schemas/mcp/tools.json and fails when it exceeds 12 KB (C-07-06); the relay serves
 * the same payload from `mcpToolList()`.
 *
 * Inputs mirror the `cc-axi` flags (07 §4.2) in snake_case, because the relay runs each call
 * through the command the CLI runs (C-07-03): `due_before` is `--due-before`. A filter that the
 * chosen type does not take fails as an unknown flag does (`E_UNKNOWN_FLAG`).
 *
 * No tool performs a human-only operation (C-07-02): there is no tool to confirm, attest or
 * reject a claim, accept or drop an item, decide a decision or approve a confirmation.
 */
import { z } from 'zod';

import { ActionKind } from '../records/action-item.js';
import { Health } from '../records/common.js';
import type { Scope } from '../records/agent-principal.js';

export const MCP_SERVER_NAME = 'command-center';

/** The `tools/list` payload budget of 07 §7, in bytes of compact JSON. */
export const MCP_TOOLS_BUDGET_BYTES = 12 * 1024;

/** The record types `cc_list` and `cc_get` take (07 §7), in the order of 07 §4.2. */
export const MCP_RECORD_TYPES = [
  'items',
  'decisions',
  'issues',
  'meetings',
  'measures',
  'goals',
  'workstreams',
] as const;
export type McpRecordType = (typeof MCP_RECORD_TYPES)[number];

const text = z.string().min(1);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ref = text.describe('HumanRef such as A-0142, or its ID');
const workstream = text.describe('Workstream slug');
const limit = z.int().min(1).describe('Default 50');
const evidence = text.describe('A URL, file:<path> or record:<binding>/<type>/<externalId>');
const seconds = z.int().min(1).max(600);

export interface McpTool {
  /** `cc_<verb>`. */
  readonly name: string;
  /** One sentence (07 §7). */
  readonly description: string;
  readonly input: z.ZodObject;
  /** The local API methods it calls (07 §7 table). */
  readonly methods: readonly string[];
  /** The scope the call needs (07 §5); `cc_connector_invoke` needs more for non-read actions. */
  readonly scope: Scope;
}

function tool(definition: McpTool): McpTool {
  return definition;
}

/** The 14 tools, in the order of the 07 §7 table. */
export const MCP_TOOLS: readonly McpTool[] = [
  tool({
    name: 'cc_home',
    description:
      "Shows the home view: today's meetings, attention counts and the items overdue or due within 7 days.",
    input: z.strictObject({}),
    methods: ['home.get'],
    scope: 'read',
  }),
  tool({
    name: 'cc_search',
    description: 'Searches the text of items, decisions, issues and meetings.',
    input: z.strictObject({
      text,
      types: z
        .array(z.enum(['items', 'decisions', 'issues', 'meetings']))
        .min(1)
        .optional(),
      limit: limit.optional(),
    }),
    methods: ['search.query'],
    scope: 'read',
  }),
  tool({
    name: 'cc_list',
    description:
      'Lists records of one type with a total count; filters apply to the types that take them.',
    input: z.strictObject({
      type: z.enum(MCP_RECORD_TYPES),
      workstream: workstream.optional(),
      owner: text.describe('items: me or a person').optional(),
      state: text.describe('items: a lifecycle state or active').optional(),
      health: Health.describe('items').optional(),
      due_before: date.describe('items').optional(),
      status: text.describe('decisions, issues').optional(),
      range: text.describe('meetings: today, week or YYYY-MM-DD..YYYY-MM-DD').optional(),
      period: z.enum(['current', 'previous', 'next']).describe('goals').optional(),
      fields: z
        .array(z.enum(['owner', 'health', 'carry', 'workstream']))
        .describe('items: extra columns')
        .optional(),
      limit: limit.optional(),
    }),
    methods: [
      'items.list',
      'decisions.list',
      'issues.list',
      'meetings.list',
      'measures.list',
      'goals.list',
      'workstreams.list',
    ],
    scope: 'read',
  }),
  tool({
    name: 'cc_get',
    description:
      'Shows one record by ref or ID (a workstream by slug); full returns long text uncut.',
    input: z.strictObject({
      ref: text.describe('A-0142, D-0008, I-0012, M-0031, K-0003, G-0004, an ID, or a slug'),
      type: z.enum(MCP_RECORD_TYPES).describe('Needed only for a workstream slug').optional(),
      full: z.boolean().optional(),
    }),
    methods: [
      'items.get',
      'decisions.get',
      'issues.get',
      'meetings.get',
      'measures.get',
      'goals.get',
      'workstreams.get',
    ],
    scope: 'read',
  }),
  tool({
    name: 'cc_create_action',
    description: 'Creates a draft action item, which its owner accepts in the app.',
    input: z.strictObject({
      workstream,
      title: text.describe('Verb plus deliverable'),
      due: date,
      done_means: text,
      owner: text.describe('Default me').optional(),
      evidence: z.array(text).describe('Evidence requirements').optional(),
      kind: ActionKind.optional(),
      meeting: text.describe('The M-ref that captured it').optional(),
    }),
    methods: ['items.create'],
    scope: 'items:write',
  }),
  tool({
    name: 'cc_update_action',
    description:
      "Sets an item's health with a note, or proposes a new due date with a reason for the user to re-plan.",
    input: z.strictObject({
      ref,
      health: Health.optional(),
      note: text.optional(),
      propose_due: date.optional(),
      reason: text.optional(),
    }),
    methods: ['items.update'],
    scope: 'items:write',
  }),
  tool({
    name: 'cc_claim',
    description: 'Claims an item done with its evidence; the user then confirms it in the app.',
    input: z.strictObject({
      ref,
      evidence: z.array(evidence).optional(),
      note: text.optional(),
    }),
    methods: ['items.claim'],
    scope: 'items:claim',
  }),
  tool({
    name: 'cc_attach_evidence',
    description: 'Attaches evidence to an item without claiming it.',
    input: z.strictObject({
      ref,
      evidence,
      requirement: text.describe('The er- ID it answers').optional(),
    }),
    methods: ['evidence.add'],
    scope: 'items:claim',
  }),
  tool({
    name: 'cc_propose_decision',
    description: 'Proposes a decision with its options; only its decider decides it, in the app.',
    input: z.strictObject({
      workstream,
      question: text,
      options: z.array(text).optional(),
      decider: text.optional(),
      reversibility: z.enum(['two_way', 'one_way']).optional(),
      due_by: date.optional(),
    }),
    methods: ['decisions.propose'],
    scope: 'decisions:propose',
  }),
  tool({
    name: 'cc_meeting_capture',
    description:
      'Captures a note, or a draft action item with owner, due and done_means, into a section of a meeting in progress.',
    input: z.strictObject({
      ref: text.describe('M-0031'),
      section: text.describe('The section ID'),
      workstream: workstream.describe('The section workstream, when several share it').optional(),
      note: text.optional(),
      action: text.describe('The draft item title').optional(),
      owner: text.optional(),
      due: date.optional(),
      done_means: text.optional(),
    }),
    methods: ['meetings.get', 'meetings.capture'],
    scope: 'meetings:capture',
  }),
  tool({
    name: 'cc_record_measure',
    description: 'Records a manual measure value for a period, by default the current one.',
    input: z.strictObject({
      ref: text.describe('K-0003'),
      value: z.union([z.number(), z.boolean()]),
      period: date.describe('Any date in the period').optional(),
      note: text.optional(),
    }),
    methods: ['measures.record'],
    scope: 'measures:write',
  }),
  tool({
    name: 'cc_connector_actions',
    description: 'Lists the actions of the installed connector bindings, or of one binding.',
    input: z.strictObject({ binding: text.describe('Binding label').optional() }),
    methods: ['connectors.actions'],
    scope: 'connectors:read',
  }),
  tool({
    name: 'cc_connector_invoke',
    description:
      'Invokes a connector action; an outward one returns pending_confirmation until the user approves it in the app.',
    input: z.strictObject({
      binding: text,
      action: text,
      input: z.record(z.string(), z.unknown()).optional(),
      wait: seconds.describe('Seconds to wait for the run').optional(),
    }),
    methods: ['connectors.invoke'],
    scope: 'connectors:read',
  }),
  tool({
    name: 'cc_confirmation_status',
    description:
      'Shows a confirmation request, or waits up to wait seconds for the user to decide it.',
    input: z.strictObject({ id: text.describe('cfm_ ID'), wait: seconds.optional() }),
    methods: ['confirmations.get', 'confirmations.wait'],
    scope: 'read',
  }),
];

/** One entry of the MCP `tools/list` result. */
export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** The input JSON Schema of one tool, without the `$schema` key (MCP takes a plain object schema). */
export function mcpInputSchema(definition: McpTool): Record<string, unknown> {
  const schema = z.toJSONSchema(definition.input, {
    target: 'draft-2020-12',
    io: 'input',
  }) as Record<string, unknown>;
  delete schema['$schema'];
  return schema;
}

/** The `tools` array of the `tools/list` result (07 §7). */
export function mcpToolList(): McpToolDefinition[] {
  return MCP_TOOLS.map((definition) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: mcpInputSchema(definition),
  }));
}

export function findMcpTool(name: string): McpTool | undefined {
  return MCP_TOOLS.find((definition) => definition.name === name);
}
