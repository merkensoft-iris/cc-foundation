/**
 * How each MCP tool of 07 §7 runs: the `cc-axi` command it maps to and the flags its arguments
 * become. The relay parses those flags with the CLI's own parser and runs the CLI's own handler,
 * so a tool returns the same TOON text and the same errors as the command (07 §7, C-07-03).
 *
 * Tools whose command is in the 07 §4.2 catalogue (apps/cli/src/spec.ts) use it. The others
 * (meetings, measure and goal detail, connectors, confirmations) use the relay commands below:
 * same shape, same parser, but not CLI commands yet, so `cc-axi --help` does not list them
 * (07 §4.2: a command that is not built is absent).
 */
import {
  connectorsActions,
  connectorsInvoke,
  confirmationsView,
  confirmationsWait,
} from '../commands/connectors.js';
import type { Handler } from '../commands/common.js';
import { meetingsCapture, meetingsList, meetingsView } from '../commands/meetings.js';
import { goalsView, measuresView } from '../commands/records.js';
import { usageError } from '../errors.js';
import { DEFAULT_LIMIT, findCommand, flagsOf, type CommandSpec } from '../spec.js';

const FULL = {
  name: '--full',
  description: 'Show long text in full instead of the first 1,000 characters',
} as const;

/** The relay's own commands: what a tool runs when its CLI command is not built yet. */
export const RELAY_COMMANDS: readonly CommandSpec[] = [
  {
    path: 'meetings list',
    summary: 'List meetings this week, today or in a date range',
    kind: 'list',
    args: [],
    flags: [
      {
        name: '--range',
        value: '<today|week|<from>..<to>>',
        description: 'Which days',
        default: 'week',
      },
      {
        name: '--limit',
        value: '<n>',
        description: 'Maximum number of rows',
        default: String(DEFAULT_LIMIT),
      },
    ],
    examples: ['cc_list {"type":"meetings"}', 'cc_list {"type":"meetings","range":"today"}'],
    methods: ['meetings.list', 'home.get'],
    listKey: 'meetings',
    columns: ['ref', 'start', 'meeting', 'state'],
  },
  {
    path: 'meetings view',
    summary: 'Show one meeting with its agenda sections and read-back',
    kind: 'view',
    args: [{ name: 'ref', placeholder: '<ref>', description: 'M-NNNN or mtg_ ID' }],
    flags: [FULL],
    examples: ['cc_get {"ref":"M-0031"}', 'cc_get {"ref":"M-0031","full":true}'],
    methods: ['meetings.get'],
  },
  {
    path: 'meetings capture',
    summary: 'Capture a note or a draft action item into a section of a meeting in progress',
    kind: 'mutation',
    args: [{ name: 'ref', placeholder: '<ref>', description: 'M-NNNN or mtg_ ID' }],
    flags: [
      { name: '--section', value: '<id>', description: 'The agenda section ID', required: true },
      {
        name: '--workstream',
        value: '<slug>',
        description: 'The section workstream, when it repeats',
      },
      { name: '--note', value: '"<text>"', description: 'A note' },
      { name: '--action', value: '"<title>"', description: 'A draft action item title' },
      { name: '--owner', value: '<person>', description: 'Its owner' },
      { name: '--due', value: '<YYYY-MM-DD>', description: 'Its due date' },
      { name: '--done-means', value: '"<text>"', description: 'Its done-means' },
    ],
    examples: [
      'cc_meeting_capture {"ref":"M-0031","section":"commitments","note":"Ship it"}',
      'cc_meeting_capture {"ref":"M-0031","section":"commitments","action":"Send the SOW","due":"2026-11-20","done_means":"Sent"}',
    ],
    methods: ['meetings.get', 'meetings.capture'],
  },
  {
    path: 'measures view',
    summary: 'Show one measure',
    kind: 'view',
    args: [{ name: 'ref', placeholder: '<ref>', description: 'K-NNNN or msr_ ID' }],
    flags: [],
    examples: ['cc_get {"ref":"K-0003"}', 'cc_get {"ref":"msr_ald_props"}'],
    methods: ['measures.get', 'workstreams.get'],
  },
  {
    path: 'goals view',
    summary: 'Show one goal',
    kind: 'view',
    args: [{ name: 'ref', placeholder: '<ref>', description: 'G-NNNN or goal_ ID' }],
    flags: [FULL],
    examples: ['cc_get {"ref":"G-0004"}', 'cc_get {"ref":"G-0004","full":true}'],
    methods: ['goals.get', 'workstreams.get'],
  },
  {
    path: 'connectors actions',
    summary: 'List the actions of the installed connector bindings',
    kind: 'list',
    args: [],
    flags: [{ name: '--binding', value: '<label>', description: 'Only this binding' }],
    examples: ['cc_connector_actions {}', 'cc_connector_actions {"binding":"gmail-alderwick"}'],
    methods: ['connectors.actions'],
    listKey: 'actions',
    columns: ['binding', 'action', 'risk'],
  },
  {
    path: 'connectors invoke',
    summary: 'Invoke a connector action',
    kind: 'mutation',
    args: [
      { name: 'binding', placeholder: '<binding>', description: 'The binding label' },
      { name: 'action', placeholder: '<action>', description: 'The action' },
    ],
    flags: [
      { name: '--input', value: "'<json>'", description: 'The action input, a JSON object' },
      { name: '--wait', value: '<seconds>', description: 'Seconds to wait for the run' },
    ],
    examples: [
      'cc_connector_invoke {"binding":"gmail-alderwick","action":"search_messages"}',
      'cc_connector_invoke {"binding":"gmail-alderwick","action":"send_draft","input":{"draftId":"d-1"}}',
    ],
    methods: ['connectors.invoke'],
  },
  {
    path: 'confirmations view',
    summary: 'Show a confirmation request',
    kind: 'view',
    args: [{ name: 'id', placeholder: '<id>', description: 'cfm_ ID' }],
    flags: [],
    examples: [
      'cc_confirmation_status {"id":"cfm_7q2"}',
      'cc_confirmation_status {"id":"cfm_8r3"}',
    ],
    methods: ['confirmations.get'],
  },
  {
    path: 'confirmations wait',
    summary: 'Wait for the user to decide a confirmation request',
    kind: 'view',
    args: [{ name: 'id', placeholder: '<id>', description: 'cfm_ ID' }],
    flags: [{ name: '--timeout', value: '<seconds>', description: 'At most 600', required: true }],
    examples: [
      'cc_confirmation_status {"id":"cfm_7q2","wait":600}',
      'cc_confirmation_status {"id":"cfm_7q2","wait":60}',
    ],
    methods: ['confirmations.wait'],
  },
];

