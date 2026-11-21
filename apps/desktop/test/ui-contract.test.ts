/**
 * The renderer on the UI contract (ADR 0008 decision 1, 09 P1-24): it loads no package code at
 * run time (rule D3), so it keeps its own copies of the few run-time pieces of
 * `@cc/ui-sdk/v1` it needs. These must say what the SDK says.
 */
import { describe, expect, it } from 'vitest';

import * as sdk from '@cc/ui-sdk/v1';

import { SHELL_API_VERSION } from '../src/main/ipc.js';
import { GRANT_ONLY_SCOPES, SCOPES } from '../src/renderer/app/api.js';
import { API_VERSION, apiVersionProblem } from '../src/renderer/app/api-version.js';

describe('the renderer on @cc/ui-sdk/v1', () => {
  it("speaks the shell's window.cc API version, and explains another as the SDK does", () => {
    expect(API_VERSION).toBe(sdk.API_VERSION);
    expect(API_VERSION).toBe(SHELL_API_VERSION);
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
