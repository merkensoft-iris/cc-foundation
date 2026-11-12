/**
 * Issues and risks (09 P1-11): workspace-level risks on the Workspace pseudo-workstream (owner
 * decision Q4, AC-03-11).
 */
import { describe, expect, it } from 'vitest';

import { riskGroups } from '../../src/renderer/screens/issues.js';
import { allByTest, byTest, textOf } from '../../src/renderer/ui/vnode.js';
import { click, startApp, type } from './harness.js';

const workstreams = [
  { slug: 'alderwick', name: 'Alderwick', kind: 'company', status: 'active' },
  { slug: 'quillmarsh', name: 'Quillmarsh', kind: 'company', status: 'active' },
  { slug: 'workspace', name: 'Workspace', kind: 'workspace', status: 'active' },
];

describe('workspace-level risks (owner decision Q4)', () => {
  it('AC-03-11 lists the Workspace pseudo-workstream first and records a workspace-level risk on it by default', async () => {
    const risks = [
      {
        ref: 'R-0002',
        description: 'Client renewal slips',
        trigger: 'No PO by 15 Dec',
        status: 'watching',
        workstream: 'alderwick',
      },
    ];
    const answers = {
      'issues.list': () => ({
        issues: [{ ref: 'I-0012', title: 'Lead response is slow', status: 'open' }],
        total: 1,
      }),
      'risks.list': () => ({ risks, total: risks.length }),
      'workstreams.list': () => ({ workstreams, total: 3 }),
      'risks.record': (params: Record<string, unknown>) => {
        risks.push({
          ref: 'R-0006',
          description: params['description'] as string,
          trigger: params['trigger'] as string,
          status: 'watching',
          workstream: params['workstream'] as string,
        });
        return { status: 'ok' };
      },
    };
    const app = await startApp(answers, { screen: 'issues' });
    const groups = allByTest(app.tree(), 'risks-workspace');
    expect(groups).toHaveLength(1);
    expect(textOf(groups[0]!)).toMatch(/^Workspace \(workspace-level risks\)/);
    expect(byTest(app.tree(), 'risk-workstream').props.value).toBe('workspace');

    const form = byTest(app.tree(), 'risk-form');
    type(byTest(form, 'risk-description'), 'The laptop with the only copy fails');
    type(byTest(form, 'risk-trigger'), 'No backup for 72 hours');
    await click(app, byTest(form, 'record-risk'));
    expect(app.callsOf('risks.record')).toEqual([
      {
        workstream: 'workspace',
        description: 'The laptop with the only copy fails',
        trigger: 'No backup for 72 hours',
      },
    ]);
    expect(textOf(byTest(byTest(app.tree(), 'risks-workspace'), 'risk-R-0006'))).toMatch(
      /The laptop with the only copy fails/,
    );
    expect(textOf(byTest(app.tree(), 'issue-I-0012'))).toMatch(/Lead response is slow/);
  });

  it('orders the groups Workspace first, then by name, and keeps the Workspace group when it is empty', () => {
    const groups = riskGroups(
      [
        {
          ref: 'R-0002',
          description: 'd',
          trigger: 't',
          status: 'watching',
          workstream: 'quillmarsh',
        },
      ],
      workstreams,
    );
    expect(groups.map((group) => group.slug)).toEqual(['workspace', 'quillmarsh']);
  });

  it('raises an issue', async () => {
    const app = await startApp(
      {
        'issues.list': () => ({ issues: [], total: 0 }),
        'risks.list': () => ({ risks: [], total: 0 }),
        'workstreams.list': () => ({ workstreams, total: 3 }),
        'issues.raise': () => ({ status: 'ok' }),
      },
      { screen: 'issues' },
    );
    const form = byTest(app.tree(), 'issue-form');
    expect(byTest(form, 'issue-workstream').props.value).toBe('alderwick');
    type(byTest(form, 'issue-title'), 'Invoices go out late');
    await click(app, byTest(form, 'raise-issue'));
    expect(app.callsOf('issues.raise')).toEqual([
      { workstream: 'alderwick', title: 'Invoices go out late' },
    ]);
  });
});
