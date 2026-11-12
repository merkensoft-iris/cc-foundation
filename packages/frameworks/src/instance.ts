/**
 * Checked changes to a framework instance (01 §9 levels 1, 3 and 4; C-01-03, C-01-04). Every
 * change to parameters, packs or series runs all of the template's validators on
 * the state after the change; a failure returns E_INVARIANT (or E_PARAM_BOUNDS) and the
 * caller writes nothing.
 */
import type { FrameworkTemplate, PackId } from '@cc/schemas';

import { validators, type Violation } from '../validators/index.js';
import { builtPacks } from './catalogue.js';
import { fail, ok, type FrameworkErrorData, type Result } from './errors.js';
import { checkParameters, effectiveParameters } from './parameters.js';
import type { InstanceState, SeriesView } from './state.js';

/** A broken invariant of the template, with the values that break it. */
export interface InvariantViolation extends Violation {
  readonly invariantId: string;
}

/** Runs every invariant of the template that applies in the instance's mode. */
export function checkInvariants(
  template: FrameworkTemplate,
  state: InstanceState,
): InvariantViolation[] {
  const mode = state.instance.mode;
  const parameters = effectiveParameters(template, mode, state.instance.parameters);
  const found: InvariantViolation[] = [];
  for (const invariant of template.backbone.invariants) {
    const appliesTo = invariant.appliesWhen?.mode;
    if (appliesTo !== undefined && appliesTo !== mode) continue;
    const validator = validators[invariant.validator];
    if (validator === undefined) {
      found.push({
        invariantId: invariant.id,
        message: `no validator ${invariant.validator}`,
        values: { validator: invariant.validator },
      });
      continue;
    }
    for (const violation of validator.check({ template, state, mode, parameters })) {
      found.push({ invariantId: invariant.id, ...violation });
    }
  }
  return found;
}

function invariantError(
  template: FrameworkTemplate,
  violations: readonly InvariantViolation[],
): FrameworkErrorData {
  const [first] = violations;
  const ids = [...new Set(violations.map((violation) => violation.invariantId))];
  const help = ids.map((id) => {
    const invariant = template.backbone.invariants.find((candidate) => candidate.id === id);
    return `${id}: ${invariant?.text ?? ''}`;
  });
  return {
    code: 'E_INVARIANT',
    message: `${first?.invariantId ?? ''}: ${first?.message ?? 'invariant violated'}`,
    help,
    details: {
      invariantId: first?.invariantId,
      values: first?.values ?? {},
      violations: violations.map((violation) => ({
        invariantId: violation.invariantId,
        message: violation.message,
        values: violation.values,
      })),
    },
  };
}

/**
 * Validates a whole instance state: the template matches, the parameters are within bounds and
 * every invariant holds.
 */
export function validateInstance(
  template: FrameworkTemplate,
  state: InstanceState,
): Result<InstanceState> {
  const { templateId, templateVersion } = state.instance;
  if (templateId !== template.id || templateVersion !== template.version) {
    return fail({
      code: 'E_USAGE',
      message: `the instance pins ${templateId} ${templateVersion}, not ${template.id} ${template.version}`,
      help: ['Validate an instance against the template version it pins.'],
      details: { templateId, templateVersion },
    });
  }
  const bounds = checkParameters(template, state.instance.parameters);
  if (bounds !== undefined) return fail(bounds);
  const violations = checkInvariants(template, state);
  return violations.length > 0 ? fail(invariantError(template, violations)) : ok(state);
}

export type InstanceChange =
  | { readonly kind: 'set_parameters'; readonly parameters: Readonly<Record<string, unknown>> }
  | { readonly kind: 'set_packs'; readonly packIds: readonly PackId[] }
  | { readonly kind: 'upsert_series'; readonly series: SeriesView }
  | { readonly kind: 'remove_series'; readonly seriesId: string };

function apply(state: InstanceState, change: InstanceChange): InstanceState {
  switch (change.kind) {
    case 'set_parameters':
      return {
        ...state,
        instance: {
          ...state.instance,
          parameters: { ...state.instance.parameters, ...change.parameters },
        },
      };
    case 'set_packs':
      return { ...state, instance: { ...state.instance, packIds: [...change.packIds] } };
    case 'upsert_series':
      return {
        ...state,
        series: [...state.series.filter((series) => series.id !== change.series.id), change.series],
      };
    case 'remove_series':
      return { ...state, series: state.series.filter((series) => series.id !== change.seriesId) };
  }
}

/**
 * Applies one change and validates the result (C-01-03). On success the caller writes the
 * returned state; on failure it writes nothing.
 */
export function changeInstance(
  template: FrameworkTemplate,
  state: InstanceState,
  change: InstanceChange,
  packs = builtPacks,
): Result<InstanceState> {
  if (change.kind === 'set_parameters') {
    const bounds = checkParameters(template, change.parameters);
    if (bounds !== undefined) return fail(bounds);
  }
  if (change.kind === 'set_packs') {
    const unknown = change.packIds.filter((id) => !packs.some((pack) => pack.id === id));
    if (unknown.length > 0) {
      return fail({
        code: 'E_USAGE',
        message: `no pack ${unknown.join(', ')} in this release`,
        help: [`Packs: ${[...new Set(packs.map((pack) => pack.id))].join(', ')}`],
        details: { packIds: unknown },
      });
    }
  }
  return validateInstance(template, apply(state, change));
}
