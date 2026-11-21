/**
 * `@cc/ui-sdk/v1`: the UI contract of extension API 1 (ADR 0008 decision 1; versioned entry
 * points, ADR 0003 decision 2). Everything a UI that runs in Command Center's window builds
 * on, the default UI and an engine's own alike:
 *
 * - the `window.cc` bridge types (`CcBridge`, `ShellInfo`, `Route`, `CcError`)
 * - the typed client generated from @cc/schemas (`createClient`, `Params`, `Result`), whose
 *   methods are stable within the version, and `apiVersionProblem` for a shell on another one
 * - the app's routes (`AppRoute`) and the screen contract (`Ui`, `Screen`)
 * - the theme tokens (`token()`) and the principal scopes
 *
 * The package has no run-time dependencies: it imports @cc/schemas and zod only as types
 * (rule D3), so a UI bundle carries none of the core's code.
 */
export {
  isCcError,
  type CcBridge,
  type CcError,
  type RebuildState,
  type Route,
  type ShellInfo,
  type StartMode,
} from './bridge.js';
export {
  API_VERSION,
  apiVersionProblem,
  createClient,
  type ApiVersion,
  type Client,
  type Params,
  type Result,
  type UiMethod,
  type UiMethods,
} from './client.js';
export type { AppRoute, ItemsTab, OnboardingStep, ScreenName, SettingsSection } from './routes.js';
export type { Screen, Ui } from './screen.js';
export {
  GRANT_ONLY_SCOPES,
  SCOPES,
  type Assert,
  type GrantOnlyScope,
  type ListsAll,
  type Scope,
  type ScopeListsComplete,
} from './scopes.js';
export { cssVariableName, token, TOKEN_PATHS, type TokenPath } from './tokens.js';