export const RELAY_HANDLERS: Readonly<Record<string, Handler>> = {
  'meetings list': meetingsList,
  'meetings view': meetingsView,
  'meetings capture': meetingsCapture,
  'measures view': measuresView,
  'goals view': goalsView,
  'connectors actions': connectorsActions,
  'connectors invoke': connectorsInvoke,
  'confirmations view': confirmationsView,
  'confirmations wait': confirmationsWait,
};

export function findRelayCommand(path: string): CommandSpec | undefined {
  return findCommand(path) ?? RELAY_COMMANDS.find((command) => command.path === path);
}

/** What one tool call runs: a command path and its argv, positionals after `--`. */
export interface Route {
  readonly path: string;
  readonly argv: readonly string[];
}

type Args = Readonly<Record<string, unknown>>;

/** The record type of a ref or ID, as `cc_get` infers it. */
const REF_TYPES: readonly [RegExp, string][] = [
  [/^(?:A-\d{4,}|act_\w+)$/, 'items'],
  [/^(?:D-\d{4,}|dec_\w+)$/, 'decisions'],
  [/^(?:I-\d{4,}|iss_\w+)$/, 'issues'],
  [/^(?:M-\d{4,}|mtg_\w+)$/, 'meetings'],
  [/^(?:K-\d{4,}|msr_\w+)$/, 'measures'],
  [/^(?:G-\d{4,}|goal_\w+)$/, 'goals'],
  [/^ws_\w+$/, 'workstreams'],
];

export function typeOfRef(ref: string): string | undefined {
  return REF_TYPES.find(([pattern]) => pattern.test(ref))?.[1];
}

function kebab(key: string): string {
  return `--${key.replaceAll('_', '-')}`;
}

interface RouteSpec {
  /** The command path, or how to choose it from the arguments. */
  readonly path: string | ((args: Args) => string);
  /** Arguments that are positionals, in order. */
  readonly positionals?: readonly string[];
  /** Arguments whose flag is not `--<kebab-case key>`. */
  readonly rename?: Readonly<Record<string, string>>;
  /** Array arguments given as one comma-separated flag value rather than a repeated flag. */
  readonly joined?: readonly string[];
  /** Arguments that only choose the command. */
  readonly omit?: readonly string[];
  /** Flags the tool sets that the chosen command may not take (dropped when it does not). */
  readonly optional?: readonly string[];
  /** What the tool's arguments say in an error about a filter the command does not take. */
  readonly what?: (args: Args) => string;
}

