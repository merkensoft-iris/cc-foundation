/**
 * The human-only operations of 04 §4.3 (C-04-05, C-07-02, INV-03-07). Only the app UI may
 * perform them; every CLI, MCP or AI caller gets `E_HUMAN_REQUIRED` with a deep link that
 * opens the right place in the app.
 *
 * The catalogue names one local API method per operation. 04 §4.1 names only `items.drop`
 * among them (it has a schema in @cc/schemas); the other method names are this module's,
 * and the build step that adds each one's handler and schema uses the name given here. The
 * gate refuses a catalogued method by name, before looking for a handler, so an agent gets
 * `E_HUMAN_REQUIRED` even for an operation whose handler does not exist yet.
 */
import { CoreError } from './errors.js';

/** The deep-link forms of 04 §4.3 rule 3, plus the meeting link of 02 §9.2 rule 2. */
export type LinkKind = 'items' | 'confirmations' | 'requests' | 'meeting' | 'app';

export interface HumanOnlyOperation {
  /** `<namespace>.<verb>`. */
  readonly method: string;
  /** The operation as 04 §4.3 words it. */
  readonly operation: string;
  /** Where it is specified. */
  readonly spec: string;
  /** Which deep link the refusal carries. */
  readonly link: LinkKind;
  /** The params member that holds the ref or ID the link opens. */
  readonly target?: string;
  /** Where in the app to go when there is no record to link to. */
  readonly screen?: string;
}

const op = (entry: HumanOnlyOperation): HumanOnlyOperation => entry;

/** Every human-only operation of 04 §4.3, in its order. */
export const HUMAN_ONLY_OPERATIONS: readonly HumanOnlyOperation[] = [
  op({
    method: 'confirmations.approve',
    operation: 'approving a confirmation',
    spec: '04 §4.3, 04 §7.3, AC-04-04',
    link: 'confirmations',
    target: 'id',
  }),
  op({
    method: 'confirmations.deny',
    operation: 'denying a confirmation',
    spec: '04 §4.3, 04 §7.3',
    link: 'confirmations',
    target: 'id',
  }),
  op({
    method: 'items.confirm',
    operation: 'confirming a claim',
    spec: '04 §4.3, 03 §9.2, INV-03-07, AC-03-02',
    link: 'items',
    target: 'ref',
  }),
  op({
    method: 'items.attest',
    operation: 'attesting a claim',
    spec: '04 §4.3, 03 §9.2, INV-03-07',
    link: 'items',
    target: 'ref',
  }),
  op({
    method: 'items.reject',
    operation: 'rejecting a claim',
    spec: '04 §4.3, 03 §9.2, INV-03-07',
    link: 'items',
    target: 'ref',
  }),
  op({
    method: 'decisions.decide',
    operation: 'deciding a decision',
    spec: '04 §4.3, 03 §10, INV-03-02',
    link: 'app',
    target: 'ref',
    screen: 'the decision',
  }),
  op({
    method: 'items.accept',
    operation: 'accepting a draft item',
    spec: '04 §4.3, 03 §7',
    link: 'items',
    target: 'ref',
  }),
  op({
    method: 'items.drop',
    operation: 'dropping an item',
    spec: '04 §4.3, 03 §7',
    link: 'items',
    target: 'ref',
  }),
  op({
    method: 'meetings.confirm',
    operation: 'confirming meeting read-back',
    spec: '04 §4.3, 02 §6',
    link: 'meeting',
    target: 'ref',
  }),
  op({
    method: 'connectors.install',
    operation: 'installing a connector',
    spec: '04 §4.3, 05',
    link: 'app',
    screen: 'Settings → Connectors',
  }),
  op({
    method: 'connectors.update',
    operation: 'updating a connector',
    spec: '04 §4.3, 05 §15.4',
    link: 'app',
    screen: 'Settings → Connectors',
  }),
  op({
    method: 'connectors.uninstall',
    operation: 'uninstalling a connector',
    spec: '04 §4.3, 05',
    link: 'app',
    screen: 'Settings → Connectors',
  }),
  op({
    method: 'principals.create',
    operation: 'adding an agent principal',
    spec: '07 §5 rule 1, 04 §4.2 rule 2',
    link: 'app',
    screen: 'Settings → Agent access',
  }),
  op({
    method: 'principals.update',
    operation: 'granting or revoking scopes',
    spec: '04 §4.3, 07 §5 rule 1',
    link: 'app',
    screen: 'Settings → Agent access',
  }),
  op({
    method: 'principals.revoke',
    operation: 'revoking an agent principal',
    spec: '07 §5 rule 1, 04 §4.2 rule 2',
    link: 'app',
    screen: 'Settings → Agent access',
  }),
  op({
    method: 'sessions.create',
    operation: 'creating a browser session',
    spec: '04 §4.3, 04 §5.4',
    link: 'app',
    screen: 'Settings → Browser sessions',
  }),
  op({
    method: 'sessions.delete',
    operation: 'deleting a browser session',
    spec: '04 §4.3, 04 §5.4',
    link: 'app',
    screen: 'Settings → Browser sessions',
  }),
  op({
    method: 'discovery.start',
    operation: 'starting connector discovery',
    spec: '04 §4.3, 06 §4',
    link: 'app',
    screen: 'Connectors → Discover',
  }),
  op({
    method: 'discovery.choose',
    operation: "choosing connector discovery's path",
    spec: '04 §4.3, 06 §4 step 2b',
    link: 'app',
    screen: 'Connectors → Discover',
  }),
  op({
    method: 'connectors.activate',
    operation: 'activating a connector or adapter from a new connectors.lock entry',
    spec: '04 §4.3, 05 §15.6',
    link: 'app',
    screen: 'Settings → Connectors',
  }),
  op({
    method: 'connectors.rollback',
    operation: 'rolling back a connector or adapter',
    spec: '04 §4.3, 05 §15.6',
    link: 'app',
    screen: 'Settings → Connectors',
  }),
  op({
    method: 'approvals.grant',
    operation: 'granting the ticket-run standing approval',
    spec: '04 §4.3, 04 §7.4 rule 5',
    link: 'app',
    screen: 'Settings → Approvals',
  }),
  op({
    method: 'approvals.revoke',
    operation: 'revoking the ticket-run standing approval',
    spec: '04 §4.3, 04 §7.4 rule 5',
    link: 'app',
    screen: 'Settings → Approvals',
  }),
  op({
    method: 'requests.approve',
    operation: 'approving a development request',
    spec: '04 §4.3, 06 §11.1, AC-06-13',
    link: 'requests',
    target: 'id',
  }),
  op({
    method: 'requests.reject',
    operation: 'rejecting a development request',
    spec: '04 §4.3, 06 §11.1',
    link: 'requests',
    target: 'id',
  }),
  op({
    method: 'requests.defer',
    operation: 'deferring a development request',
    spec: '04 §4.3, 06 §11.1',
    link: 'requests',
    target: 'id',
  }),
  op({
    method: 'backups.passphrase',
    operation: 'setting the backup passphrase',
    spec: '04 §4.3, 04 §9.1',
    link: 'app',
    screen: 'Settings → Backups',
  }),
  op({
    method: 'backups.destination',
    operation: 'setting the backup destination',
    spec: '04 §4.3, 04 §9.1',
    link: 'app',
    screen: 'Settings → Backups',
  }),
  op({
    method: 'backups.restore',
    operation: 'restoring from a backup',
    spec: '04 §4.3, 04 §9.1 rule 9, C-04-10',
    link: 'app',
    screen: 'Settings → Backups',
  }),
  op({
    method: 'goals.update',
    operation: 'editing a goal',
    spec: '04 §4.3, 03 §5.3, owner decision Q2, AC-03-10',
    link: 'app',
    target: 'ref',
    screen: 'Scorecard → Goals',
  }),
];

