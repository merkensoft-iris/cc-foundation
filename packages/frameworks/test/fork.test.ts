/** Forking (01 §9 level 5, AC-01-08). */
import { describe, expect, it } from 'vitest';

import {
  checkInvariants,
  findTemplate,
  forkTemplate,
  FrameworkError,
  frameworkLabel,
  validateInstance,
} from '@cc/frameworks';
import type { FrameworkTemplate } from '@cc/schemas';

import { alderwick } from './states.ts';

function eosLite(): FrameworkTemplate {
  const found = findTemplate('eos-lite');
  if (found === undefined) throw new Error('no eos-lite');
  return found;
}

describe('forking a template to custom:<name>', () => {
  it('AC-01-08 forking eos-lite to custom:ald-weekly and removing E-5 is allowed', () => {
    const fork = forkTemplate(eosLite(), { name: 'ald-weekly', removeInvariants: ['E-5'] });
    expect(fork.id).toBe('custom:ald-weekly');
    expect(fork.version).toBe('1.0.0');
    expect(fork.forkedFrom).toEqual({ templateId: 'eos-lite', version: '1.0.0' });
    expect(fork.backbone.invariants.map((invariant) => invariant.id)).toEqual([
      'E-1',
      'E-2',
      'E-3',
      'E-4',
      'E-6',
      'E-7',
      'E-8',
    ]);
    // The fork's instances are no longer held to E-5; eos-lite's still are.
    const state = alderwick();
    const discussed = {
      ...state,
      instance: {
        ...state.instance,
        templateId: fork.id,
        templateVersion: fork.version,
        forkedFrom: fork.forkedFrom,
      },
      actionReview: [{ actionItemId: 'act_a0142', outcome: 'discussed' }],
    };
    expect(validateInstance(fork, discussed).ok).toBe(true);
    expect(
      checkInvariants(eosLite(), { ...state, actionReview: discussed.actionReview }),
    ).toHaveLength(1);
  });

  it('AC-01-08 the instance and template are labelled "custom (based on eos-lite 1.0.0)"', () => {
    const fork = forkTemplate(eosLite(), { name: 'ald-weekly', removeInvariants: ['E-5'] });
    expect(frameworkLabel(fork)).toBe('custom (based on eos-lite 1.0.0)');
    expect(
      frameworkLabel({
        templateId: fork.id,
        templateVersion: fork.version,
        forkedFrom: { templateId: 'eos-lite', version: '1.0.0' },
      }),
    ).toBe('custom (based on eos-lite 1.0.0)');
    expect(frameworkLabel(eosLite())).toBe('eos-lite 1.0.0');
  });

  it('drops the source name and keeps the source unchanged', () => {
    const source = eosLite();
    const before = structuredClone(source);
    const fork = forkTemplate(source, { name: 'ald-weekly', removeInvariants: ['E-5'] });
    expect(fork.name).toBe('ald-weekly');
    expect(fork.name).not.toMatch(/eos/i);
    expect(source).toEqual(before);
  });

  it('may change parameter bounds, still within a valid template', () => {
    const source = eosLite();
    const priorityCount = source.parameters.find((spec) => spec.key === 'priorityCount');
    if (priorityCount === undefined) throw new Error('no priorityCount');
    const fork = forkTemplate(source, {
      name: 'seven-rocks',
      parameters: [{ ...priorityCount, max: 7 }],
    });
    expect(fork.parameters.find((spec) => spec.key === 'priorityCount')?.max).toBe(7);
    expect(() =>
      forkTemplate(source, { name: 'bad', parameters: [{ ...priorityCount, max: 7, default: 9 }] }),
    ).toThrow(FrameworkError);
  });

  it('rejects a name that is not a slug and an invariant the source does not have', () => {
    const error = (fn: () => unknown) => {
      try {
        fn();
      } catch (thrown) {
        return (thrown as FrameworkError).code;
      }
      return 'none';
    };
    expect(error(() => forkTemplate(eosLite(), { name: 'Ald Weekly' }))).toBe('E_USAGE');
    expect(error(() => forkTemplate(eosLite(), { name: 'x', removeInvariants: ['X-1'] }))).toBe(
      'E_USAGE',
    );
  });
});
