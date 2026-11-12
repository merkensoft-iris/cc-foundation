/**
 * Parameters within ParameterSpec bounds (01 §4, §9 level 1). Values outside their bounds are
 * rejected with E_PARAM_BOUNDS naming the key, the value and the bounds; nothing is clamped
 * (C-01-04).
 */
import type { FrameworkMode, FrameworkTemplate, ParameterSpec } from '@cc/schemas';

import type { FrameworkErrorData } from './errors.js';

const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const TIME_OF_DAY = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;

/** The bounds of one parameter, as the error and the CLI help state them. */
export function describeBounds(spec: ParameterSpec): string {
  switch (spec.type) {
    case 'int':
    case 'duration_minutes': {
      const unit = spec.type === 'duration_minutes' ? ' minutes' : '';
      if (spec.min !== undefined && spec.max !== undefined) {
        return `an integer from ${spec.min} to ${spec.max}${unit}`;
      }
      if (spec.min !== undefined) return `an integer of at least ${spec.min}${unit}`;
      if (spec.max !== undefined) return `an integer of at most ${spec.max}${unit}`;
      return `an integer${unit}`;
    }
    case 'weekday':
      return `one of ${WEEKDAYS.join(', ')}`;
    case 'time_of_day':
      return 'a local time HH:MM';
    case 'enum':
      return `one of ${(spec.enum ?? []).join(', ')}`;
    case 'bool':
      return 'true or false';
    case 'string':
      return 'a non-empty string';
  }
}

/** Whether a value lies within the spec's type and bounds. */
export function withinBounds(spec: ParameterSpec, value: unknown): boolean {
  switch (spec.type) {
    case 'int':
    case 'duration_minutes':
      return (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        (spec.min === undefined || value >= spec.min) &&
        (spec.max === undefined || value <= spec.max)
      );
    case 'weekday':
      return typeof value === 'string' && WEEKDAYS.includes(value);
    case 'time_of_day':
      return typeof value === 'string' && TIME_OF_DAY.test(value);
    case 'enum':
      return typeof value === 'string' && (spec.enum ?? []).includes(value);
    case 'bool':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string' && value.length > 0;
  }
}

/** The default of one parameter in a mode (01 §5.3: some defaults depend on the mode). */
export function parameterDefault(spec: ParameterSpec, mode: FrameworkMode): unknown {
  const byMode = spec.defaultByMode?.[mode];
  return byMode !== undefined ? byMode : spec.default;
}

/** Every parameter of the template at its default for the mode. */
export function defaultParameters(
  template: FrameworkTemplate,
  mode: FrameworkMode,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const spec of template.parameters) values[spec.key] = parameterDefault(spec, mode);
  return values;
}

/**
 * Checks parameter values against the template. An unknown key is out of bounds too: the
 * template declares every parameter it accepts. Returns the first error, or undefined.
 */
export function checkParameters(
  template: FrameworkTemplate,
  values: Readonly<Record<string, unknown>>,
): FrameworkErrorData | undefined {
  for (const [key, value] of Object.entries(values)) {
    const spec = template.parameters.find((candidate) => candidate.key === key);
    if (spec === undefined) {
      return {
        code: 'E_PARAM_BOUNDS',
        message: `${template.id} has no parameter ${key}`,
        help: [`Parameters of ${template.id}: ${template.parameters.map((p) => p.key).join(', ')}`],
        details: { key, value, bounds: null, templateId: template.id },
      };
    }
    if (!withinBounds(spec, value)) {
      const bounds = describeBounds(spec);
      return {
        code: 'E_PARAM_BOUNDS',
        message: `${key} = ${JSON.stringify(value)} is outside its bounds: ${bounds}`,
        help: [`${key} must be ${bounds} (${template.id} ${template.version})`],
        details: {
          key,
          value,
          bounds: {
            type: spec.type,
            ...(spec.min !== undefined ? { min: spec.min } : {}),
            ...(spec.max !== undefined ? { max: spec.max } : {}),
            ...(spec.enum !== undefined ? { enum: spec.enum } : {}),
          },
          templateId: template.id,
        },
      };
    }
  }
  return undefined;
}

/** The instance's parameters with the template defaults filled in for the mode. */
export function effectiveParameters(
  template: FrameworkTemplate,
  mode: FrameworkMode,
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return { ...defaultParameters(template, mode), ...values };
}
