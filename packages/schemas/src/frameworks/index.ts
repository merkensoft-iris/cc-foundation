/**
 * The framework and onboarding file types (01 §4) that are not stored records: framework
 * templates and packs (YAML in packages/frameworks and the engine's frameworks/ and packs/),
 * agenda templates (02 §5, their data in @cc/rhythm) and the onboarding profile
 * (`profile.json`, C-01-07). `pnpm cc:gen` writes one JSON Schema per entry to
 * packages/schemas/frameworks/<type>@<major>.json.
 */
import { z } from 'zod';

import { AgendaTemplate } from './agenda.js';
import { FrameworkTemplate, Pack } from './framework.js';
import { OnboardingProfile } from './onboarding.js';

export interface FileType {
  /** Lower-case name, as in the file name `<type>@<major>.json`. */
  readonly type: string;
  readonly major: number;
  /** Where the type is specified, e.g. "01 §4". */
  readonly spec: string;
  /** Source file under packages/schemas/src, named in the generated file. */
  readonly source: string;
  readonly schema: z.ZodType;
}

const SRC = 'packages/schemas/src/frameworks';

export const frameworkFileTypes: readonly FileType[] = [
  {
    type: 'framework_template',
    major: 1,
    spec: '01 §4',
    source: `${SRC}/framework.ts`,
    schema: FrameworkTemplate,
  },
  { type: 'pack', major: 1, spec: '01 §4, §5.5', source: `${SRC}/framework.ts`, schema: Pack },
  {
    type: 'agenda_template',
    major: 1,
    spec: '02 §3, §5',
    source: `${SRC}/agenda.ts`,
    schema: AgendaTemplate,
  },
  {
    type: 'onboarding_profile',
    major: 1,
    spec: '01 §4',
    source: `${SRC}/onboarding.ts`,
    schema: OnboardingProfile,
  },
];

/** The JSON Schema (draft 2020-12) of one file type, as `pnpm cc:gen` writes it. */
export function fileTypeJsonSchema(fileType: FileType): Record<string, unknown> {
  return z.toJSONSchema(fileType.schema, {
    target: 'draft-2020-12',
    io: 'input',
  }) as Record<string, unknown>;
}

/** Validates one parsed value against a file type; returns the issues, empty when valid. */
export function validateFileType(fileType: FileType, value: unknown): string[] {
  const result = fileType.schema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map(
    (issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
  );
}
