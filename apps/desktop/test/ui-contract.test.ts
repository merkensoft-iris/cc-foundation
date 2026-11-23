/**
 * The shell on the UI contract (ADR 0008 decision 1, 09 P1-24): `window.cc.shell()` reports
 * the API version of `@cc/ui-sdk/v1`, which the default UI (`@cc/ui`) speaks
 * (`packages/ui/test/ui-contract.test.ts`) and an engine's UI is built against.
 */
import { describe, expect, it } from 'vitest';

import * as sdk from '@cc/ui-sdk/v1';

import { SHELL_API_VERSION } from '../src/main/ipc.js';

describe('the shell on @cc/ui-sdk/v1', () => {
  it("speaks the SDK's window.cc API version", () => {
    expect(SHELL_API_VERSION).toBe(sdk.API_VERSION);
  });
});
