/**
 * The Workspace pseudo-workstream (03 §5.2, owner decision Q4, 10 Nov 2026): every workspace
 * has exactly one workstream of kind `workspace`, named "Workspace", with slug `workspace`. It
 * holds workspace-level risks and the issues and items they lead to; it has no framework
 * instance, no meetings and no measures, and is never archived. The onboarding commit (P1-12)
 * creates it with `createWorkspaceWorkstream`; a second one is refused (AC-03-11).
 */
import type { MeetingSeries, Workstream } from '@cc/schemas';

import type { Caller, DomainContext } from './context.js';
import { invariantError, type Violation } from './errors.js';
import { change, created, type Outcome } from './events.js';

export const WORKSPACE_SLUG = 'workspace';
export const WORKSPACE_NAME = 'Workspace';

/** The one workstream of kind `workspace`, if there is one. */
export function workspaceWorkstreamOf(workstreams: readonly Workstream[]): Workstream | undefined {
  return workstreams.find((workstream) => workstream.kind === 'workspace');
}

/**
 * What 03 §5.2 requires of the pseudo-workstream: exactly one, slug `workspace`, no framework
 * instance, never archived, and no meeting series of its own.
 */
export function checkWorkspaceWorkstream(
  workstreams: readonly Workstream[],
  series: readonly MeetingSeries[] = [],
): Violation[] {
  const rule = '03 §5.2' as const;
  const found = workstreams.filter((workstream) => workstream.kind === 'workspace');
  if (found.length !== 1) {
    return [
      {
        rule,
        message: `a workspace has exactly one workstream of kind workspace, not ${String(found.length)}`,
      },
    ];
  }
  const [workspace] = found as [Workstream];
  const violations: Violation[] = [];
  if (workspace.slug !== WORKSPACE_SLUG) {
    violations.push({ rule, message: `the workspace workstream's slug is ${WORKSPACE_SLUG}` });
  }
  if (workspace.frameworkInstanceId !== undefined) {
    violations.push({ rule, message: 'the workspace workstream has no framework instance' });
  }
  if (workspace.status === 'archived') {
    violations.push({ rule, message: 'the workspace workstream is never archived' });
  }
  if (series.some((s) => s.workstreamIds.includes(workspace.id))) {
    violations.push({ rule, message: 'the workspace workstream has no meetings' });
  }
  return violations;
}

/**
 * Creates the Workspace pseudo-workstream (the onboarding commit, P1-12). Its principal and
 * steward are the user, its time zone the workspace's, its privacy `normal`. A second one is
 * refused with `E_INVARIANT` (AC-03-11).
 */
export function createWorkspaceWorkstream(
  ctx: DomainContext,
  caller: Caller,
  existing: readonly Workstream[],
  input: { readonly timeZone: string },
): Outcome<Workstream> {
  const already = workspaceWorkstreamOf(existing);
  if (already !== undefined) {
    throw invariantError({
      rule: '03 §5.2',
      message: `the workspace already has its workspace workstream (${already.slug})`,
    });
  }
  const self = ctx.registry.selfPersonId;
  const record: Workstream = {
    id: ctx.ids.id('ws'),
    slug: WORKSPACE_SLUG,
    name: WORKSPACE_NAME,
    kind: 'workspace',
    principalId: self,
    stewardId: self,
    timeZone: input.timeZone,
    status: 'active',
    privacy: 'normal',
    aiDataPolicy: 'allow',
    repoPaths: [],
    groundingRefs: [],
    ...created(ctx, caller.actor),
  };
  return {
    status: 'ok',
    record,
    changes: [
      change(ctx, {
        kind: 'workstream',
        verb: 'created',
        entity: { id: record.id },
        before: undefined,
        after: record,
        actor: caller.actor,
      }),
    ],
  };
}
