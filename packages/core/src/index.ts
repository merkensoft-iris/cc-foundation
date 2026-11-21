/**
 * @cc/core: the core service (04 §3): local API server, principals and tokens, actor rules,
 * the human-only gate, schedulers on an injected clock. Headless mode is `@cc/core/headless`
 * and the local API client is `@cc/core/client` (P1-04; ADR 0002).
 */
export const PACKAGE_NAME = '@cc/core';

export {
  applyPendingRestore,
  archiveName,
  Backups,
  BACKUPS_DIRNAME,
  parseArchiveName,
  type BackupAttention,
  type BackupManifest,
  type BackupPush,
  type BackupsOptions,
} from './backups/engine.js';
export {
  extractArchive,
  readArchiveHeader,
  writeArchive,
  type ArchiveHeader,
} from './backups/format.js';
export {
  deriveBackupKey,
  keyIdOf,
  parseKey,
  parseKeys,
  randomBackupKey,
  SCRYPT_PARAMS,
  serializeKey,
  type BackupKey,
  type KdfParams,
  type SerializedBackupKey,
} from './backups/keys.js';
export { DEFAULT_RETENTION, selectKept, type Retention } from './backups/retention.js';
export { systemClock, type Clock, type TimerHandle } from './clock.js';
export {
  canonicalJson,
  ConfirmIntents,
  DEFAULT_INTENT_TTL_MS,
  isNeedsConfirmation,
  MAX_PENDING_INTENTS,
  payloadHashOf,
  type ConfirmationIntent,
  type ConfirmIntentsOptions,
  type ConfirmRule,
  type NeedsConfirmation,
} from './confirm-intents.js';
export { confirmRules } from './confirm-previews.js';
export {
  actorOf,
  AUTH_METHODS,
  Dispatcher,
  type Caller,
  type DispatcherOptions,
  type Handler,
  type HandlerContext,
} from './dispatch.js';
export {
  assertPrivateDir,
  assertSocketPathFits,
  discoverEndpoint,
  maxSocketPathBytes,
  pipeName,
  planEndpoint,
  recordPathOf,
  runDirOf,
  type DiscoveredEndpoint,
  type EndpointPlan,
  type EndpointRecord,
} from './endpoint.js';
export { domainCaller, domainContext } from './domain.js';
export {
  AGENT_ACCESS_HELP,
  APP_NOT_RUNNING_HELP,
  CoreError,
  asCoreError,
  isCoreError,
} from './errors.js';
export { registerBackupHandlers } from './handlers/backups.js';
export { registerItemHandlers, toDomainEvidence } from './handlers/items.js';
export { registerReadHandlers } from './handlers/reads.js';
export { periodStart, registerWriteHandlers } from './handlers/writes.js';
export {
  deepLink,
  DEEP_LINK_SCHEME,
  HUMAN_ONLY_OPERATIONS,
  humanOnlyOperation,
  humanRequired,
  isHumanOnlyMethod,
  isShellConfirmed,
  type HumanOnlyOperation,
  type LinkKind,
} from './human-only.js';
export { newId, ulid } from './ids.js';
export { silentLogger, stderrLogger, type Logger } from './logger.js';
export {
  CLI_DEFAULT,
  CLI_DEFAULT_SCOPES,
  GRANT_ONLY_SCOPES,
  LAST_USED_RESOLUTION_MS,
  Principals,
  summarize,
  type NewPrincipal,
  type PrincipalChange,
  type PrincipalDirectory,
  type PrincipalSummary,
  type PrincipalWrite,
} from './principals.js';
export {
  registryOf,
  type BindingId,
  type BindingSummary,
  type CommandOutcome,
  type EventOnly,
  type RecordStore,
  type RecordView,
} from './records.js';
export { StorePrincipalDirectory } from './store-principals.js';
export {
  NO_INSTALLED_ACTIONS,
  StoreRecordStore,
  type BindingRow,
  type InstalledActions,
  type StoreRecordStoreOptions,
} from './store-records.js';
export {
  Meetings,
  sha256,
  writeBlob,
  type CaptureRequest,
  type MeetingsOptions,
  type PrereadResult,
} from './meetings.js';
export {
  nextNightly,
  NIGHTLY_AT,
  RHYTHM_MEETINGS_JOB,
  RHYTHM_NIGHTLY_JOB,
  rfc3339,
  runHorizonExtension,
  runMissedJob,
  type RhythmJobName,
  type RhythmJobs,
  type RhythmListener,
  type RhythmRun,
} from './rhythm-jobs.js';
export { storeRhythmStore } from './rhythm-store.js';
export { MAX_TIMER_MS, Scheduler, type Job, type JobStatus, type NextDue } from './scheduler.js';
export {
  BACKUP_CHECK_INTERVAL_MS,
  BACKUP_JOB,
  startCore,
  WATCHDOG_INTERVAL_MS,
  WATCHDOG_JOB,
  type CoreHandle,
  type CoreOptions,
  type CoreService,
  type WatchdogOutcome,
} from './service.js';
export { tokenPathOf, tokensDirOf } from './tokens.js';
export { serveUiPort, type UiPort, type UiRequest, type UiResponse } from './ui-port.js';
