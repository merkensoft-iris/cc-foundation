/**
 * Agenda template sections for composition tests. The templates themselves (02 §5) are P1-08's;
 * these copy the 02 §5.1 (solo merged) and §5.2 timeboxes, with test minimums and maximums.
 */
import type { AgendaTemplateSpec } from '@cc/rhythm';

/** 02 §5.1, solo merged column; minimums are test data (the templates are P1-08's). */
export const WEEKLY: AgendaTemplateSpec = {
  id: 'agenda.eos-lite.weekly@1',
  sections: [
    {
      id: 'check_in',
      type: 'check_in',
      timeboxMinutes: 2,
      minMinutes: 1,
      maxMinutes: 5,
      backbone: true,
      perWorkstream: false,
    },
    {
      id: 'scorecard',
      type: 'scorecard',
      timeboxMinutes: 4,
      minMinutes: 2,
      maxMinutes: 10,
      backbone: true,
      perWorkstream: true,
    },
    {
      id: 'goals_review',
      type: 'goals_review',
      timeboxMinutes: 3,
      minMinutes: 1,
      maxMinutes: 10,
      backbone: true,
      perWorkstream: true,
    },
    {
      id: 'action_review',
      type: 'action_review',
      timeboxMinutes: 7,
      minMinutes: 3,
      maxMinutes: 15,
      backbone: true,
      perWorkstream: true,
    },
    {
      id: 'headlines',
      type: 'headlines',
      timeboxMinutes: 3,
      minMinutes: 1,
      maxMinutes: 5,
      backbone: true,
      perWorkstream: false,
    },
    {
      id: 'issues',
      type: 'issues',
      timeboxMinutes: 22,
      minMinutes: 5,
      maxMinutes: 45,
      backbone: true,
      perWorkstream: false,
    },
    {
      id: 'conclude',
      type: 'conclude',
      timeboxMinutes: 5,
      minMinutes: 2,
      maxMinutes: 10,
      backbone: true,
      perWorkstream: false,
    },
  ],
};

/** 02 §5.2, 90 minutes standalone. */
export const MONTHLY: AgendaTemplateSpec = {
  id: 'agenda.eos-lite.monthly@1',
  sections: [
    {
      id: 'check_in',
      type: 'check_in',
      timeboxMinutes: 5,
      minMinutes: 2,
      maxMinutes: 10,
      backbone: true,
      perWorkstream: false,
    },
    {
      id: 'money_ops',
      type: 'money_ops',
      timeboxMinutes: 25,
      minMinutes: 15,
      maxMinutes: 40,
      backbone: false,
      perWorkstream: false,
    },
    {
      id: 'scorecard',
      type: 'scorecard',
      timeboxMinutes: 15,
      minMinutes: 10,
      maxMinutes: 20,
      backbone: true,
      perWorkstream: false,
    },
    {
      id: 'register_health',
      type: 'register_health',
      timeboxMinutes: 10,
      minMinutes: 5,
      maxMinutes: 15,
      backbone: true,
      perWorkstream: false,
    },
    {
      id: 'risk_review',
      type: 'risk_review',
      timeboxMinutes: 10,
      minMinutes: 5,
      maxMinutes: 15,
      backbone: false,
      perWorkstream: false,
    },
    {
      id: 'issues',
      type: 'issues',
      timeboxMinutes: 20,
      minMinutes: 10,
      maxMinutes: 30,
      backbone: true,
      perWorkstream: false,
    },
    {
      id: 'conclude',
      type: 'conclude',
      timeboxMinutes: 5,
      minMinutes: 2,
      maxMinutes: 10,
      backbone: true,
      perWorkstream: false,
    },
  ],
};
