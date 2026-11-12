/**
 * Forking (01 §9 level 5): a deliberate copy of a template as `custom:<name>`. The fork drops
 * the source framework's name, records what it was forked from, and its invariants become
 * editable: it keeps only the invariants the user does not remove. It may name only
 * validators in the registry.
 */
import {
  CUSTOM_NAME,
  type FrameworkInstance,
  type FrameworkTemplate,
  type ParameterSpec,
  type Vocabulary,
} from '@cc/schemas';

import { FrameworkError } from './errors.js';
import { checkTemplate } from './template-check.js';

export interface ForkOptions {
  /** The part after `custom:`, e.g. "ald-weekly". */
  readonly name: string;
  /** Display name; default: the custom name. */
  readonly displayName?: string;
  /** Invariant IDs to drop, e.g. ["E-5"]. */
  readonly removeInvariants?: readonly string[];
  /** Parameters to replace by key, with new bounds or defaults. */
  readonly parameters?: readonly ParameterSpec[];
  readonly vocabulary?: Partial<Vocabulary>;
  readonly summary?: string;
}

/** The fork's version: a new template starts at 1.0.0. */
export const FORK_VERSION = '1.0.0';

export function forkTemplate(source: FrameworkTemplate, options: ForkOptions): FrameworkTemplate {
  const usage = (message: string, details: Record<string, unknown>) =>
    new FrameworkError({ code: 'E_USAGE', message, help: [message], details });
  if (!CUSTOM_NAME.test(options.name)) {
    throw usage(`a fork name is a lower-case slug such as ald-weekly, not "${options.name}"`, {
      name: options.name,
    });
  }
  const remove = new Set(options.removeInvariants ?? []);
  const unknown = [...remove].filter(
    (id) => !source.backbone.invariants.some((invariant) => invariant.id === id),
  );
  if (unknown.length > 0) {
    throw usage(`${source.id} has no invariant ${unknown.join(', ')}`, { invariantIds: unknown });
  }
  const replaced = new Map((options.parameters ?? []).map((spec) => [spec.key, spec]));
  const fork: FrameworkTemplate = {
    ...structuredClone(source),
    id: `custom:${options.name}`,
    version: FORK_VERSION,
    name: options.displayName ?? options.name,
    summary: options.summary ?? `Custom framework based on ${source.id} ${source.version}.`,
    sources: [
      ...structuredClone(source.sources),
      {
        label: `Forked from ${source.id} ${source.version}`,
        ref: `${source.id}@${source.version}`,
      },
    ],
    backbone: {
      ...structuredClone(source.backbone),
      invariants: source.backbone.invariants
        .filter((invariant) => !remove.has(invariant.id))
        .map((invariant) => ({ ...invariant })),
    },
    parameters: source.parameters.map((spec) => structuredClone(replaced.get(spec.key) ?? spec)),
    vocabulary: { ...source.vocabulary, ...options.vocabulary },
    forkedFrom: { templateId: source.id, version: source.version },
  };
  const problems = checkTemplate(fork);
  if (problems.length > 0) {
    throw new FrameworkError({
      code: 'E_INVARIANT',
      message: `the fork is not a valid template: ${problems[0] ?? ''}`,
      help: problems,
      details: { problems },
    });
  }
  return fork;
}

/**
 * How the UI and CLI name an instance's framework: "custom (based on eos-lite 1.0.0)" for a
 * fork (AC-01-08), "eos-lite 1.0.0" otherwise.
 */
export function frameworkLabel(
  subject:
    | Pick<FrameworkTemplate, 'id' | 'version' | 'forkedFrom'>
    | Pick<FrameworkInstance, 'templateId' | 'templateVersion' | 'forkedFrom'>,
): string {
  if (subject.forkedFrom !== undefined) {
    return `custom (based on ${subject.forkedFrom.templateId} ${subject.forkedFrom.version})`;
  }
  return 'id' in subject
    ? `${subject.id} ${subject.version}`
    : `${subject.templateId} ${subject.templateVersion}`;
}
