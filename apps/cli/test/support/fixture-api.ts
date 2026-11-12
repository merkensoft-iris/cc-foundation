/**
 * The dataset `cc-axi`'s tests and `pnpm cc:axi-conformance` run on: the record fixtures in
 * fixtures/records plus a few synthetic records for counts and truncation. support/core.ts
 * writes it into the test core's workspace store, whose own handlers serve every method.
 *
 * The data is synthetic (AGENTS.md rule 5): the 03 §13 worked examples and records derived
 * from them. "Today" is fixed at 2026-11-13 09:02 in Asia/Kolkata, the 07 §4.3 example.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  ActionItem,
  Decision,
  Evidence,
  Goal,
  Issue,
  Measure,
  MeasureValue,
  Workstream,
} from '@cc/schemas';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export const NOW_UTC = '2026-11-13T03:32:00Z';

export function readFixtures<T>(type: string): T[] {
  const dir = join(ROOT, 'fixtures', 'records', type);
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')) as T);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

const LONG_DONE_MEANS = Array.from(
  { length: 30 },
  (_, index) =>
    `Section ${index + 1} of the runbook is reviewed, its commands are re-run on a clean machine and the results are noted.`,
).join(' ');

export interface FixtureData {
  workstreams: Workstream[];
  items: ActionItem[];
  decisions: Decision[];
  issues: Issue[];
  goals: Goal[];
  measures: Measure[];
  values: MeasureValue[];
  evidence: Evidence[];
}

/** The reference dataset: the record fixtures plus synthetic items for counts and truncation. */
const PRIVATE = 'ws_private';
const PRIVATE_REFS = new Set(['A-0152', 'G-0002']);

export function referenceData(): FixtureData {
  const workstreams = readFixtures<Workstream>('workstream@1');
  const alderwick = workstreams.find((workstream) => workstream.id === 'ws_ald');
  if (alderwick === undefined)
    throw new Error('fixtures/records/workstream@1/alderwick.json is missing');
  workstreams.push({
    ...clone(alderwick),
    id: 'ws_qlm',
    slug: 'quillmarsh',
    name: 'Quillmarsh',
    repoPaths: [],
  });
  // The scenario has no sensitive workstream; the privacy checks (07 §5) use this synthetic
  // one, a confidential project under Alderwick that holds A-0152 and G-0002.
  const { frameworkInstanceId: _inherited, ...parent } = clone(alderwick);
  void _inherited;
  workstreams.push({
    ...parent,
    id: PRIVATE,
    slug: 'private-project',
    name: 'Private project',
    kind: 'project',
    parentId: 'ws_ald',
    privacy: 'sensitive',
    aiDataPolicy: 'redact_people',
    repoPaths: [],
  });
  const toPrivate = <T extends { ref: string; workstreamId: string }>(record: T): T =>
    PRIVATE_REFS.has(record.ref) ? { ...record, workstreamId: PRIVATE } : record;

  const items = readFixtures<ActionItem>('action_item@1').map(toPrivate);
  const template = items.find((item) => item.ref === 'A-0160') ?? items[0];
  if (template === undefined) throw new Error('fixtures/records/action_item@1 is empty');
  const synthetic = (
    number: number,
    title: string,
    due: string,
    changes: Partial<ActionItem> = {},
  ): ActionItem => ({
    ...clone(template),
    id: `act_a0${number}`,
    ref: `A-0${number}`,
    title,
    due: { date: due, timeZone: 'Asia/Kolkata' },
    lifecycle: 'open',
    health: 'on_track',
    execution: { mode: 'manual', steps: [] },
    // INV-03-04: an item outside draft has a required requirement.
    evidenceRequirements: [
      {
        id: 'er1',
        description: 'A link or a note showing it is done',
        required: true,
        acceptedKinds: ['url', 'note'],
      },
    ],
    externalRefs: [],
    version: 1,
    ...changes,
  });
  items.push(
    synthetic(150, 'Ship the Quillmarsh onboarding checklist', '2026-11-16'),
    synthetic(161, 'Write up the runbook review for the operations pack', '2026-11-27', {
      doneMeans: LONG_DONE_MEANS,
      health: 'at_risk',
      healthNote: 'Two sections depend on access the client has not granted yet',
    }),
    synthetic(162, 'Book the venue for the January offsite', '2026-11-09', { lifecycle: 'open' }),
    synthetic(163, 'Publish the November newsletter', '2026-11-30', { lifecycle: 'claimed_done' }),
    synthetic(164, 'Archive the October board pack', '2026-11-02', { lifecycle: 'verified_done' }),
    synthetic(165, 'Draft the Q1 hiring plan', '2026-12-04', { lifecycle: 'draft' }),
  );

  return {
    workstreams,
    items,
    decisions: readFixtures<Decision>('decision@1'),
    issues: readFixtures<Issue>('issue@1'),
    goals: readFixtures<Goal>('goal@1').map(toPrivate),
    measures: readFixtures<Measure>('measure@1'),
    values: readFixtures<MeasureValue>('measure_value@1'),
    evidence: readFixtures<Evidence>('evidence@1'),
  };
}

/** A workspace with its workstreams and nothing else, for the empty states (07 §4.1 rule 5). */
export function emptyData(): FixtureData {
  return {
    workstreams: referenceData().workstreams,
    items: [],
    decisions: [],
    issues: [],
    goals: [],
    measures: [],
    values: [],
    evidence: [],
  };
}
