/**
 * The `cc-axi` command catalogue (07 §4.2): every command P1-05 builds, with its flags,
 * defaults, examples and the local API methods it calls. The parser, the per-command
 * `--help`, the generated CLI reference and `pnpm cc:axi-conformance` all read it, so a
 * command cannot exist without its help or its conformance case.
 *
 * Commands of later build steps (meetings, connectors, sessions, confirmations, onboarding
 * rerun, requests, backups, open, export, mcp, setup, hook, serve, items handoff and items link) are
 * absent, not stubbed (07 §4.2). No command performs a human-only operation (C-07-02).
 */

/** Value lists the parser checks before calling the API; a unit test keeps them equal to @cc/schemas. */
export const LIFECYCLES = [
  'draft',
  'open',
  'in_progress',
  'waiting',
  'claimed_done',
  'verified_done',
  'dropped',
] as const;
export const HEALTHS = ['on_track', 'at_risk', 'off_track'] as const;
export const ITEM_FIELDS = ['owner', 'health', 'carry', 'workstream'] as const;
export const ACTION_KINDS = ['todo', 'follow_up'] as const;
export const DECISION_STATUSES = [
  'proposed',
  'open',
  'decided',
  'superseded',
  'reversed',
  'dropped',
] as const;
export const ISSUE_STATUSES = ['open', 'resolved', 'dropped'] as const;
export const REVERSIBILITIES = ['two_way', 'one_way'] as const;
export const GOAL_PERIODS = ['current', 'previous', 'next'] as const;
export const SEARCH_TYPES = ['items', 'decisions', 'issues', 'meetings'] as const;
export const FORMATS = ['toon', 'json'] as const;

/** Lists show 50 entries unless `--limit` says otherwise (07 §4.1 rule 2). */
export const DEFAULT_LIMIT = 50;

export interface FlagSpec {
  /** `--workstream`. */
  readonly name: string;
  /** Placeholder of the value, such as `<slug>`; absent for a boolean flag. */
  readonly value?: string;
  readonly description: string;
  readonly required?: boolean;
  /** May be given more than once. */
  readonly repeat?: boolean;
  /** Allowed values, checked before any API call. */
  readonly choices?: readonly string[];
  /** The default, as shown in help. */
  readonly default?: string;
}

export interface ArgSpec {
  /** `ref`. */
  readonly name: string;
  readonly placeholder: string;
  readonly description: string;
}

/** What a command prints, which decides the conformance checks that apply to it (07 §4.1). */
export type CommandKind = 'home' | 'list' | 'view' | 'mutation' | 'meta';

export interface CommandSpec {
  /** `items list`; the group alone for single-word commands (`search`). */
  readonly path: string;
  readonly summary: string;
  readonly kind: CommandKind;
  readonly args: readonly ArgSpec[];
  readonly flags: readonly FlagSpec[];
  /** 2 or 3 examples (07 §4.1 rule 10). */
  readonly examples: readonly string[];
  /** The local API methods it calls (04 §4.1), none of them human-only (C-07-02). */
  readonly methods: readonly string[];
  /** For a list: the output key that holds the rows. */
  readonly listKey?: string;
  /** For a list: the default columns (07 §4.1 rule 2). */
  readonly columns?: readonly string[];
  /** Old or likely-wrong flag names with the flag to use instead (07 §4.1 rule 6). */
  readonly renamed?: Readonly<Record<string, string>>;
}

/** Allowed on every command (07 §4.2): `--help`, `--format toon|json`, `--principal <name>`. */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  {
    name: '--format',
    value: '<toon|json>',
    description: 'Output format; json is an escape for scripts',
    choices: FORMATS,
    default: 'toon',
  },
  {
    name: '--principal',
    value: '<name>',
    description: 'The agent principal to call as; its token is in run/tokens of the profile',
    default: 'cli-default, or $CC_PRINCIPAL',
  },
];

const REF_ITEM: ArgSpec = { name: 'ref', placeholder: '<ref>', description: 'A-NNNN or act_ ID' };
const WORKSTREAM_FILTER: FlagSpec = {
  name: '--workstream',
  value: '<slug>',
  description: 'Only this workstream',
};
const LIMIT: FlagSpec = {
  name: '--limit',
  value: '<n>',
  description: 'Maximum number of rows',
  default: String(DEFAULT_LIMIT),
};
const EVIDENCE_FORMS = '<url|file:<path>|record:<binding>/<type>/<externalId>>';

