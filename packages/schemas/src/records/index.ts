/**
 * The record registry: every record type with its major version and zod schema. `pnpm cc:gen`
 * writes one JSON Schema per entry to packages/schemas/records/<type>@<major>.json and
 * validates fixtures/records/<type>@<major>/*.json against it (08 §6).
 *
 * The types are those of 03 §5, plus AgentPrincipal (07 §5), the identity of every local API
 * connection, FrameworkInstance (01 §4, added by P1-06), and MeetingSeries and MeetingInstance
 * (02 §3, added by P1-07). Records specified in other documents (connector installs and
 * bindings, browser sessions, confirmations, standing approvals, development requests, backup
 * runs) are added by the build steps that own them.
 */
import { z } from 'zod';

import { ActionItem } from './action-item.js';
import { AgentPrincipal } from './agent-principal.js';
import { Decision } from './decision.js';
import { DomainEvent } from './event.js';
import { Evidence } from './evidence.js';
import { FrameworkInstance } from './framework-instance.js';
import { Run } from './execution.js';
import { Goal } from './goal.js';
import { Issue, Risk } from './issue.js';
import { Measure, MeasureValue } from './measure.js';
import { MeetingInstance, MeetingSeries } from './meeting.js';
import { Person } from './person.js';
import { Workspace } from './workspace.js';
import { Workstream } from './workstream.js';

export interface RecordType {
  /** Lower-case record type name, as in the file name `<type>@<major>.json`. */
  readonly type: string;
  readonly major: number;
  /** Where the type is specified, e.g. "03 §5.1". */
  readonly spec: string;
  /** Source file under packages/schemas/src, named in the generated file. */
  readonly source: string;
  readonly schema: z.ZodType;
}

const SRC = 'packages/schemas/src/records';

export const recordTypes: readonly RecordType[] = [
  {
    type: 'workspace',
    major: 1,
    spec: '03 §5.1',
    source: `${SRC}/workspace.ts`,
    schema: Workspace,
  },
  { type: 'person', major: 1, spec: '03 §5.1', source: `${SRC}/person.ts`, schema: Person },
  {
    type: 'workstream',
    major: 1,
    spec: '03 §5.2',
    source: `${SRC}/workstream.ts`,
    schema: Workstream,
  },
  { type: 'goal', major: 1, spec: '03 §5.3', source: `${SRC}/goal.ts`, schema: Goal },
  { type: 'measure', major: 1, spec: '03 §5.4', source: `${SRC}/measure.ts`, schema: Measure },
  {
    type: 'measure_value',
    major: 1,
    spec: '03 §5.4',
    source: `${SRC}/measure.ts`,
    schema: MeasureValue,
  },
  { type: 'decision', major: 1, spec: '03 §5.5', source: `${SRC}/decision.ts`, schema: Decision },
  { type: 'issue', major: 1, spec: '03 §5.6', source: `${SRC}/issue.ts`, schema: Issue },
  { type: 'risk', major: 1, spec: '03 §5.6', source: `${SRC}/issue.ts`, schema: Risk },
  {
    type: 'action_item',
    major: 1,
    spec: '03 §5.7, §5.8, §5.9',
    source: `${SRC}/action-item.ts`,
    schema: ActionItem,
  },
  { type: 'run', major: 1, spec: '03 §5.8', source: `${SRC}/execution.ts`, schema: Run },
  { type: 'evidence', major: 1, spec: '03 §5.9', source: `${SRC}/evidence.ts`, schema: Evidence },
  {
    type: 'domain_event',
    major: 1,
    spec: '03 §5.10',
    source: `${SRC}/event.ts`,
    schema: DomainEvent,
  },
  {
    type: 'agent_principal',
    major: 1,
    spec: '07 §5',
    source: `${SRC}/agent-principal.ts`,
    schema: AgentPrincipal,
  },
  {
    type: 'framework_instance',
    major: 1,
    spec: '01 §4',
    source: `${SRC}/framework-instance.ts`,
    schema: FrameworkInstance,
  },
  {
    type: 'meeting_series',
    major: 1,
    spec: '02 §3',
    source: `${SRC}/meeting.ts`,
    schema: MeetingSeries,
  },
  {
    type: 'meeting_instance',
    major: 1,
    spec: '02 §3',
    source: `${SRC}/meeting.ts`,
    schema: MeetingInstance,
  },
];

/**
 * The JSON Schema (draft 2020-12) of one record type, as `pnpm cc:gen` writes it. Shared
 * sub-schemas such as Actor go to `$defs`.
 */
export function recordJsonSchema(record: RecordType): Record<string, unknown> {
  return z.toJSONSchema(record.schema, {
    target: 'draft-2020-12',
    io: 'input',
  }) as Record<string, unknown>;
}

/** Validates one parsed fixture against its record type; returns the issues, empty when valid. */
export function validateRecord(record: RecordType, value: unknown): string[] {
  const result = record.schema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map(
    (issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
  );
}
