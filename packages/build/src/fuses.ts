/**
 * The Electron fuses every engine build sets (04 §10 rule 5), keyed by their
 * `@electron/fuses` `FuseV1Options` names. Fuses are flipped in the packaged binary, so they
 * are applied when `@cc/build` packages the app (09 P1-16); the running shell's own
 * hardening is in `@cc/desktop` (`src/main/hardening.ts`).
 *
 * - RunAsNode off: the app binary cannot be used as plain Node (`ELECTRON_RUN_AS_NODE`).
 * - EnableNodeOptionsEnvironmentVariable off: `NODE_OPTIONS` cannot inject code.
 * - EnableNodeCliInspectArguments off: `--inspect` cannot attach a debugger.
 * - EnableEmbeddedAsarIntegrityValidation on: a modified `app.asar` does not load.
 * - OnlyLoadAppFromAsar on: the app runs only from its asar, never from a loose folder.
 */
export const REQUIRED_FUSES = {
  RunAsNode: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
} as const satisfies Readonly<Record<string, boolean>>;

export type RequiredFuse = keyof typeof REQUIRED_FUSES;