const ROUTES: Readonly<Record<string, RouteSpec>> = {
  cc_home: { path: 'home' },
  cc_search: { path: 'search', positionals: ['text'], joined: ['types'] },
  cc_list: {
    path: (args) => `${String(args['type'])} list`,
    omit: ['type'],
    joined: ['fields'],
    what: (args) => `cc_list with type ${String(args['type'])}`,
  },
  cc_get: {
    path: (args) => {
      const ref = String(args['ref']);
      const type = (args['type'] as string | undefined) ?? typeOfRef(ref);
      if (type === undefined) {
        throw usageError(`cannot tell what "${ref}" is`, [
          'Give a ref such as A-0142, D-0008, I-0012, M-0031, K-0003 or G-0004, or type workstreams with a slug',
        ]);
      }
      return `${type} view`;
    },
    positionals: ['ref'],
    omit: ['type'],
    optional: ['full'],
  },
  cc_create_action: { path: 'items create' },
  cc_update_action: { path: 'items update', positionals: ['ref'] },
  cc_claim: { path: 'items claim', positionals: ['ref'] },
  cc_attach_evidence: { path: 'items attach', positionals: ['ref'] },
  cc_propose_decision: { path: 'decisions propose', rename: { options: '--option' } },
  cc_meeting_capture: { path: 'meetings capture', positionals: ['ref'] },
  cc_record_measure: { path: 'measures record', positionals: ['ref'] },
  cc_connector_actions: { path: 'connectors actions' },
  cc_connector_invoke: { path: 'connectors invoke', positionals: ['binding', 'action'] },
  cc_confirmation_status: {
    path: (args) => (args['wait'] === undefined ? 'confirmations view' : 'confirmations wait'),
    positionals: ['id'],
    rename: { wait: '--timeout' },
  },
};

function flagValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** The tool argument a flag comes from: `--due-before` is `due_before`, `--option` is `options`. */
function argumentOf(spec: RouteSpec, flag: string): string {
  const renamed = Object.entries(spec.rename ?? {}).find(([, name]) => name === flag);
  return renamed?.[0] ?? flag.slice(2).replaceAll('-', '_');
}

/**
 * The command and argv of one tool call, whose arguments the tool's input schema has already
 * checked. An argument the chosen command does not take is `E_USAGE`, named in the tool's
 * terms (`cc_list with type items does not take status`).
 */
export function routeOf(tool: string, args: Args): Route & { command: CommandSpec } {
  const spec = ROUTES[tool];
  if (spec === undefined) throw usageError(`tool ${tool} has no route`);
  const path = typeof spec.path === 'string' ? spec.path : spec.path(args);
  const command = findRelayCommand(path);
  if (command === undefined) throw usageError(`tool ${tool} has no command ${path}`);
  const positionals = spec.positionals ?? [];
  const taken = new Map(flagsOf(command).map((flag) => [flag.name, flag]));
  const flags: string[] = [];
  const refused: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || positionals.includes(key) || spec.omit?.includes(key)) continue;
    const name = spec.rename?.[key] ?? kebab(key);
    const flag = taken.get(name);
    if (flag === undefined) {
      if (!spec.optional?.includes(key)) refused.push(key);
    } else if (flag.value === undefined) {
      if (value === true) flags.push(name);
    } else if (Array.isArray(value)) {
      if (spec.joined?.includes(key)) flags.push(name, value.map(flagValue).join(','));
      else for (const entry of value) flags.push(name, flagValue(entry));
    } else {
      flags.push(name, flagValue(value));
    }
  }
  if (refused.length > 0) {
    const what = spec.what?.(args) ?? tool;
    const accepted = [...positionals, ...command.flags.map((flag) => argumentOf(spec, flag.name))];
    throw usageError(`${what} does not take ${refused.join(', ')}`, [
      `${what} takes: ${accepted.length === 0 ? 'no arguments' : accepted.join(', ')}`,
    ]);
  }
  const values = positionals.flatMap((key) =>
    args[key] === undefined ? [] : [flagValue(args[key])],
  );
  return { path, argv: [...flags, '--', ...values], command };
}
