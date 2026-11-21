/**
 * What the preloads of main's prompt windows expose (`src/main/shell-prompts.ts`): two
 * functions each, and nothing else. `id` is the prompt's token, written into its page by main.
 * Main accepts an answer only from the window it opened for that token.
 */

/** The confirm window (`src/preload/confirm.cts`), as `window.ccConfirm`. */
export interface CcConfirmBridge {
  /** The user chose Confirm. */
  approve(id: string): Promise<void>;
  /** The user chose Cancel. */
  deny(id: string): Promise<void>;
}

/** The secret prompt (`src/preload/secret.cts`), as `window.ccSecret`. */
export interface CcSecretBridge {
  /** The secret the user typed. */
  submit(id: string, value: string): Promise<void>;
  /** The user chose Cancel. */
  cancel(id: string): Promise<void>;
}
