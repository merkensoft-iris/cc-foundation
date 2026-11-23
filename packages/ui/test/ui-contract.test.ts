/**
 * The default UI on the UI contract (ADR 0008 decision 1, 09 P1-24): main serves it unbundled
 * and it loads no package code at run time (rule D3), so it keeps its own copies of the few
 * run-time pieces of `@cc/ui-sdk/v1` it needs. These must say what the SDK says. That the
 * shell speaks the same version is `apps/desktop/test/ui-contract.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import * as sdk from '@cc/ui-sdk/v1';

import { GRANT_ONLY_SCOPES, SCOPES } from '../src/app/api.js';
import { API_VERSION, apiVersionProblem } from '../src/app/api-version.js';

describe('the default UI on @cc/ui-sdk/v1', () => {
  it("speaks the SDK's window.cc API version, and explains another as the SDK does", () => {
    expect(API_VERSION).toBe(sdk.API_VERSION);
    expect(apiVersionProblem({ apiVersion: API_VERSION })).toBeUndefined();
    for (const apiVersion of [0, 2]) {
      expect(apiVersionProblem({ apiVersion })).toBe(sdk.apiVersionProblem({ apiVersion }));
    }
  });

  it('lists the scopes of the SDK, in its order', () => {
    expect(SCOPES).toEqual(sdk.SCOPES);
    expect(GRANT_ONLY_SCOPES).toEqual(sdk.GRANT_ONLY_SCOPES);
  });
});