const BY_METHOD = new Map(HUMAN_ONLY_OPERATIONS.map((entry) => [entry.method, entry]));

export function humanOnlyOperation(method: string): HumanOnlyOperation | undefined {
  return BY_METHOD.get(method);
}

export function isHumanOnlyMethod(method: string): boolean {
  return BY_METHOD.has(method);
}

export const DEEP_LINK_SCHEME = 'commandcenter://';

/** A target safe to put into a link: a HumanRef (`A-0142`) or an ID (`cfm_7q2`). */
const LINK_TARGET = /^(?:[A-Z]-[0-9]{4,}|[a-z]+_[A-Za-z0-9_]+)$/;

/** The deep link for a kind and target (04 §4.3 rule 3), or the app itself. */
export function deepLink(kind: LinkKind, target?: string): string {
  if (kind === 'app' || target === undefined || !LINK_TARGET.test(target)) {
    return DEEP_LINK_SCHEME;
  }
  return `${DEEP_LINK_SCHEME}${kind}/${target}`;
}

function targetOf(params: unknown, member: string | undefined): string | undefined {
  if (member === undefined || typeof params !== 'object' || params === null) return undefined;
  const value = (params as Record<string, unknown>)[member];
  return typeof value === 'string' && LINK_TARGET.test(value) ? value : undefined;
}

/**
 * The `E_HUMAN_REQUIRED` refusal for `method` (04 §4.3 rule 3, 07 §4.4). Its help lines name
 * the deep link and the `cc-axi open` command.
 */
export function humanRequired(method: string, params?: unknown): CoreError {
  const entry = BY_METHOD.get(method);
  const operation = entry?.operation ?? method;
  const target = targetOf(params, entry?.target);
  const link = entry === undefined ? DEEP_LINK_SCHEME : deepLink(entry.link, target);
  const help: string[] = [];
  if (link === DEEP_LINK_SCHEME) {
    const where = entry?.screen ?? 'the app';
    help.push(`Do this in the app, ${where}${target === undefined ? '' : ` (${target})`}: ${link}`);
  } else {
    help.push(`Do this in the app: ${link}`);
  }
  help.push(
    target === undefined ? 'Run `cc-axi open` to open the app' : `Run \`cc-axi open ${target}\``,
  );
  return new CoreError(
    'E_HUMAN_REQUIRED',
    `${operation} is human-only: only the user can do it, in the app (04 §4.3)`,
    help,
  );
}
