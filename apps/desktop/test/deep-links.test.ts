import path from 'node:path';

import { deepLink, DEEP_LINK_SCHEME as CORE_SCHEME } from '@cc/core';
import { describe, expect, it } from 'vitest';

import { parseShellArgs } from '../src/main/args.js';
import { DEEP_LINK_SCHEME, deepLinkInArgv, linkOf, parseDeepLink } from '../src/main/deep-links.js';

describe('commandcenter:// deep links (04 §4.3 rule 3, 02 §9.2 rule 2)', () => {
  it('parses every link form the design names', () => {
    expect(parseDeepLink('commandcenter://')).toEqual({ kind: 'home' });
    expect(parseDeepLink('commandcenter://items/A-0142')).toEqual({
      kind: 'items',
      target: 'A-0142',
    });
    expect(parseDeepLink('commandcenter://confirmations/cfm_7q2')).toEqual({
      kind: 'confirmations',
      target: 'cfm_7q2',
    });
    expect(parseDeepLink('commandcenter://requests/req_01J9')).toEqual({
      kind: 'requests',
      target: 'req_01J9',
    });
    expect(parseDeepLink('commandcenter://meeting/ins_2026_11_13')).toEqual({
      kind: 'meeting',
      target: 'ins_2026_11_13',
    });
    expect(parseDeepLink('commandcenter://items/A-0142/')).toEqual({
      kind: 'items',
      target: 'A-0142',
    });
  });

  it('drops anything else', () => {
    for (const link of [
      'https://items/A-0142',
      'commandcenter:items/A-0142',
      'commandcenter://settings/x_1',
      'commandcenter://items/../../etc',
      'commandcenter://items/A-0142?x=1',
      'commandcenter://items/A-0142#x',
      'commandcenter://items/a-0142',
      'commandcenter://items/A-0142/extra',
      'commandcenter://user@items/A-0142',
      'commandcenter://items/%2e%2e',
      'commandcenter://items/' + 'a_'.repeat(200),
      'commandcenter://ITEMS/A-0142',
    ]) {
      expect(parseDeepLink(link), link).toBeUndefined();
    }
  });

  it('round-trips through linkOf', () => {
    for (const link of ['commandcenter://', 'commandcenter://items/A-0142']) {
      const route = parseDeepLink(link);
      expect(route && linkOf(route)).toBe(link);
    }
  });

  it('finds a link in a second instance argv (Windows and Linux)', () => {
    expect(
      deepLinkInArgv(['/opt/cc/command-center', '--no-sandbox', 'commandcenter://items/A-0142']),
    ).toBe('commandcenter://items/A-0142');
    expect(deepLinkInArgv(['/opt/cc/command-center'])).toBeUndefined();
  });
});

describe('shell arguments', () => {
  it('reads --profile-dir in both spellings, as an absolute path', () => {
    expect(parseShellArgs(['main.js', '--profile-dir', '/tmp/cc-dev-x']).profileDir).toBe(
      path.resolve('/tmp/cc-dev-x'),
    );
    expect(parseShellArgs(['--profile-dir=cc-dev-y']).profileDir).toBe(path.resolve('cc-dev-y'));
    expect(parseShellArgs(['main.js'])).toEqual({});
  });

  it('--smoke runs only on a throwaway profile (--profile-dir)', () => {
    expect(parseShellArgs(['--smoke', '--profile-dir', '/tmp/cc-smoke'])).toEqual({
      profileDir: path.resolve('/tmp/cc-smoke'),
      smoke: true,
    });
    expect(() => parseShellArgs(['--smoke'])).toThrow(/--smoke needs --profile-dir/);
  });

  it('refuses --profile-dir without a directory', () => {
    expect(() => parseShellArgs(['--profile-dir'])).toThrow(/needs a directory/);
    expect(() => parseShellArgs(['--profile-dir', '--other'])).toThrow(/needs a directory/);
  });
});

describe('the shell reads the links the core writes (04 §4.3 rule 3)', () => {
  it('parses every link @cc/core deepLink makes, back to the same link', () => {
    expect(DEEP_LINK_SCHEME).toBe(CORE_SCHEME);
    for (const kind of ['items', 'confirmations', 'requests', 'meeting'] as const) {
      for (const target of ['A-0142', 'cfm_7q2', 'req_01J9', 'ins_2026_11_13']) {
        const link = deepLink(kind, target);
        const route = parseDeepLink(link);
        expect(route).toEqual({ kind, target });
        expect(route === undefined ? undefined : linkOf(route)).toBe(link);
      }
    }
    expect(parseDeepLink(deepLink('app'))).toEqual({ kind: 'home' });
  });
});
