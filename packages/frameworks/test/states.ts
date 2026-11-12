/**
 * Valid instance states of the reference scenario (01 §7, 02 §8, 03 §13), for the validator
 * tests. Each test changes one thing and checks which invariant breaks.
 */
import type { InstanceState, SeriesView } from '@cc/frameworks';

const self = 'per_self';

/** The merged weekly CEO review (02 §4.4, §8.1): perWorkstream sections repeat per workstream. */
export const ceoWeekly: SeriesView = {
  id: 'ser_ceo_weekly',
  backboneMeetingKey: 'weekly',
  status: 'active',
  workstreamIds: ['ws_ald', 'ws_qlm'],
  rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=15;BYMINUTE=0',
  durationMinutes: 60,
  agenda: [
    'check_in',
    'scorecard',
    'scorecard',
    'goals_review',
    'goals_review',
    'action_review',
    'action_review',
    'headlines',
    'content_review',
    'issues',
    'conclude',
  ],
};

const ceoSeries = (key: string, agenda: SeriesView['agenda'], rrule: string): SeriesView => ({
  id: `ser_ceo_${key}`,
  backboneMeetingKey: key,
  status: 'active',
  workstreamIds: ['ws_ald', 'ws_qlm'],
  rrule,
  durationMinutes: 90,
  agenda,
});

const measure = (id: string, role: 'lead' | 'lag' = 'lead') => ({
  id,
  role,
  cadence: 'weekly' as const,
  ownerId: self,
  active: true,
  target: { op: 'gte' as const, value: 1 },
});

/** Alderwick: eos-lite, solo, in the merged weekly CEO review (01 §7.2). */
export function alderwick(): InstanceState {
  return {
    workstreamId: 'ws_ald',
    instance: {
      id: 'fwi_ald',
      workstreamId: 'ws_ald',
      templateId: 'eos-lite',
      templateVersion: '1.0.0',
      mode: 'solo',
      goalModel: 'rocks',
      packIds: ['pack.client-services', 'pack.product', 'pack.marketing'],
      parameters: {
        'weekly.weekday': 'FR',
        'weekly.time': '15:00',
        'weekly.duration': 60,
        priorityCount: 3,
        todoHorizonDays: 7,
      },
    },
    series: [
      ceoWeekly,
      ceoSeries(
        'monthly',
        [
          'check_in',
          'money_ops',
          'scorecard',
          'register_health',
          'risk_review',
          'issues',
          'conclude',
        ],
        'FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=15;BYMINUTE=0',
      ),
      ceoSeries(
        'quarterly',
        [
          'check_in',
          'planning',
          'scorecard',
          'retrospective',
          'rhythm_health',
          'planning',
          'register_health',
          'conclude',
        ],
        'FREQ=YEARLY;BYMONTH=3,6,9,12;BYDAY=-2FR;BYHOUR=9;BYMINUTE=45',
      ),
      ceoSeries(
        'yearly',
        ['retrospective', 'planning', 'planning', 'rhythm_health', 'conclude'],
        'FREQ=YEARLY;BYMONTH=12;BYDAY=2FR;BYHOUR=9;BYMINUTE=45',
      ),
    ],
    goals: [
      'Win two consulting clients',
      'Publish the blog on its plan every week',
      'Keep the client project work within its planned hours',
    ].map((title, index) => ({
      id: `goal_ald_${index + 1}`,
      kind: 'priority' as const,
      status: 'active' as const,
      ownerId: self,
      doneMeans: `${title}: done or not done at quarterly planning`,
      measureIds: [],
    })),
    measures: ['msr_k0001', 'msr_k0002', 'msr_k0003', 'msr_k0004', 'msr_k0005', 'msr_k0006'].map(
      (id) => measure(id),
    ),
    actionItems: [
      {
        id: 'act_a0142',
        kind: 'todo',
        ownerId: self,
        doneMeans: 'The consulting proposal is sent to the lead.',
        lifecycle: 'open',
        createdOn: '2026-11-13',
        due: { date: '2026-11-18' },
        goalIds: [],
      },
    ],
    decisions: [{ id: 'dec_d0008', deciderId: self }],
    issues: [],
  };
}

/** A 4dx goal area (01 §5.2); not in the reference scenario, which runs no 4dx workstream. */
export function goalArea(): InstanceState {
  return {
    workstreamId: 'ws_goal',
    instance: {
      templateId: '4dx',
      templateVersion: '1.0.0',
      mode: 'solo',
      goalModel: 'wig',
      packIds: [],
      parameters: { 'weekly.weekday': 'MO', 'weekly.time': '13:15', 'weekly.duration': 30 },
    },
    series: [
      {
        id: 'ser_goal_wig',
        backboneMeetingKey: 'weekly',
        status: 'active',
        workstreamIds: ['ws_goal'],
        rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=13;BYMINUTE=15',
        durationMinutes: 30,
        agenda: ['action_review', 'scorecard', 'plan_commitments', 'conclude'],
      },
    ],
    goals: [
      {
        id: 'goal_goal_wig',
        kind: 'wig',
        status: 'active',
        ownerId: self,
        measureIds: ['msr_wig_lag', 'msr_wig_lead1', 'msr_wig_lead2'],
        target: { from: 0, to: 1, unit: 'courses launched', by: '2027-03-31' },
      },
    ],
    measures: [measure('msr_wig_lag', 'lag'), measure('msr_wig_lead1'), measure('msr_wig_lead2')],
    actionItems: [
      {
        id: 'act_goal_1',
        kind: 'todo',
        ownerId: self,
        doneMeans: 'Two lessons are recorded.',
        lifecycle: 'open',
        createdOn: '2026-11-09',
        due: { date: '2026-11-16' },
        goalIds: ['goal_goal_wig'],
      },
    ],
  };
}

/** A personal goal area on personal-os (01 §5.1); not in the scenario. */
export function personalArea(): InstanceState {
  return {
    workstreamId: 'ws_health',
    instance: {
      templateId: 'personal-os',
      templateVersion: '1.0.0',
      mode: 'solo',
      goalModel: 'personal_goals',
      packIds: ['pack.personal'],
      parameters: {},
    },
    series: [
      {
        id: 'ser_health_weekly',
        backboneMeetingKey: 'weekly',
        status: 'active',
        workstreamIds: ['ws_health'],
        rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=18;BYMINUTE=0',
        durationMinutes: 45,
        agenda: [
          'check_in',
          'scorecard',
          'goals_review',
          'action_review',
          'plan_commitments',
          'conclude',
        ],
      },
    ],
    goals: [
      {
        id: 'goal_run',
        kind: 'personal_goal',
        status: 'active',
        ownerId: self,
        doneMeans: 'A 10 km run under an hour.',
        measureIds: [],
      },
    ],
    measures: [],
    actionItems: [],
  };
}
