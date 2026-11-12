/** ID types of 03 §3, read off the record types of @cc/schemas. */
import type { ActionItem, Decision, Evidence, Issue, Risk } from '@cc/schemas';

export type PersonId = ActionItem['ownerId'];
export type WorkstreamId = ActionItem['workstreamId'];
export type ActionItemId = ActionItem['id'];
export type EvidenceId = Evidence['id'];
export type DecisionId = Decision['id'];
export type IssueId = Issue['id'];
export type RiskId = Risk['id'];
