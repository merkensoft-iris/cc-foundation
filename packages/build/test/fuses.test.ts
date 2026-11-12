import { describe, expect, it } from 'vitest';

import { REQUIRED_FUSES } from '../src/index.js';

describe('Electron fuses (04 §10 rule 5)', () => {
  it('lists exactly the fuses the design sets, for packaging to apply (P1-16)', () => {
    expect(REQUIRED_FUSES).toEqual({
      RunAsNode: false,
      EnableNodeOptionsEnvironmentVariable: false,
      EnableNodeCliInspectArguments: false,
      EnableEmbeddedAsarIntegrityValidation: true,
      OnlyLoadAppFromAsar: true,
    });
  });
});
