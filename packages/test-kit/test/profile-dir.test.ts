import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createProfileDir, profileBaseDir, SOCKET_PATH_LIMIT } from '@cc/test-kit';

describe('createProfileDir', () => {
  it('AC-08-04 gives every test its own empty profile directory under the short base path', () => {
    const first = createProfileDir();
    const second = createProfileDir();
    try {
      expect(first.path).not.toBe(second.path);
      expect(first.path.startsWith(profileBaseDir())).toBe(true);
      expect(readdirSync(first.path)).toEqual([]);
    } finally {
      first.cleanup();
      second.cleanup();
    }
    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(second.path)).toBe(false);
  });

  it('AC-08-04 keeps the profile socket path under the UNIX socket limit', () => {
    const profile = createProfileDir();
    try {
      const socketPath = join(profile.path, 'run', 'cc.sock');
      expect(Buffer.byteLength(socketPath)).toBeLessThan(SOCKET_PATH_LIMIT);
    } finally {
      profile.cleanup();
    }
  });
});
