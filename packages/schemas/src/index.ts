/**
 * @cc/schemas: Zod types for records, API methods, MCP tools and config; generated JSON Schemas.
 *
 * P1-01 holds the common types and record types of 03 §3 and §5 with their generated JSON
 * Schemas in records/, and the local API method schemas of 04 §4.1 with theirs in api/. P1-06
 * adds the framework template, pack and onboarding profile types of 01 §4 (JSON Schemas in
 * frameworks/) and the FrameworkInstance record. P1-07 adds the MeetingSeries and
 * MeetingInstance records of 02 §3, the RRULE subset of ADR 0001 decision 4, and the
 * process-wide Temporal (ADR 0001 decision 1). P1-16 adds the engine extension API version
 * (ADR 0003 decision 1). The cc.config schema, MCP tool definitions and AI tool definitions
 * arrive with the build steps that specify them (docs/design/09-build-plan.md); the layout
 * is 08 §4.1.
 */
export const PACKAGE_NAME = '@cc/schemas';

export * from './extension-api.js';

export * from './records/common.js';
export * from './records/workspace.js';
export * from './records/person.js';
export * from './records/workstream.js';
export * from './records/goal.js';
export * from './records/measure.js';
export * from './records/decision.js';
export * from './records/issue.js';
export * from './records/action-item.js';
export * from './records/execution.js';
export * from './records/evidence.js';
export * from './records/event.js';
export * from './records/agent-principal.js';
export * from './records/template.js';
export * from './records/framework-instance.js';
export * from './records/rrule.js';
export * from './records/meeting.js';
export * from './records/onboarding.js';
export * from './temporal.js';
export * from './frameworks/agenda.js';
export * from './frameworks/framework.js';
export * from './frameworks/onboarding.js';
export {
  fileTypeJsonSchema,
  frameworkFileTypes,
  validateFileType,
  type FileType,
} from './frameworks/index.js';
export { recordJsonSchema, recordTypes, validateRecord, type RecordType } from './records/index.js';
export * from './api/index.js';