export const COMMANDS: readonly CommandSpec[] = [
  {
    path: 'home',
    summary: "The home view: today's meetings, attention counts and the most urgent items",
    kind: 'home',
    args: [],
    flags: [],
    examples: ['cc-axi', 'cc-axi home --principal claude-code', 'cc-axi home --format json'],
    methods: ['home.get'],
  },
  {
    path: 'items list',
    summary: 'List action items',
    kind: 'list',
    args: [],
    flags: [
      WORKSTREAM_FILTER,
      { name: '--owner', value: '<me|person>', description: 'Only items this person owns' },
      {
        name: '--state',
        value: '<lifecycle|active>',
        description:
          'Only this lifecycle state; active is every state but verified_done and dropped',
        choices: [...LIFECYCLES, 'active'],
        default: 'active',
      },
      { name: '--health', value: '<health>', description: 'Only this health', choices: HEALTHS },
      {
        name: '--due-before',
        value: '<YYYY-MM-DD>',
        description: 'Only items due before this date',
      },
      {
        name: '--fields',
        value: '<list>',
        description: `Extra columns, comma-separated: ${ITEM_FIELDS.join(', ')}`,
      },
      LIMIT,
    ],
    examples: [
      'cc-axi items list --workstream alderwick',
      'cc-axi items list --owner me --due-before 2026-11-20',
      'cc-axi items list --state claimed_done --fields owner,health',
    ],
    methods: ['items.list'],
    listKey: 'items',
    columns: ['ref', 'title', 'due', 'state'],
    renamed: { '--status': '--state', '--due': '--due-before', '--ws': '--workstream' },
  },
  {
    path: 'items view',
    summary: 'Show one action item',
    kind: 'view',
    args: [REF_ITEM],
    flags: [
      {
        name: '--full',
        description: 'Show long text in full instead of the first 1,000 characters',
      },
    ],
    examples: ['cc-axi items view A-0142', 'cc-axi items view A-0142 --full'],
    methods: ['items.get', 'workstreams.get'],
  },
  {
    path: 'items create',
    summary: 'Create an action item as a draft for the user to accept',
    kind: 'mutation',
    args: [],
    flags: [
      { name: '--workstream', value: '<slug>', description: 'Its workstream', required: true },
      {
        name: '--title',
        value: '"<verb + deliverable>"',
        description: 'Verb + deliverable, at most 120 characters',
        required: true,
      },
      { name: '--due', value: '<YYYY-MM-DD>', description: 'Due date', required: true },
      {
        name: '--done-means',
        value: '"<text>"',
        description: 'What a stranger could check',
        required: true,
      },
      { name: '--owner', value: '<person>', description: 'Its one owner', default: 'me' },
      {
        name: '--evidence',
        value: '"<requirement>"',
        description: 'An evidence requirement',
        repeat: true,
      },
      {
        name: '--kind',
        value: '<todo|follow_up>',
        description: 'Kind',
        choices: ACTION_KINDS,
        default: 'todo',
      },
      { name: '--meeting', value: '<M-ref>', description: 'The meeting that captured it' },
    ],
    examples: [
      'cc-axi items create --workstream alderwick --title "Send the signed SOW to the client" --due 2026-11-20 --done-means "The signed SOW is in the client folder"',
      'cc-axi items create --workstream alderwick --title "Find out the renewal date" --due 2026-11-18 --done-means "The date is noted on the issue" --kind follow_up --evidence "A note with the date"',
    ],
    methods: ['items.create'],
    renamed: {
      '--done_means': '--done-means',
      '--donemeans': '--done-means',
      '--due-date': '--due',
    },
  },
  {
    path: 'items update',
    summary: "Set an item's health with a note, or propose a new due date with a reason",
    kind: 'mutation',
    args: [REF_ITEM],
    flags: [
      { name: '--health', value: '<health>', description: 'New health', choices: HEALTHS },
      {
        name: '--note',
        value: '"<text>"',
        description: 'Why; required with --health at_risk or off_track',
      },
      { name: '--propose-due', value: '<YYYY-MM-DD>', description: 'Proposed due date' },
      { name: '--reason', value: '"<text>"', description: 'Why; required with --propose-due' },
    ],
    examples: [
      'cc-axi items update A-0142 --health at_risk --note "Waiting on the pricing sign-off"',
      'cc-axi items update A-0142 --propose-due 2026-11-19 --reason "The lead is away until Monday"',
    ],
    methods: ['items.update'],
    renamed: { '--due': '--propose-due', '--state': '--health' },
  },
  {
    path: 'items claim',
    summary: 'Claim an item as done with evidence; the user confirms it in the app',
    kind: 'mutation',
    args: [REF_ITEM],
    flags: [
      {
        name: '--evidence',
        value: EVIDENCE_FORMS,
        description: 'Evidence; may be left out when every required requirement already has some',
        repeat: true,
      },
      { name: '--note', value: '"<text>"', description: 'A note for the reviewer' },
    ],
    examples: [
      'cc-axi items claim A-0144 --evidence https://github.com/example/repo/pull/12',
      'cc-axi items claim A-0142 --evidence record:gmail-alderwick/message/msg-123 --note "Sent this morning"',
    ],
    methods: ['items.claim'],
  },
  {
    path: 'items attach',
    summary: 'Attach one piece of evidence to an item',
    kind: 'mutation',
    args: [REF_ITEM],
    flags: [
      { name: '--evidence', value: EVIDENCE_FORMS, description: 'The evidence', required: true },
      { name: '--requirement', value: '<er-id>', description: 'The requirement it answers' },
    ],
    examples: [
      'cc-axi items attach A-0142 --evidence file:./proposal-v2.pdf --requirement er1',
      'cc-axi items attach A-0144 --evidence https://github.com/example/repo/pull/12',
    ],
    methods: ['evidence.add'],
  },
  {
    path: 'items history',
    summary: "An item's changes with their actors, oldest first",
    kind: 'list',
    args: [REF_ITEM],
    flags: [LIMIT],
    examples: ['cc-axi items history A-0142', 'cc-axi items history A-0142 --limit 5'],
    methods: ['items.history'],
    listKey: 'events',
    columns: ['at', 'type', 'actor'],
  },
  {
    path: 'search',
    summary: 'Full-text search over items, decisions, issues and meetings',
    kind: 'list',
    args: [{ name: 'text', placeholder: '"<text>"', description: 'What to look for' }],
    flags: [
      {
        name: '--types',
        value: '<list>',
        description: `Only these types, comma-separated: ${SEARCH_TYPES.join(', ')}`,
      },
      LIMIT,
    ],
    examples: ['cc-axi search "proposal"', 'cc-axi search "renewal" --types decisions,issues'],
    methods: ['search.query'],
    listKey: 'hits',
    columns: ['type', 'ref', 'title'],
    renamed: { '--type': '--types' },
  },
  {
    path: 'decisions list',
    summary: 'List decisions',
    kind: 'list',
    args: [],
    flags: [
      WORKSTREAM_FILTER,
      {
        name: '--status',
        value: '<status>',
        description: 'Only this status',
        choices: DECISION_STATUSES,
      },
      LIMIT,
    ],
    examples: [
      'cc-axi decisions list',
      'cc-axi decisions list --workstream alderwick --status open',
    ],
    methods: ['decisions.list'],
    listKey: 'decisions',
    columns: ['ref', 'question', 'status', 'due_by'],
    renamed: { '--state': '--status' },
  },
  {
    path: 'decisions view',
    summary: 'Show one decision',
    kind: 'view',
    args: [{ name: 'ref', placeholder: '<ref>', description: 'D-NNNN or dec_ ID' }],
    flags: [],
    examples: ['cc-axi decisions view D-0008', 'cc-axi decisions view D-0008 --format json'],
    methods: ['decisions.get', 'workstreams.get'],
  },
  {
    path: 'decisions propose',
    summary: 'Propose a decision as a question with options; its decider decides in the app',
    kind: 'mutation',
    args: [],
    flags: [
      { name: '--workstream', value: '<slug>', description: 'Its workstream', required: true },
      { name: '--question', value: '"<q>"', description: 'Phrased as a question', required: true },
      { name: '--option', value: '"<text>"', description: 'An option', repeat: true },
      {
        name: '--decider',
        value: '<person>',
        description: 'The one person who decides',
        default: 'me',
      },
      {
        name: '--reversibility',
        value: '<two_way|one_way>',
        description: 'How hard it is to undo',
        choices: REVERSIBILITIES,
        default: 'two_way',
      },
      { name: '--due-by', value: '<YYYY-MM-DD>', description: 'Decide by' },
    ],
    examples: [
      'cc-axi decisions propose --workstream alderwick --question "Do we offer phased pricing?" --option "Yes, in two phases" --option "No, one price"',
      'cc-axi decisions propose --workstream alderwick --question "Which audit firm do we use?" --reversibility one_way --due-by 2026-11-30',
    ],
    methods: ['decisions.propose'],
    renamed: { '--due': '--due-by', '--options': '--option' },
  },
  {
    path: 'issues list',
    summary: 'List issues',
    kind: 'list',
    args: [],
    flags: [
      WORKSTREAM_FILTER,
      {
        name: '--status',
        value: '<status>',
        description: 'Only this status',
        choices: ISSUE_STATUSES,
      },
      LIMIT,
    ],
    examples: ['cc-axi issues list', 'cc-axi issues list --workstream alderwick --status open'],
    methods: ['issues.list'],
    listKey: 'issues',
    columns: ['ref', 'title', 'status', 'rank'],
    renamed: { '--state': '--status' },
  },
  {
    path: 'issues view',
    summary: 'Show one issue',
    kind: 'view',
    args: [{ name: 'ref', placeholder: '<ref>', description: 'I-NNNN or iss_ ID' }],
    flags: [],
    examples: ['cc-axi issues view I-0012', 'cc-axi issues view I-0012 --format json'],
    methods: ['issues.get', 'workstreams.get'],
  },
  {
    path: 'issues raise',
    summary: "Raise an issue for its workstream's next issues section",
    kind: 'mutation',
    args: [],
    flags: [
      { name: '--workstream', value: '<slug>', description: 'Its workstream', required: true },
      { name: '--title', value: '"<text>"', description: 'The problem', required: true },
    ],
    examples: [
      'cc-axi issues raise --workstream alderwick --title "The consulting lead has not replied in a week"',
      'cc-axi issues raise --workstream quillmarsh --title "The contact form drops messages" --principal claude-code',
    ],
    methods: ['issues.raise'],
  },
  {
    path: 'measures list',
    summary: 'List scorecard measures with their targets and latest values',
    kind: 'list',
    args: [],
    flags: [WORKSTREAM_FILTER, LIMIT],
    examples: ['cc-axi measures list', 'cc-axi measures list --workstream alderwick'],
    methods: ['measures.list'],
    listKey: 'measures',
    columns: ['ref', 'name', 'target', 'latest'],
  },
  {
    path: 'measures record',
    summary: 'Record a manual measure value for a period, by default the current one',
    kind: 'mutation',
    args: [{ name: 'ref', placeholder: '<ref>', description: 'K-NNNN or msr_ ID' }],
    flags: [
      { name: '--value', value: '<v>', description: 'A number, or true or false', required: true },
      {
        name: '--period',
        value: '<YYYY-MM-DD>',
        description: 'Any date in the period',
        default: 'the current period',
      },
      { name: '--note', value: '"<t>"', description: 'A note on the value' },
    ],
    examples: [
      'cc-axi measures record K-0003 --value 4',
      'cc-axi measures record K-0003 --value 3 --period 2026-11-09 --note "One call moved"',
    ],
    methods: ['measures.record'],
  },
  {
    path: 'goals list',
    summary: 'List goals of the current, previous or next period',
    kind: 'list',
    args: [],
    flags: [
      WORKSTREAM_FILTER,
      {
        name: '--period',
        value: '<current|previous|next>',
        description: 'Which period',
        choices: GOAL_PERIODS,
        default: 'current',
      },
      LIMIT,
    ],
    examples: ['cc-axi goals list', 'cc-axi goals list --workstream alderwick --period previous'],
    methods: ['goals.list'],
    listKey: 'goals',
    columns: ['ref', 'title', 'status', 'health'],
  },
  {
    path: 'workstreams list',
    summary: 'List the workstreams of the workspace',
    kind: 'list',
    args: [],
    flags: [LIMIT],
    examples: ['cc-axi workstreams list', 'cc-axi workstreams list --format json'],
    methods: ['workstreams.list'],
    listKey: 'workstreams',
    columns: ['slug', 'name', 'kind', 'status'],
  },
  {
    path: 'workstreams view',
    summary: 'Show one workstream',
    kind: 'view',
    args: [{ name: 'slug', placeholder: '<slug>', description: 'Workstream slug or ws_ ID' }],
    flags: [],
    examples: [
      'cc-axi workstreams view alderwick',
      'cc-axi workstreams view quillmarsh --format json',
    ],
    methods: ['workstreams.get'],
  },
  {
    path: 'onboarding status',
    summary: 'Where onboarding stands: the steps answered, the next one, and the app-only answers',
    kind: 'view',
    args: [],
    flags: [],
    examples: ['cc-axi onboarding status', 'cc-axi onboarding status --format json'],
    methods: ['onboarding.status'],
  },
  {
    path: 'onboarding recommend',
    summary:
      'Run the framework recommender on a profile.json (01 §6): one recommendation per workstream',
    kind: 'view',
    args: [],
    flags: [
      {
        name: '--file',
        value: '<profile.json>',
        description: 'An OnboardingProfile (01 §4)',
        required: true,
      },
    ],
    examples: [
      'cc-axi onboarding recommend --file profile.json',
      'cc-axi onboarding recommend --file fixtures/onboarding/sample-profile.json --format json',
    ],
    methods: ['onboarding.recommend'],
  },
  {
    path: 'onboarding apply',
    summary:
      'Set up the workspace from a profile.json; --dry-run previews every record and writes nothing',
    kind: 'mutation',
    args: [],
    flags: [
      {
        name: '--file',
        value: '<profile.json>',
        description: 'A whole OnboardingProfile (01 §4, C-01-07)',
        required: true,
      },
      {
        name: '--dry-run',
        description: 'Preview every record and outward action; write nothing',
      },
    ],
    examples: [
      'cc-axi onboarding apply --file profile.json --dry-run',
      'cc-axi onboarding apply --file profile.json',
      'cc-axi onboarding apply --file fixtures/onboarding/sample-profile.json --dry-run --format json',
    ],
    methods: ['onboarding.preview', 'onboarding.apply'],
    renamed: { '--dryrun': '--dry-run', '--profile': '--file' },
  },
  {
    path: 'onboarding export',
    summary:
      'Write the answers as a profile.json to commit: no records, secrets or person names (01 §9.1)',
    kind: 'mutation',
    args: [],
    flags: [
      {
        name: '--out',
        value: '<profile.json>',
        description: 'The file to write',
        required: true,
      },
    ],
    examples: [
      'cc-axi onboarding export --out profile.json',
      'cc-axi onboarding export --out engine/profile.json --format json',
    ],
    methods: ['onboarding.export'],
  },
  {
    path: 'update',
    summary:
      'Report the cc-axi version; cc-axi ships inside the Command Center app and updates with it',
    kind: 'meta',
    args: [],
    flags: [{ name: '--check', description: 'Report only (the same output)' }],
    examples: ['cc-axi update', 'cc-axi update --check'],
    methods: [],
  },
];

/** The command groups in catalogue order: `items`, `search`, `decisions`, ... */
export function groups(): string[] {
  return [...new Set(COMMANDS.map((command) => command.path.split(' ')[0] ?? command.path))];
}

export function findCommand(path: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.path === path);
}

/** The subcommands of a group, such as `list`, `view` for `decisions`. */
export function subcommandsOf(group: string): string[] {
  return COMMANDS.filter((command) => command.path.startsWith(`${group} `)).map((command) =>
    command.path.slice(group.length + 1),
  );
}

/** Every flag a command accepts, its own first and then the global ones. */
export function flagsOf(command: CommandSpec): FlagSpec[] {
  return [...command.flags, ...GLOBAL_FLAGS];
}

/** The usage line: `cc-axi items view <ref> [--full]`. */
export function usageOf(command: CommandSpec): string {
  const parts = [`cc-axi ${command.path}`, ...command.args.map((arg) => arg.placeholder)];
  for (const flag of command.flags) {
    const text = flag.value === undefined ? flag.name : `${flag.name} ${flag.value}`;
    const repeated = flag.repeat === true ? `${text}...` : text;
    parts.push(flag.required === true ? repeated : `[${repeated}]`);
  }
  return parts.join(' ');
}
