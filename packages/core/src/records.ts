/**
 * The records the handlers read and the writes they commit (03 §12). A handler runs one
 * command: it reads through a `RecordView`, runs the domain, and returns the writes; the
 * record store commits them with their events in the same transaction as the reads (03 §12
 * point 4, INV-03-09). Production uses the workspace store (`StoreRecordStore`, @cc/store).
 */
import type { Change, Registry } from '@cc/domain';
import type { ActionItem, Actor, Evidence, HumanRefKind, Person, Workstream } from '@cc/schemas';
import type { ReadTx } from '@cc/store';

export type BindingId = NonNullable<Evidence['record']>['bindingId'];

/** A connector binding as the handlers need it: its ID, label and installed actions. */
export interface BindingSummary {
  readonly id: BindingId;
  /** The account label the CLI writes, such as "gmail-alderwick" (05 §9, 07 §4.2). */
  readonly label: string;
  readonly actions: readonly string[];
}

/** What a command reads, inside its transaction. */
export interface RecordView {
  /** The command's own read transaction, for lookups beyond the ones below. */
  readonly tx: ReadTx;
  /** `Workspace.selfPersonId`: the default owner, reviewer and decider. */
  readonly selfPersonId: Person['id'];
  person(id: string): Person | undefined;
  workstream(id: string): Workstream | undefined;
  /** An action item by HumanRef (`A-0142`) or ID (`act_…`). */
  item(ref: string): ActionItem | undefined;
  /** The evidence attached to an item. */
  evidenceOf(itemId: string): Evidence[];
  /** A binding by label or `bnd_` ID. */
  binding(labelOrId: string): BindingSummary | undefined;
  /** The next HumanRef of a kind; the workspace counter advances in this command (03 §5.1). */
  nextRef(kind: HumanRefKind): string;
}

/**
 * An event that records something without changing a record, such as a proposed due date
 * (owner decision of 12 Nov 2026, 07 §5). The store fills in its ID and time.
 */
export interface EventOnly {
  readonly type: string;
  readonly entity: { readonly kind: string; readonly id: string; readonly ref?: string };
  readonly before?: unknown;
  readonly after?: unknown;
  readonly actor: Actor;
  readonly correlationId?: string;
}

/** What a command returns: its result, the writes to commit with their events, and events. */
export interface CommandOutcome<T> {
  readonly result: T;
  readonly changes: readonly Change[];
  /** Events with no record change, appended in the same transaction. */
  readonly events?: readonly EventOnly[];
}

export interface RecordStore {
  /**
   * Runs one command in one transaction: the reads, then the writes it returns, each with its
   * event. A write on a record changed since it was read fails `E_CONFLICT`, and nothing of
   * the command is kept.
   */
  command<T>(actor: Actor, run: (view: RecordView) => CommandOutcome<T>): T;
}

/** The read-only registry a domain command checks references against. */
export function registryOf(view: RecordView): Registry {
  return {
    get selfPersonId() {
      return view.selfPersonId;
    },
    person: (id) => view.person(id),
    workstream: (id) => view.workstream(id),
    connectorHasAction: (bindingId, action) =>
      view.binding(bindingId)?.actions.includes(action) ?? false,
    // Framework validators are wired with framework instances (INV-03-12, P1-08).
    validators: () => [],
  };
}
