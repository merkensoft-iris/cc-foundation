/**
 * Checks a framework template or pack beyond its JSON Schema (01 §4, C-01-03): every
 * invariant names a registered validator whose parameters the template declares, defaults lie
 * within their bounds, a meeting's duration parameter matches its backbone bounds, and only a
 * `custom:` template records what it was forked from. The foundation runs these checks on its
 * own files (pnpm cc:gen) and on every engine file at build and at start (01 §9 level 6).
 */
import {
  FrameworkTemplate as FrameworkTemplateSchema,
  Pack as PackSchema,
  type FrameworkTemplate,
  type Pack,
} from '@cc/schemas';

import { validators } from '../validators/index.js';
import { describeBounds, withinBounds } from './parameters.js';

function zodIssues(result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}): string[] {
  if (result.success) return [];
  return (result.error?.issues ?? []).map(
    (issue) =>
      `${issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)'}: ${issue.message}`,
  );
}

/** Checks one template; returns the problems, empty when valid. */
export function checkTemplate(value: unknown): string[] {
  const parsed = FrameworkTemplateSchema.safeParse(value);
  if (!parsed.success) return zodIssues(parsed);
  const template = parsed.data;
  const problems: string[] = [];

  const isCustom = template.id.startsWith('custom:');
  if (isCustom && template.forkedFrom === undefined) {
    problems.push(`forkedFrom: a custom: template records the template it was forked from`);
  }
  if (!isCustom && template.forkedFrom !== undefined) {
    problems.push(`forkedFrom: only a custom: template is a fork`);
  }

  const meetingKeys = new Set<string>();
  for (const meeting of template.backbone.meetings) {
    if (meetingKeys.has(meeting.key)) problems.push(`meeting ${meeting.key}: duplicate key`);
    meetingKeys.add(meeting.key);
    const { min, max } = meeting.durationMinutes;
    const defaults = [
      meeting.durationMinutes.default,
      ...Object.values(meeting.durationMinutes.defaultByMode ?? {}),
    ];
    if (min > max || defaults.some((value) => value === undefined || value < min || value > max)) {
      problems.push(`meeting ${meeting.key}: durationMinutes needs min <= default <= max`);
    }
  }

  const keys = new Set<string>();
  for (const spec of template.parameters) {
    if (keys.has(spec.key)) problems.push(`parameter ${spec.key}: duplicate key`);
    keys.add(spec.key);
    if (spec.type === 'enum' && spec.enum === undefined) {
      problems.push(`parameter ${spec.key}: an enum parameter lists its values`);
    }
    if (spec.min !== undefined && spec.max !== undefined && spec.min > spec.max) {
      problems.push(`parameter ${spec.key}: min ${spec.min} is above max ${spec.max}`);
    }
    for (const [label, value] of [
      ['default', spec.default] as const,
      ...Object.entries(spec.defaultByMode ?? {}).map(
        ([mode, modeValue]) => [`${mode} default`, modeValue] as const,
      ),
    ]) {
      if (!withinBounds(spec, value)) {
        problems.push(
          `parameter ${spec.key}: ${label} ${JSON.stringify(value)} is not ${describeBounds(spec)}`,
        );
      }
    }
    const meetingKey = /^([a-z][a-z0-9_-]*)\.duration$/.exec(spec.key)?.[1];
    const meeting = template.backbone.meetings.find((candidate) => candidate.key === meetingKey);
    if (meetingKey !== undefined && spec.type === 'duration_minutes') {
      if (meeting === undefined) {
        problems.push(`parameter ${spec.key}: there is no ${meetingKey} meeting`);
      } else if (
        spec.min !== meeting.durationMinutes.min ||
        spec.max !== meeting.durationMinutes.max
      ) {
        problems.push(
          `parameter ${spec.key}: bounds must match the ${meetingKey} meeting (${meeting.durationMinutes.min} to ${meeting.durationMinutes.max})`,
        );
      }
    }
  }

  const invariantIds = new Set<string>();
  for (const invariant of template.backbone.invariants) {
    if (invariantIds.has(invariant.id)) problems.push(`invariant ${invariant.id}: duplicate ID`);
    invariantIds.add(invariant.id);
    const validator = validators[invariant.validator];
    if (validator === undefined) {
      problems.push(
        `invariant ${invariant.id}: no validator ${invariant.validator} in packages/frameworks/validators`,
      );
      continue;
    }
    for (const key of validator.reads) {
      if (!keys.has(key)) {
        problems.push(
          `invariant ${invariant.id}: ${invariant.validator} reads parameter ${key}, which the template does not declare`,
        );
      }
    }
  }

  for (const slot of template.extensionSlots) {
    if (!/^(?:before|after):[a-z_]+$/.test(slot)) {
      problems.push(`extensionSlots: ${slot} is not before:<section> or after:<section>`);
    }
  }
  return problems;
}

/** Checks one pack; returns the problems, empty when valid. */
export function checkPack(value: unknown): string[] {
  const parsed = PackSchema.safeParse(value);
  if (!parsed.success) return zodIssues(parsed);
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const measure of parsed.data.measureTemplates) {
    if (keys.has(measure.key)) problems.push(`measure template ${measure.key}: duplicate key`);
    keys.add(measure.key);
  }
  return problems;
}

/** Parses a template, throwing on the first problem. */
export function parseTemplate(value: unknown): FrameworkTemplate {
  const problems = checkTemplate(value);
  if (problems.length > 0) throw new Error(`invalid framework template: ${problems.join('; ')}`);
  return FrameworkTemplateSchema.parse(value);
}

/** Parses a pack, throwing on the first problem. */
export function parsePack(value: unknown): Pack {
  const problems = checkPack(value);
  if (problems.length > 0) throw new Error(`invalid pack: ${problems.join('; ')}`);
  return PackSchema.parse(value);
}
