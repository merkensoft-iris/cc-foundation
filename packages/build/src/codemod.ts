/**
 * The codemod interface for `pnpm cc:upgrade` (ADR 0003 decision 6, 08 §4.3).
 *
 * A codemod moves an engine from extension API `from` to `from + 1`. It edits TypeScript
 * through a ts-morph `Project` holding the engine's code (`cc.config.ts`, `ui/`), and JSON
 * (theme tokens) through `readJson` and `writeJson`. It never guesses: a site it cannot
 * rewrite is left unchanged and passed to `todo`, which marks it in place with
 * `/* cc:upgrade TODO(API n): ... *\/` and lists it; the upgrade then exits 1 for a person to
 * finish. Rename tables are shared with the runtime up-cast of the N−1 shim, so the two
 * cannot disagree. The runner sets `extensionApi` after each step itself.
 */
import type { Node, Project } from 'ts-morph';

export interface CodemodContext {
  /** The engine root. */
  readonly root: string;
  readonly project: Project;
  /** Reads a JSON file of the engine (path relative to the root); undefined if missing. */
  readJson(path: string): unknown;
  /** Stages a JSON file write; written with the rest when the upgrade is not `--check`. */
  writeJson(path: string, value: unknown): void;
  /** Records `count` edits in `file` (relative to the root), for the summary and `--check`. */
  edit(file: string, count?: number): void;
  /** Leaves `node` for a person: marks it and lists it. */
  todo(node: Node, message: string): void;
}

export interface Codemod {
  /** The API this step upgrades from; it upgrades to `from + 1`. */
  readonly from: number;
  /** One line: what changes for the engine. */
  readonly title: string;
  run(context: CodemodContext): void | Promise<void>;
}

export const TODO_MARKER = 'cc:upgrade TODO';
