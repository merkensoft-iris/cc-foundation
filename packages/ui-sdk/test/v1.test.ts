/**
 * `@cc/ui-sdk/v1`, the UI contract (ADR 0008 decision 1, 09 P1-24): the typed client, the
 * apiVersion check, the theme tokens and the scope lists. The type-level checks run under
 * `pnpm typecheck`, which compiles this file.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import { GRANT_ONLY_SCOPES as CORE_GRANT_ONLY_SCOPES } from '@cc/core';
import {
  apiMethods,
  EXTENSION_API_CURRENT,
  GrantOnlyScope,
  methods,
  Scope,
  type BackupDestination,
} from '@cc/schemas';
import {
  API_VERSION,
  apiVersionProblem,
  createClient,
  cssVariableName,
  GRANT_ONLY_SCOPES,
  isCcError,
  SCOPES,
  token,
  TOKEN_PATHS,
  type CcBridge,
  type Params,
  type Result,
  type UiMethod,
} from '@cc/ui-sdk/v1';

type Output<T extends { parse(value: unknown): unknown }> = ReturnType<T['parse']>;

describe('@cc/ui-sdk/v1 typed client', () => {
  it('AC-08-10 (UI part) results and params are the @cc/schemas types, not hand-copied ones', () => {
    expectTypeOf<Result<'home.get'>>().toEqualTypeOf<Output<typeof methods.homeGet.result>>();
    expectTypeOf<Result<'meetings.get'>>().toEqualTypeOf<
      Output<typeof methods.meetingsGet.result>
    >();
    expectTypeOf<Params<'items.drop'>['reason']>().toEqualTypeOf<string>();
    // The window names a backup folder; main's folder picker adds its path (04 §9.1 rule 5).
    expectTypeOf<
      Params<'backups.destination'>['destination']
    >().not.toEqualTypeOf<BackupDestination | null>();
    const folder: Params<'backups.destination'> = {
      destination: { kind: 'folder', label: 'Synced folder' },
    };
    expect(folder.destination?.kind).toBe('folder');
  });

  it('AC-08-10 (UI part) only methods marked ui are in the client', () => {
    expectTypeOf<'home.get'>().toExtend<UiMethod>();
    expectTypeOf<'auth.hello'>().not.toExtend<UiMethod>();
    expectTypeOf<'confirmations.wait'>().not.toExtend<UiMethod>();
    const client = createClient({ invoke: () => Promise.resolve({}) });
    // @ts-expect-error auth.hello is not marked ui: main refuses it to the window.
    void client.call('auth.hello', { principal: 'claude-code', nonce: 'x' });
    // @ts-expect-error items.drop needs a reason (03 §6).
    void client.call('items.drop', { ref: 'A-0142' });
  });

  it('calls window.cc.invoke with the method and params, and passes its answer and errors on', async () => {
    const seen: { method: string; params: unknown }[] = [];
    const bridge: Pick<CcBridge, 'invoke'> = {
      invoke: (method, params) => {
        seen.push({ method, params });
        if (method === 'items.drop') {
          return Promise.reject({ code: 'E_STATE', message: 'already done', help: [] });
        }
        return Promise.resolve({ principals: [], total: 0 });
      },
    };
    const client = createClient(bridge);
    const list = await client.call('principals.list', {});
    expect(list).toEqual({ principals: [], total: 0 });
    const error: unknown = await client
      .call('items.drop', { ref: 'A-0142', reason: 'superseded' })
      .catch((caught: unknown) => caught);
    expect(isCcError(error)).toBe(true);
    expect(seen).toEqual([
      { method: 'principals.list', params: {} },
      { method: 'items.drop', params: { ref: 'A-0142', reason: 'superseded' } },
    ]);
  });

  it('every window-side params override belongs to a method marked ui', () => {
    const overridden = apiMethods.filter((definition) => definition.uiParams !== undefined);
    expect(overridden.map((definition) => definition.method)).toEqual(['backups.destination']);
    expect(overridden.every((definition) => definition.ui)).toBe(true);
  });
});

describe('@cc/ui-sdk/v1 apiVersion', () => {
  it('speaks the current extension API (08 §4.3)', () => {
    expect(API_VERSION).toBe(EXTENSION_API_CURRENT);
  });

  it('accepts a shell on its version and explains any other', () => {
    expect(apiVersionProblem({ apiVersion: 1 })).toBeUndefined();
    expect(apiVersionProblem({ apiVersion: 2 })).toBe(
      "This app's UI was built for window.cc API 1, but the app shell speaks API 2. Rebuild the app from your engine (pnpm cc:upgrade, then pnpm build).",
    );
  });
});

describe('@cc/ui-sdk/v1 tokens and scopes', () => {
  it('token() reads the custom property cc-build compiles each theme token to', () => {
    expect(token('color.accent')).toBe('var(--cc-color-accent)');
    expect(token('color.textMuted')).toBe('var(--cc-color-text-muted)');
    expect(cssVariableName('density.scale')).toBe('--cc-density-scale');
    expect(new Set(TOKEN_PATHS.map(cssVariableName)).size).toBe(TOKEN_PATHS.length);
  });

  it('the scope lists are the ones of @cc/schemas and the core, in 07 §5 order', () => {
    expect(SCOPES).toEqual(Scope.options);
    expect(GRANT_ONLY_SCOPES).toEqual(GrantOnlyScope.options);
    expect(GRANT_ONLY_SCOPES).toEqual(CORE_GRANT_ONLY_SCOPES);
  });
});
