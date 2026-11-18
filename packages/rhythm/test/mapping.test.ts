/**
 * The calendar mapping check of 02 §9.6 rule 4 (P1-20): bindings that implement calendar@1 and
 * exactly one primary target per routed series. The API-level proof of AC-02-12 (E_INVARIANT,
 * nothing written) is in packages/core/test/onboarding.test.ts.
 */
import type { CalendarMapping, ToolAnswer } from '@cc/schemas';
import { describe, expect, it } from 'vitest';

import { checkCalendarMapping, type MappedSeries } from '@cc/rhythm';

const TOOLS: ToolAnswer[] = [
  {
    workstreamKeys: ['alderwick', 'quillmarsh'],
    category: 'calendar',
    toolName: 'Google Calendar',
    accountLabel: 'gcal-main',
    choice: { kind: 'connector', connectorId: 'google-calendar' },
  },
  {
    workstreamKeys: ['quillmarsh'],
    category: 'calendar',
    toolName: 'Outlook',
    accountLabel: 'outlook-quillmarsh',
    choice: { kind: 'connector', connectorId: 'microsoft-calendar' },
  },
  {
    workstreamKeys: ['alderwick'],
    category: 'calendar',
    toolName: 'Fastmail',
    choice: { kind: 'later' },
  },
  {
    workstreamKeys: ['alderwick'],
    category: 'email',
    toolName: 'Gmail',
    accountLabel: 'gmail-alderwick',
    choice: { kind: 'connector', connectorId: 'gmail' },
  },
];

const SERIES: MappedSeries[] = [
  {
    name: 'Daily start',
    workstreamKeys: ['alderwick', 'quillmarsh'],
    backboneMeetingKey: 'portfolio.daily-start',
  },
  { name: 'Alderwick weekly', workstreamKeys: ['alderwick'], backboneMeetingKey: 'weekly' },
  { name: 'Quillmarsh weekly', workstreamKeys: ['quillmarsh'], backboneMeetingKey: 'weekly' },
];

const primary = (binding: string, calendar = 'Command Center') =>
  ({ binding, calendar, role: 'primary' }) as const;
const mirror = (binding: string, calendar = 'Command Center') =>
  ({ binding, calendar, role: 'mirror' }) as const;

describe('checkCalendarMapping (02 §9.6 rule 4)', () => {
  it('accepts one primary per routed series on calendar@1 bindings, with mirrors', () => {
    const mapping: CalendarMapping = {
      providers: ['google-calendar', 'microsoft-calendar'],
      routes: [
        { workstreams: 'all', targets: [primary('gcal-main')] },
        { workstreams: ['quillmarsh'], targets: [mirror('outlook-quillmarsh')] },
      ],
    };
    expect(checkCalendarMapping(mapping, TOOLS, SERIES)).toEqual([]);
  });

  it('leaves a series no route names unrouted (.ics only), and routes portfolio series as "portfolio"', () => {
    const mapping: CalendarMapping = {
      providers: ['google-calendar'],
      routes: [{ workstreams: ['portfolio', 'alderwick'], targets: [primary('gcal-main')] }],
    };
    expect(checkCalendarMapping(mapping, TOOLS, SERIES)).toEqual([]);
    const onlyMirror: CalendarMapping = {
      providers: ['google-calendar'],
      routes: [{ workstreams: ['portfolio'], targets: [mirror('gcal-main')] }],
    };
    expect(checkCalendarMapping(onlyMirror, TOOLS, SERIES).map((v) => v.text)).toEqual([
      'Daily start has no primary calendar target; a series has exactly one primary (02 §9.4).',
    ]);
  });

  it('AC-02-12 a route whose binding does not implement calendar@1 is a violation: a non-calendar tool, a connector not in providers, a tool without a connector, an unknown label', () => {
    const mapping: CalendarMapping = {
      providers: ['google-calendar', 'gmail'],
      routes: [
        { workstreams: 'all', targets: [primary('gcal-main')] },
        {
          workstreams: ['alderwick'],
          targets: [mirror('gmail-alderwick'), mirror('Fastmail'), mirror('nowhere')],
        },
        { workstreams: ['quillmarsh'], targets: [mirror('outlook-quillmarsh')] },
      ],
    };
    const violations = checkCalendarMapping(mapping, TOOLS, SERIES);
    expect(violations.every((v) => v.kind === 'binding_not_calendar')).toBe(true);
    expect(violations.map((v) => v.text.match(/"([^"]+)"/)?.[1])).toEqual([
      'gmail-alderwick',
      'Fastmail',
      'nowhere',
      'outlook-quillmarsh',
    ]);
  });

  it('AC-02-12 a routed series with no primary target, or with two, is a violation', () => {
    const mapping: CalendarMapping = {
      providers: ['google-calendar', 'microsoft-calendar'],
      routes: [
        { workstreams: ['alderwick'], targets: [mirror('gcal-main')] },
        {
          workstreams: ['quillmarsh'],
          targets: [primary('gcal-main'), primary('outlook-quillmarsh')],
        },
      ],
    };
    expect(checkCalendarMapping(mapping, TOOLS, SERIES)).toEqual([
      {
        kind: 'primary_count',
        text: 'Alderwick weekly has no primary calendar target; a series has exactly one primary (02 §9.4).',
      },
      {
        kind: 'primary_count',
        text: 'Quillmarsh weekly has 2 primary calendar targets; a series has exactly one primary (02 §9.4).',
      },
    ]);
  });

  it('counts the same calendar named by two routes once', () => {
    const mapping: CalendarMapping = {
      providers: ['google-calendar'],
      routes: [
        { workstreams: 'all', targets: [primary('gcal-main')] },
        { workstreams: ['alderwick'], targets: [primary('gcal-main')] },
      ],
    };
    expect(checkCalendarMapping(mapping, TOOLS, SERIES)).toEqual([]);
  });
});
