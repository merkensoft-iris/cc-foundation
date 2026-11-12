/**
 * The command catalogue against the design (07 §4) and @cc/schemas.
 */
import { describe, expect, it } from 'vitest';

import { ActionKind, apiMethods, DecisionStatus, Health, Lifecycle, methods } from '@cc/schemas';

import { HANDLERS } from '../src/cli.js';
import { HUMAN_ONLY_VERBS } from '../src/help.js';
import {
  ACTION_KINDS,
  COMMANDS,
  DECISION_STATUSES,
  GOAL_PERIODS,
  HEALTHS,
  ISSUE_STATUSES,
  ITEM_FIELDS,
  LIFECYCLES,
  REVERSIBILITIES,
  SEARCH_TYPES,
} from '../src/spec.js';

describe('cc-axi command catalogue', () => {
  it('C-07-02 no command calls a human-only method or is named for a human-only operation', () => {
    for (const command of COMMANDS) {
      for (const name of command.methods) {
        const definition = apiMethods.find((method) => method.method === name);
        expect(definition, `${command.path} calls ${name}`).toBeDefined();
        expect(definition?.humanOnly, `${command.path} calls ${name}`).toBe(false);
      }
      for (const word of command.path.split(' ')) expect(HUMAN_ONLY_VERBS.has(word)).toBe(false);
    }
    // The one human-only method P1-01 defines is not reachable from the catalogue.
    expect(COMMANDS.flatMap((command) => command.methods)).not.toContain('items.drop');
  });

  it('C-07-03 every command calls only local API methods defined in @cc/schemas', () => {
    const known = new Set(apiMethods.map((method) => method.method));
    for (const command of COMMANDS) {
      for (const name of command.methods) expect(known.has(name), name).toBe(true);
    }
  });

  it('AC-07-01 every catalogue command has a handler, and every handler a catalogue entry', () => {
    expect(Object.keys(HANDLERS).sort()).toEqual(COMMANDS.map((command) => command.path).sort());
  });

  it('AC-07-01 every command has 2 or 3 examples that start with cc-axi and use only its flags', () => {
    for (const command of COMMANDS) {
      expect(command.examples.length, command.path).toBeGreaterThanOrEqual(2);
      expect(command.examples.length, command.path).toBeLessThanOrEqual(3);
      const valid = new Set([...command.flags.map((flag) => flag.name), '--format', '--principal']);
      for (const example of command.examples) {
        expect(example.startsWith('cc-axi'), example).toBe(true);
        for (const flag of example.match(/(?<=\s)--[a-z-]+/g) ?? []) {
          expect(valid.has(flag), `${example}: ${flag}`).toBe(true);
        }
      }
    }
  });

  it('AC-07-01 lists show at most 4 default fields, and every list names its rows', () => {
    for (const command of COMMANDS.filter((entry) => entry.kind === 'list')) {
      expect(command.listKey, command.path).toBeDefined();
      expect(command.columns?.length, command.path).toBeGreaterThan(0);
      expect(command.columns?.length, command.path).toBeLessThanOrEqual(4);
    }
  });

  it('the value lists the parser checks equal the enums of @cc/schemas', () => {
    expect([...LIFECYCLES]).toEqual(Lifecycle.options);
    expect([...HEALTHS]).toEqual(Health.options);
    expect([...ACTION_KINDS]).toEqual(ActionKind.options);
    expect([...DECISION_STATUSES]).toEqual(DecisionStatus.options);
    expect([...ISSUE_STATUSES]).toEqual(methods.IssueStatus.options);
    expect([...SEARCH_TYPES]).toEqual(methods.SearchType.options);
    expect([...ITEM_FIELDS]).toEqual(methods.ItemField.options);
    expect([...REVERSIBILITIES]).toEqual(
      methods.decisionsPropose.params.shape.reversibility.unwrap().options,
    );
    expect([...GOAL_PERIODS]).toEqual(methods.goalsList.params.shape.period.unwrap().options);
  });
});
