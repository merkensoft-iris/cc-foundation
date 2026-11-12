# 05 · Connector architecture

- **Purpose:** Defines connectors as versioned plugins: their two kinds (API and browser), the manifest, the runtime API, sign-in methods, permissions, per-binding settings, execution and scheduling, records, the rule that connectors contain no AI, testing, and the plugin repository used to find, install, version and update them: the signed index in `cc-connectors` for first-party packages, and `connectors.lock` for packages from the user's own connectors repository. Also covers capability contracts such as `calendar@1`, the package rules for AI adapters that live in the same repository, and the tool-inventory step of onboarding.
- **Depends on:** [04](04-platform.md) (Connector Host process model, browser sandbox §5, Policy Engine §7, secrets §9). [03](03-decisions-and-action-items.md) (`ExecutionStep` connector performers, `VerificationCheck`, `Evidence`).
- **Related files:** [06](06-connector-discovery.md) (what happens when no connector exists). [01 §3](01-onboarding-and-frameworks.md#3-onboarding-flow) (step S7). [02 §9](02-rhythm-and-calendar.md#9-calendar-integration) (the `google-calendar` connector). [08](08-repository-and-automation.md) (the `cc-connectors` repository, scaffold, test and publish scripts). [09](09-build-plan.md) (P2 platform, P4 browser connectors, P5 registry and the lock loader).

## 1. Summary

1. A **connector** is a versioned package. It has a `connector.json` manifest and TypeScript code that runs fixed, repeatable actions and syncs against one service. First-party connectors live in the `cc-connectors` repository; a user's own connectors (for example those firstmate builds from a discovery spec) live in the user's connectors repository, made from `cc-connectors` as a template. The user's engine pins both in `connectors.lock` (§15.6).
2. There are two kinds. **API connectors** call a service's API over HTTPS (Google Calendar, Gmail, WordPress, Salesforce, Hootsuite, Hostinger). **Browser connectors** are Playwright scripts that run inside a signed-in browser session from the browser sandbox (WhatsApp Web, LinkedIn).
3. **Connectors contain no AI.** They do not import AI SDKs, call AI hosts, or make judgement calls. Static checks and determinism tests enforce this (§12). Judgement belongs to the AI layer ([04 §6](04-platform.md#6-ai-layer-providers-and-agent-profiles)).
4. The host owns credentials. Connector code never sees a raw API key or OAuth token: the host injects auth into requests, or hands over a guarded browser context.
5. Each **binding** (one connector, one account) has its own settings: sign-in method and credential, schedules, granted permissions, workstreams, and confirmation overrides that may only be stricter than the manifest.
6. The **plugin repository** has two sources. Upstream first-party packages come from a signed index published by `cc-connectors`. Packages from the user's own repository are trusted through the sha256 pin in `connectors.lock`, which the user merged. CC verifies signatures or pins and checksums, shows a permission diff on every update, activates new entries staged and human-only, and keeps the previous versions and a last-known-good lock for rollback.
7. A connector may **implement a capability contract**, such as `calendar@1` ([02 §9.1](02-rhythm-and-calendar.md#91-providers)). The foundation's engines (for example the rhythm engine) call only the contract, so any connector that implements it can serve them.

## 2. Scope and non-goals

- In scope: package format, manifest, runtime API, auth, permissions, bindings, execution, records, testing, versioning, registry, onboarding tool selection.
- Non-goals: discovering a missing connector ([06](06-connector-discovery.md)); AI behaviour; a public third-party marketplace with payments.

## 3. Connector kinds

| | API connector | Browser connector |
|---|---|---|
| Talks to | A service API over HTTPS (or a local MCP server, §3.1) | The service's web app, in a signed-in browser session |
| Code | TypeScript using `ctx.http` | TypeScript Playwright script using `ctx.browser` |
| Sign-in | `api_key`, `oauth2`, or `none` | `browser_session` ([04 §5](04-platform.md#5-browser-sandbox)) |
| Typical risk | Stable, documented; rate limits | Breaks when the site changes; terms-of-service risk; pacing required |
| Versioning extras | API version in settings | `selectorsVersion` (date of the last verified selector set) |
| Examples | `google-calendar`, `gmail`, `wordpress`, `github`, `hootsuite`, `salesforce`, `toggl-track` | `linkedin`, `whatsapp-web` |

Browser connectors read a rendered surface, not a contract the vendor offers. This design follows firstmate's rule for such adapters: they are named, quarantined, version-pinned, carry their own verification, and are expected to break on the vendor's next release ([07 §2](07-agent-friendly-design.md#2-sources-read)). In practice this means:

- the registry flags them `unofficial_surface`;
- each one ships a live probe that checks its key selectors;
- a failing probe marks the binding `degraded` and turns the dependent steps into user steps until it is fixed.

### 3.1 Local MCP transport (extension)

An API connector may declare `transport: 'local_mcp'`. The host then starts a declared local MCP server and calls only the allowlisted tools. This lets CC reuse existing deterministic local tools, such as a read-only local MCP server the user already runs. It is allowed only for first-party or developer-mode connectors, with the user's consent (OQ-05-04).

## 4. Package layout

Connectors live under `connectors/<id>/` in `cc-connectors` or in the user's connectors repository. AI adapters live beside them under `adapters/ai/<id>/`, with an `adapter.json` manifest ([04 §6.2](04-platform.md#62-provider-interface)) instead of `connector.json`; the rules of §12 differ by package kind.

```text
connectors/<id>/
  connector.json          # manifest (§5)
  src/index.ts            # exports ConnectorModule (§6)
  src/extractors/*.ts     # browser connectors: in-page readers (self-contained functions)
  fixtures/               # sanitised HTTP exchanges or HTML pages
  test/*.test.ts          # fixture tests run by `pnpm cc:test-connector <id>`
  CHANGELOG.md
  README.md               # what it does, what it never does, setup steps
```

The publishable package is `<id>-<version>.tgz`. It holds `connector.json`, the built `dist/`, `README.md` and `CHANGELOG.md`. Fixtures and tests stay in the repository.

## 5. Manifest

```ts
type RiskClass = 'read' | 'write_internal' | 'write_external_draft' | 'write_external'
               | 'send_publish' | 'destructive' | 'credential' | 'financial';   // 04 §7.1

interface ConnectorManifest {
  manifestVersion: 1;
  id: string;                          // [a-z0-9-]{2,40}, unique in the registry
  name: string;
  version: string;                     // semver
  kind: 'api' | 'browser';
  transport?: 'https' | 'local_mcp';   // api only; default https
  publisher: { id: string; name: string };
  description: string;
  categories: ToolCategory[];          // 01 §4
  engines: { foundation: string; connectorApi: '1' };      // semver range of the @cc/* foundation packages (§14)
  implements?: string[];               // capability contracts, e.g. ["calendar@1"] (02 §9.1); checked at install
  auth: AuthSpec;
  permissions: PermissionSpec;
  actions: ActionSpec[];
  syncs: SyncSpec[];
  settingsSchema: object;              // JSON Schema for per-binding settings
  records: string[];                   // record types emitted, e.g. "calendar.event@1"
  browser?: BrowserSpec;               // browser only
  localMcp?: { command: string[]; allowedTools: string[] };   // local_mcp only
  limits: { timeoutSeconds: number; maxMemoryMb: number; minSyncIntervalMinutes: number };
  flags: ('tos_risk' | 'unofficial_surface' | 'beta')[];
}

type AuthSpec =
  | { method: 'none' }
  | { method: 'api_key'; inject: { in: 'header' | 'query'; name: string; prefix?: string };
      obtainUrl?: string; instructions: string }
  | { method: 'oauth2'; flow: 'authorization_code_pkce'; authorizeUrl: string; tokenUrl: string;
      scopes: { scope: string; reason: string; optional: boolean }[];
      clientRegistration: 'byo' | 'publisher'; redirect: 'loopback' }
  | { method: 'browser_session' };

interface PermissionSpec {
  network: { hosts: string[] };         // exact hosts or "*.example.com"; https only
  browser?: { origins: string[]; downloads: boolean; clipboard: boolean };
  records: { write: string[] };         // record types it may emit
  ccData: { read: ('workstream_names' | 'persons_public')[] };  // CC data passed in; default none
  secrets: { custom: boolean };          // true = needs a raw secret (e.g. request signing); flagged in review
}

interface ActionSpec {
  name: string;                         // "upsert_event"
  title: string;
  risk: RiskClass;                      // the Policy Engine uses this, never a caller's claim
  inputSchema: object;
  outputSchema: object;
  idempotent: boolean;
  idempotencyKey?: string;              // JSON pointer into the input, e.g. "/ccInstanceId"
  confirmation: 'policy' | 'always';
  rateLimit?: { perMinute?: number; perHour?: number };
}

interface SyncSpec {
  name: string;                         // "changes"
  title: string;
  defaultSchedule: Schedule;
  emits: string[];                      // record types
  cursor: boolean;                      // keeps a cursor in ctx.state
}

type Schedule =
  | { kind: 'interval'; minutes: number }
  | { kind: 'cron'; expr: string; timeZone?: IanaTimeZone }
  | { kind: 'manual' };

interface BrowserSpec {
  service: string;                      // "linkedin"
  origins: string[];
  loginUrl: string;
  signedInProbe: string;                // exported function name
  challengeSignatures: string[];        // selectors or text that mean "a human is needed"
  requiresHeaded: boolean;
  pacing: { minGapMs: number; maxGapMs: number; maxPageLoadsPerHour: number };
  selectorsVersion: string;             // "2026-11-01"
}
```

Example: `google-calendar` (abbreviated):

```json
{
  "manifestVersion": 1,
  "id": "google-calendar",
  "name": "Google Calendar",
  "version": "1.0.0",
  "kind": "api",
  "publisher": { "id": "command-center", "name": "Command Center" },
  "description": "Implements calendar@1 for Google Calendar: writes Command Center meeting events and reads changes to them.",
  "categories": ["calendar"],
  "engines": { "foundation": ">=1.0.0 <2.0.0", "connectorApi": "1" },
  "implements": ["calendar@1"],
  "auth": {
    "method": "oauth2", "flow": "authorization_code_pkce", "redirect": "loopback", "clientRegistration": "byo",
    "authorizeUrl": "https://accounts.google.com/o/oauth2/v2/auth",
    "tokenUrl": "https://oauth2.googleapis.com/token",
    "scopes": [
      { "scope": "https://www.googleapis.com/auth/calendar.events", "reason": "Create and update Command Center events", "optional": false },
      { "scope": "https://www.googleapis.com/auth/calendar.readonly", "reason": "Flag conflicts with your other events", "optional": true }
    ]
  },
  "permissions": {
    "network": { "hosts": ["www.googleapis.com"] },
    "records": { "write": ["calendar.event@1"] },
    "ccData": { "read": [] },
    "secrets": { "custom": false }
  },
  "actions": [
    { "name": "list_events", "title": "List events", "risk": "read", "idempotent": true, "confirmation": "policy", "inputSchema": {}, "outputSchema": {} },
    { "name": "upsert_event", "title": "Create or update a Command Center event", "risk": "write_external", "idempotent": true, "idempotencyKey": "/ccInstanceId", "confirmation": "policy", "inputSchema": {}, "outputSchema": {} },
    { "name": "delete_event", "title": "Delete a Command Center event", "risk": "destructive", "idempotent": true, "idempotencyKey": "/ccInstanceId", "confirmation": "policy", "inputSchema": {}, "outputSchema": {} }
  ],
  "syncs": [
    { "name": "changes", "title": "Incremental changes to Command Center events", "defaultSchedule": { "kind": "interval", "minutes": 15 }, "emits": ["calendar.event@1"], "cursor": true }
  ],
  "settingsSchema": { "type": "object", "required": ["calendarId"], "properties": { "calendarId": { "type": "string" } }, "additionalProperties": false },
  "records": ["calendar.event@1"],
  "limits": { "timeoutSeconds": 60, "maxMemoryMb": 256, "minSyncIntervalMinutes": 5 },
  "flags": []
}
```

Example: `linkedin` browser connector (abbreviated):

```json
{
  "manifestVersion": 1, "id": "linkedin", "name": "LinkedIn (browser)", "version": "0.1.0", "kind": "browser",
  "categories": ["social", "job_board"],
  "auth": { "method": "browser_session" },
  "permissions": {
    "network": { "hosts": [] },
    "browser": { "origins": ["https://www.linkedin.com"], "downloads": false, "clipboard": false },
    "records": { "write": ["social.post@1", "job.posting@1"] },
    "ccData": { "read": [] }, "secrets": { "custom": false }
  },
  "actions": [
    { "name": "list_recent_posts", "title": "List my recent posts", "risk": "read", "idempotent": true, "confirmation": "policy", "inputSchema": {}, "outputSchema": {} },
    { "name": "search_jobs", "title": "Search jobs", "risk": "read", "idempotent": true, "confirmation": "policy", "inputSchema": {}, "outputSchema": {} },
    { "name": "get_job", "title": "Read one job posting", "risk": "read", "idempotent": true, "confirmation": "policy", "inputSchema": {}, "outputSchema": {} }
  ],
  "syncs": [],
  "browser": {
    "service": "linkedin", "origins": ["https://www.linkedin.com"],
    "loginUrl": "https://www.linkedin.com/login", "signedInProbe": "probeSignedIn",
    "challengeSignatures": ["iframe[src*='captcha']", "text=Let's do a quick security check"],
    "requiresHeaded": false,
    "pacing": { "minGapMs": 3000, "maxGapMs": 7000, "maxPageLoadsPerHour": 40 },
    "selectorsVersion": "2026-11-01"
  },
  "records": ["social.post@1", "job.posting@1"],
  "limits": { "timeoutSeconds": 300, "maxMemoryMb": 512, "minSyncIntervalMinutes": 60 },
  "flags": ["tos_risk", "unofficial_surface"]
}
```

The `linkedin` connector v0.1 is read-only: it uses the sandbox's pacing (04 §5.5 G6), the "needs you" hand-off (04 §5.4) and the extractor pattern of §6 rule 4. Posting stays with LinkedIn's own scheduler or a scheduler API connector (D-0008 in [03 §13.5](03-decisions-and-action-items.md#135-d-0008-which-social-scheduler-from-week-3)).

## 6. Runtime API

```ts
export interface ConnectorModule {
  actions: Record<string, ActionHandler>;
  syncs?: Record<string, SyncHandler>;
  probeSignedIn?: (page: GuardedPage) => Promise<boolean>;   // browser only; read-only DOM checks
  healthCheck: (ctx: ConnectorContext) => Promise<{ ok: boolean; detail: string }>;
}

export type ActionHandler = (ctx: ConnectorContext, input: unknown) => Promise<unknown>; // output validated by the host
export type SyncHandler = (ctx: ConnectorContext, cursor: string | null) => Promise<{ nextCursor: string | null }>;

export interface ConnectorContext {
  readonly run: { id: RunId; connectorId: string; version: string; bindingId: ConnectorBindingId;
                  action?: string; sync?: string; idempotencyKey?: string; deadline: UtcTimestamp };
  readonly settings: Readonly<Record<string, unknown>>;   // validated against settingsSchema
  readonly http: ScopedHttp;                              // api only
  readonly browser?: BrowserHandle;                       // browser only
  readonly state: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> }; // 64 KB per binding
  emit(record: ConnectorRecord): void;                    // validated against the record schema
  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, fields?: Record<string, string | number | boolean>): void; // redacted by the host
  needsUser(reason: 'signed_out' | 'challenge' | 'two_factor' | 'consent_screen' | 'unexpected_page' | 'auth_expired', detail: string): never;
  readonly signal: AbortSignal;
  readonly clock: { now(): UtcTimestamp };                // injectable, for deterministic tests
}

export interface ScopedHttp {
  request(req: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: string;
                 headers?: Record<string, string>; query?: Record<string, string>;
                 json?: unknown; body?: string; timeoutMs?: number }):
    Promise<{ status: number; headers: Record<string, string>; json(): Promise<unknown>; text(): Promise<string> }>;
}

export interface BrowserHandle {
  page(): Promise<GuardedPage>;           // a page in the bound session's context, guards G1-G8 applied (04 §5.5)
  waitForJson(urlPattern: string, timeoutMs?: number): Promise<unknown>; // parsed response body, no headers
}

/** Playwright `Page`, wrapped: credential-field input, storage export and off-origin navigation throw. */
export type GuardedPage = import('playwright').Page;

export interface ConnectorRecord {
  type: string;                           // "social.post@1"
  externalId: string;                     // stable ID in the service
  occurredAt: UtcTimestamp;
  data: unknown;                          // validated against packages/schemas/records/<type>.json
}
```

Rules:

1. `ctx.http` rejects any host not in `permissions.network.hosts`, and any non-HTTPS URL. It adds the binding's auth header or query value. Connector code cannot read the header value.
2. Handlers must be deterministic given the same input, settings, cursor, clock and service responses.
3. Handlers never call each other across bindings. One run serves one binding.
4. In-page extractor functions for browser connectors are self-contained functions passed to `page.evaluate` as function references, never as strings. They never throw: a miss returns empty results plus a warning.

## 7. Authentication methods

| Method | Set up by | Stored | Injected | Refresh and expiry |
|---|---|---|---|---|
| `api_key` | The user pastes the key in the binding dialog, or a discovery run captures it ([06](06-connector-discovery.md)) | `safeStorage` ciphertext (SecretRef) | The host adds `inject.name: prefix + key` to each request | None. A 401 sets health `auth_expired` |
| `oauth2` | Authorization code with PKCE in the system browser, redirected to `http://127.0.0.1:<random port>/callback` (RFC 8252 loopback) | Access and refresh tokens as SecretRefs | `Authorization: Bearer <access>` | The host refreshes before expiry. A failed refresh sets health `auth_expired` |
| `browser_session` | The user signs in by hand in the session window ([04 §5.4](04-platform.md#54-flows)) | The browser profile on disk | Guarded context | Detected by probe and challenge signatures, which lead to `needs_user` |
| `none` | | | | |

OAuth client registration:

1. v1 supports **bring-your-own client** (`clientRegistration: 'byo'`). The user creates a Desktop OAuth client in their own Google Cloud project, and CC guides the steps. This is the same setup the user already did for the Gmail MCP server in `regime/plan.md` §7.1.
2. Google refresh tokens expire after 7 days while the consent screen is in "Testing" mode. The guide tells the user to publish the consent screen, as `regime/plan.md` §7.2 notes.
3. A publisher-registered client (`'publisher'`) would need Google's app verification for restricted scopes such as Gmail. That is OQ-05-01.

## 8. Permissions and consent

1. At install and at binding creation, CC shows: network hosts or browser origins, OAuth scopes with reasons, record types, every action with its risk class, flags (`tos_risk`, `unofficial_surface`), and whether `secrets.custom` is set.
2. The user may deny optional OAuth scopes. Actions that need a denied scope are disabled for that binding (Policy Engine rule 4 in [04 §7.2](04-platform.md#72-evaluation-order)).
3. A binding's `confirmationOverrides` may set any action to `always`. Nothing can loosen the manifest or the Policy Engine.
4. Updates that change `permissionsDigest` require new consent before activation (§15.4).

## 9. Bindings

```ts
type ConnectorInstallId = Id<'cin'>;

interface ConnectorInstall extends Audit {
  id: ConnectorInstallId;
  connectorId: string;
  version: string;
  previousVersions: string[];           // kept for rollback (max 2)
  source: 'registry' | 'developer';
  signatureVerified: boolean;
  autoUpdate: 'off' | 'patch_minor_same_permissions';
}

interface ConnectorBinding extends Audit {
  id: ConnectorBindingId;
  label: string;                        // "gmail-alderwick"; unique; used in CLI and step allowlists
  connectorId: string;
  installId: ConnectorInstallId;
  pinnedVersion?: string;
  credentialRefs: SecretRef[];          // api_key or oauth tokens
  browserSessionId?: BrowserSessionId;  // browser connectors
  accountOwnerId: PersonId;             // whose account this is
  settings: Record<string, unknown>;
  grantedScopes: string[];
  schedules: Record<string, Schedule>;  // per sync; never below limits.minSyncIntervalMinutes
  workstreamIds: WorkstreamId[];
  confirmationOverrides: Record<string, 'always'>;
  health: { state: 'ok' | 'degraded' | 'needs_user' | 'auth_expired' | 'failing' | 'disabled';
            checkedAt: UtcTimestamp; detail: string };
}
```

## 10. Execution (Connector Host)

### 10.1 Invoke flow

```mermaid
sequenceDiagram
  participant K as Caller (step runner, CLI, MCP, AI tool call)
  participant P as Core: Policy Engine
  participant H as Connector Host
  participant X as Connector run (utilityProcess)
  participant S as Service
  K->>P: invoke(binding, action, input)
  P->>P: validate input against inputSchema; evaluate (04 §7.2)
  alt deny
    P-->>K: error (E_FORBIDDEN, E_PERMISSION, E_HUMAN_REQUIRED, ...)
  else confirm
    P-->>K: pending_confirmation (cfm_...)
    Note over P: user approves in the app; the payload hash is checked
  end
  P->>H: run(binding, action, input, idempotencyKey)
  H->>X: start with ConnectorContext (auth injected by the host)
  X->>S: HTTPS request or guarded page actions
  S-->>X: response
  X-->>H: output + records
  H->>H: validate output and records; store records; write the Run
  H-->>K: output (as connector_record evidence when the call came from a step)
```

### 10.2 Rules

1. One run is one process (spike S2 decides the restriction flags). Every run has a timeout of `limits.timeoutSeconds` and a memory cap.
2. Concurrency: one run at a time per binding by default, and at most 4 runs at once overall. Browser sessions are always serial (G6).
3. Idempotency: writes carry `ctx.run.idempotencyKey` (from `idempotencyKey`). The host keeps a 30-day table of completed (binding, action, key) entries and returns the stored output for a repeat, with status `no-op`.
4. Retries apply only to `idempotent` actions: 3 attempts with backoff of 1, 5 and 25 minutes, and only for network errors, 429 and 5xx.
5. Syncs run on their schedule in the workspace time zone with ±10 percent jitter. After a failure, backoff doubles up to 6 hours. After sleep or offline time, a sync runs once on wake, not once per missed slot.
6. Every run writes a `Run` record (03 §5.8) with a redacted log.

### 10.3 Health

1. `healthCheck` runs at binding creation, daily, and after 3 consecutive failures. Browser connectors also run `probeSignedIn` and a selector probe.
2. Health `failing`, `auth_expired` or `needs_user` raises an attention entry. It also creates a system action item "Fix connector <label>", owned by the user, whose evidence check is that health returns to `ok`.

## 11. Records and ingest

1. Record schemas live in `packages/schemas/records/<type>@<major>.json`. The v1 types are: `calendar.event@1`, `mail.message@1` (headers, snippet, labels; the body only when an action asks for it), `social.post@1` (platform, author handle, posted time, URL, text hash, excerpt), `cms.post@1`, `job.posting@1` (title, company, location, URL, source, posted time, description marked untrusted), `chat.message@1` (chat ID hash, sender label, time, text marked untrusted, unread flag), `code.pull_request@1`, `time.entry@1`, `measure.sample@1`.
2. Records are stored in `connector_records` (type, binding, externalId, data, firstSeenAt, lastSeenAt), deduplicated by (binding, type, externalId).
3. Ingest rules are deterministic and declared in packs. Examples: `measure.sample@1` becomes a `MeasureValue`; with `pack.job-search`, `job.posting@1` creates a pipeline entry at stage `sourced`. Ingest rules may create only **draft** action items. Committed items need the user.
4. Text fields from services are untrusted. They reach AI only through the wrapping in [04 §6.5](04-platform.md#65-data-policy-and-untrusted-content).

## 12. No AI in connectors: enforcement

1. The connector API has no model access, and the manifest has no AI fields.
2. The repository holds AI adapters too, so the checks run **per package kind**:
   - `connectors/*` deny every AI SDK and AI host, as below;
   - only `adapters/ai/*` may import AI SDKs, reach AI provider hosts or start an AI CLI, and adapters may not import `@cc/connector-sdk`;
   - `connectors/*` may not import anything under `adapters/`.
3. Static checks at test, registry CI and install time reject, for `connectors/*`:
   - imports of AI SDKs (`@anthropic-ai/*`, `openai`, `@google/genai`, `@google/generative-ai`, `@mistralai/*`, `cohere-ai`, `ollama`, `langchain*`, `ai`, and any package on the maintained denylist);
   - AI provider hosts in `permissions.network.hosts` (`api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com` and the denylist);
   - Node modules `child_process`, `worker_threads`, `net`, `tls`, `dgram`, `http`, `https`, and filesystem writes;
   - `eval`, `new Function`, string arguments to `page.evaluate`, and dynamic `import()` of non-package paths.
4. Determinism tests (§13 item 4) fail any handler whose output varies for the same fixture.
5. Registry review checklist item: "makes no judgement calls (ranking, classification, wording); those belong in agent profiles."

## 13. Testing contract

Every connector must pass `pnpm cc:test-connector <id>` offline. It runs:

1. Manifest validation against the generated schema, including `engines` and `records`.
2. The static policy checks of §12.
3. Fixture tests for every action and sync. API connectors replay recorded HTTP exchanges through a fake `ctx.http`. Browser connectors load saved HTML through Playwright (`page.setContent` or a local static server) inside the same guarded page.
4. Determinism: each fixture runs twice with an injected clock, and outputs and records must be byte-identical.
5. Output and record validation against their schemas.
6. Guard tests: no guard violation occurred. For browser connectors, a login-page fixture must lead to `needs_user`, not to interaction.
7. Fixture hygiene: a scanner finds no real email addresses, phone numbers, tokens, cookies or names. Synthetic values come from an allowlist.
8. Live checks only with `--live --binding <label>`, run by a human against the running app. They are refused when `CI=true` ([08](08-repository-and-automation.md)).

## 14. Versioning and compatibility

1. Connectors follow semver. A major version is required for any breaking change to action inputs or outputs, record schema majors, or settings.
2. `engines.connectorApi` is the runtime API major (`'1'`). The app refuses to load a connector whose major it does not support.
3. Browser connectors update `selectorsVersion` whenever selectors change, and record the date they were last verified live.
4. Deprecation: an action may be marked `deprecated` for at least one minor version before removal.
5. `engines.foundation` is the supported range of the `@cc/*` foundation packages, in connector and adapter manifests alike. The lock loader refuses an entry whose range excludes the installed foundation, and keeps the last-known-good entry.

## 15. Plugin repository

### 15.1 Layout and publishing

1. First-party connectors and AI adapters live in `cc-connectors` under `connectors/` and `adapters/ai/` ([08](08-repository-and-automation.md)). `cc-connectors` also holds the signed index (formerly a separate `command-center-registry` repository) and the connector templates. A user's own connectors and adapters live in the user's connectors repository, created from `cc-connectors` as a template; third-party publishers do the same.
2. In `cc-connectors`, CI builds, tests and packs each package whose version changed. A protected release job uploads the tarball to a GitHub Release, and regenerates and signs the index. In a user's connectors repository, CI builds the package from a tag and publishes it with its sha256, and no index is signed (§15.6).

```ts
interface RegistryIndex {
  schemaVersion: 1;
  generatedAt: UtcTimestamp;
  publisher: { id: string; keyId: string };
  connectors: RegistryEntry[];
}

interface RegistryEntry {
  id: string; name: string; kind: 'api' | 'browser';
  categories: ToolCategory[];
  aliases: string[];                    // "gcal", "google calendar"
  description: string;
  flags: ('tos_risk' | 'unofficial_surface' | 'beta' | 'deprecated')[];
  versions: {
    version: string; publishedAt: UtcTimestamp; minAppVersion: string; connectorApi: '1';
    url: string;                        // GitHub Release asset
    sha256: string;
    signature: string;                  // base64 Ed25519 over (id, version, sha256)
    permissionsDigest: string;          // sha256 of the canonical permissions + actions risk list
    changelog: string;
    yanked?: boolean;
  }[];
}
```

The index is served at a stable URL on GitHub Pages (`…/registry/v1/index.json` with `index.json.sig`). Publisher public keys are bundled in the app (OQ-05-02 covers rotation).

### 15.2 Find

`cc-axi connectors search <text>` and the onboarding tool step match on `id`, `name`, `aliases` and `categories`. Results show kind, flags and the latest compatible version.

### 15.3 Install (human-only)

1. Show the manifest summary, permissions and flags. The user consents.
2. Download, then verify the index signature, the package `sha256` and the package signature.
3. Unpack into `<userData>/connectors/<id>/<version>/`, validate the manifest, and re-run the static checks.
4. Create the `ConnectorInstall`, then the binding setup (auth), then a health check.

### 15.4 Update and rollback

1. The index is checked daily. A patch or minor update with an identical `permissionsDigest` installs automatically if `autoUpdate` allows it (default on for first-party, off otherwise). Anything else asks the user and shows the permission and risk diff.
2. Runs never switch versions mid-run. New runs use the new version after activation, so a connector change needs no full restart.
3. The previous two versions are kept. Rollback is one action (human-only, [04 §4.3](04-platform.md#43-who-counts-as-the-user)). A `yanked` version rolls back automatically to the newest non-yanked one, and the user is notified.
4. **Staged activation.** A new version or lock entry goes through: verify (signature or pin, sha256), static checks (§12), the permission and risk consent (human-only, §15.3), then a health probe. A failure at any stage keeps the last-known-good entry ([04 §9](04-platform.md#9-storage-secrets-and-data-location) `lock/last-known-good.json`).
5. **Crash loop.** A connector whose runs crash 3 times within 10 minutes is disabled; its steps turn back into `user` steps, and an attention item offers the rollback.
6. **Ticket comment.** When the version came from a development request ([06 §11.3](06-connector-discovery.md#113-build-include-and-activate)), a rollback posts a comment on its issue with the reason.

### 15.5 Connector developer mode

**Connector developer mode** is Settings → Developer → Load unpacked connector (human-only): it loads a local path with an "unsigned" badge. It is not the engine's **dirty-tree mode**, the labelled start from a dirty engine checkout ([04 §10](04-platform.md#10-packaging-updates-and-os-support) rule 4); the two had the same name before (review finding 10, named apart by owner decision, 10 Nov 2026). `cc-axi connectors test <path>` runs §13 without installing.

### 15.6 `connectors.lock` and the user's own connectors

The user's engine repository holds `connectors.lock`: the exact connector and adapter packages this CC may load. CC reads it and never writes it; changes arrive as **include PRs** that the user merges ([06 §11.3](06-connector-discovery.md#113-build-include-and-activate), [08 §9](08-repository-and-automation.md#9-ci-and-release)).

```ts
interface ConnectorsLock {
  lockVersion: 1;
  entries: {
    id: string;                          // "hostinger", "codex_cli"
    kind: 'connector' | 'adapter';
    version: string;
    source:
      | { kind: 'index'; publisher: string }                     // signed upstream index (§15.1)
      | { kind: 'repo'; repo: string; tag: string; url: string }; // the user's connectors repository release
    sha256: string;                      // the trust anchor for 'repo' sources
    permissionsDigest: string;
    requestId?: string;                  // the development request it came from (06 §10.4)
  }[];
}
```

1. **Trust.** An `index` entry is verified as in §15.3. A `repo` entry is trusted through its sha256 pin: the user reviewed the connector PR and merged the include PR on a protected branch, so the pin is under the user's control. The upstream index key cannot vouch for private code, and is not used for it. An optional second check, such as a GitHub artifact attestation, may be added once its availability on the user's plan is verified (spike S8, OQ-05-07).
2. **Install becomes "new lock entry + human-only activation".** When the loader finds an entry it has not activated, it downloads the package, checks the sha256 (before unpacking), re-runs the static checks (§12) and validates the manifest, then shows the permission and risk consent in the app. The steps of §15.3 run at that point, not at merge time.
3. **Badge.** Packages from a `repo` source carry a "your own" badge in Settings → Connectors.
4. **Adapters** from a `repo` source get the same checks, plus the consent shows the adapter's `dataSent` statement ([04 §6.1](04-platform.md#61-boundary) rule 4).
5. **Last known good.** After every fully successful activation, CC saves the lock as last-known-good. A failed activation, a crash loop (§15.4 rule 5) or a human rollback returns that entry to its last-known-good version.

## 16. Onboarding tool selection (step S7) and the reference scenario

1. CC asks per category: "Which tools do you use for calendar, email, chat, social, scheduling, blog/CMS, CRM, hosting, code, docs, time tracking, analytics, job boards, accounting?" Then "Where does your team track tasks? (Jira / Linear / none → Google Sheet)" (item 4). Then for which workstreams.
2. Each tool is matched against `connectors.lock` and the catalogue (§15.2). The user picks a connector, *manual*, *find with AI* ([06](06-connector-discovery.md)) or *later*. A gap is a missing connector, or, at S8, a missing AI adapter; choosing *find with AI* is consent to public research only, and queues a draft development request ([06 §3](06-connector-discovery.md#3-triggers-and-preconditions)).
3. Bindings are created as drafts. Sign-ins happen right after commit, one at a time, with each step skippable.
4. **Team task tracker (owner decision C2, 10 Nov 2026).** The answer to "Where does your team track tasks?" is a `ToolAnswer` with category `task_tracker` ([01 §4](01-onboarding-and-frameworks.md#4-types)), for the workstreams the user names, like any other tool. The tracker is an **on-demand connector** ([09 §13.3](09-build-plan.md#133-track-items), P2-13): `google-sheets` first, for teams with no Jira or Linear (the answer "none" selects it), then `jira` or `linear` when a team uses one. Until a tracker connector ships, the answer is recorded as *manual* or *later*, as for every tool before P2 ([09 §6](09-build-plan.md#6-p1-mvp-register-and-rhythm)). The design does not yet settle: the tracker connectors' actions and records (read only, or also writing tasks); whether they share a capability contract, as calendars share `calendar@1` (§1 item 7; OQ-05-08); for the Google Sheet, whether CC creates it or the user names one, and its columns (OQ-05-09); and how tracker tasks relate to CC's action items ([03 §5.7](03-decisions-and-action-items.md#57-actionitem), OQ-03-05). The reference scenario's design facts have no tracker answer; the sample profile answers "none → Google Sheet" as [sample] filler ([01 §3.2](01-onboarding-and-frameworks.md#32-answering-from-documents-and-the-sample-profile)).

| Binding label (ID) | Connector (kind) | Workstreams | Auth | Account owner | Used for | Phase |
|---|---|---|---|---|---|---|
| `gcal-main` (`bnd_gcal_main`) | `google-calendar` (api) | all | oauth2, BYO client | the user | Rhythm events (02 §9) | P2 |
| `gmail-alderwick` (`bnd_gmail_ald`) | `gmail` (api) | Alderwick | oauth2 (read and compose) | the user | Drafts, sent-mail checks, countersigned documents (A-0152) | P2 |
| `gmail-quillmarsh` (`bnd_gmail_qlm`) | `gmail` (api) | Quillmarsh | oauth2 | the user | Same | P2 |
| `github-main` (`bnd_github_main`) | `github` (api) | Quillmarsh, Alderwick | oauth2 or fine-grained token | the user | Shipped-work evidence, PR checks | P2 |
| `linkedin-self` (`bnd_linkedin_self`) | `linkedin` (browser) | Alderwick, Quillmarsh | browser session | the user | Post verification (read-only) | P4 |
| `whatsapp-alderwick` (`bnd_whatsapp_ald`) | `whatsapp-web` (browser) | Alderwick | browser session | the user (business number) | Unread chats to draft items; sending each message needs a confirmation | P4 |
| `wordpress-alderwick` (`bnd_wp_ald`) | `wordpress` (api) | Alderwick | api_key (WordPress application password) | the user | Blog drafts, publish checks | P5 |
| `hootsuite-main` (`bnd_hootsuite`) | `hootsuite` (api) | Alderwick, Quillmarsh | oauth2 | the user | Scheduled posts, if D-0008 picks it | P5 |
| `toggl-main` (`bnd_toggl`) | `toggl-track` (api) | Alderwick | api_key | the user | Client hours (K-0004) | P5 |
| none for Hostinger | no connector in the lock or catalogue; *find with AI* → report → ticket in the user's engine repository → firstmate builds it in the user's connectors repository → include PR → active | Quillmarsh | | the user | Site hosting ([06 §9](06-connector-discovery.md#9-reference-scenario-examples)) | P6, P7 |

## 17. Reuse of existing assets

Job search is not part of the reference scenario (owner decision, 12 Nov 2026). It will be a separate incubation app outside this repository, which may later connect to CC through an adapter. Nothing from it is ported into connectors here: the `linkedin` browser connector is built new on the browser sandbox (04 §5), and the untrusted-text sanitiser is CC's own ([04 §6.5](04-platform.md#65-data-policy-and-untrusted-content)). The product's job-search features (the `job_search` workstream kind, `pack.job-search` and `pack.job-search-fractional`, the `tailor` agent profile, the `job_board` tool category) stay defined in 01, 03 and 04; whether they move out of CC is a separate, later decision.

## 18. Contracts

1. **C-05-01** A connector never receives a raw secret unless its manifest sets `secrets.custom` and the user approved that at install.
2. **C-05-02** The risk class of every action comes from the installed manifest, and the Policy Engine evaluates every invoke.
3. **C-05-03** A package is loaded only after its signature and checksum verify against the signed index, or, for a package from the user's own repository, after its sha256 matches the pin in the user-merged `connectors.lock`. Connector developer mode (§15.5) is the only exception, and is clearly labelled.
4. **C-05-04** A permission or risk change in an update never activates without new consent.
5. **C-05-05** Connector outputs and records are validated against schemas before CC stores or uses them.
6. **C-05-06** Same fixture inputs give identical outputs. Connectors make no AI calls and no judgement calls.
7. **C-05-07** A binding never runs a sync more often than `limits.minSyncIntervalMinutes`, and browser bindings never exceed their pacing.
8. **C-05-08** A new lock entry activates only through the staged steps of §15.4 rule 4, including the human-only consent. A failure at any stage leaves the last-known-good entry active.
9. **C-05-09** Only `adapters/ai/*` packages may import AI SDKs, reach AI hosts or start an AI CLI. Connectors never do, and adapters never import `@cc/connector-sdk`.
10. **C-05-10** A connector that declares `implements: ["<contract>@<major>"]` exposes every action and sync of that contract with the contract's names, risk classes and record types. The host checks this at install and refuses the package otherwise.

## 19. Acceptance criteria

1. **AC-05-01** A connector that imports `openai` fails `pnpm cc:test-connector` with a policy error naming the import, and is refused by registry CI.
2. **AC-05-02** Tampering one byte of a downloaded tarball makes the install fail with `E_SIGNATURE` before anything is unpacked.
3. **AC-05-03** An update adding the `send_draft` action (risk `send_publish`) to `gmail` shows a permission diff, and is not activated until the user consents.
4. **AC-05-04** `upsert_event` called twice with the same `ccInstanceId` creates one event, and the second call returns `no-op`.
5. **AC-05-05** For the `linkedin` connector, a login-page fixture yields `needs_user` with reason `signed_out`, with no interaction recorded.
6. **AC-05-06** Revoking the Google token makes the binding `auth_expired` at the next run, and creates the "Fix connector gcal-main" item.
7. **AC-05-07** The scenario's P2 bindings (`gcal-main`, `gmail-alderwick`, `gmail-quillmarsh`, `github-main`) pass their health checks against fixture services in CI, and against the real services in a manual live run.
8. **AC-05-08** A `connectors.lock` entry whose package sha256 differs from the pin is refused before anything is unpacked, and the last-known-good version stays active.
9. **AC-05-09** A fixture connector that crashes 3 times within 10 minutes is disabled, its steps become `user` steps, an attention item offers the rollback, and the lock entry returns to last-known-good.
10. **AC-05-10** In a fixture copy of `cc-connectors`, a package under `connectors/` that imports `openai` fails `pnpm cc:test-connector`; the same import under `adapters/ai/` passes; an adapter that imports `@cc/connector-sdk` fails.
11. **AC-05-11** A connector that declares `implements: ["calendar@1"]` but lacks `delete_event`, or gives `upsert_event` a risk other than `write_external`, is refused at install with an error naming the missing or mismatched member.

## 20. Open questions

1. **OQ-05-01** Should a publisher-registered Google OAuth client be offered, so users skip the Cloud console? It needs Google's verification for restricted scopes (Gmail). *Default: BYO only in v1.*
2. **OQ-05-02** Registry signing: plain Ed25519 keys bundled in the app, or Sigstore keyless signing tied to the GitHub Actions identity? *Default: Ed25519 in v1, with a signed key-rotation list.*
3. **OQ-05-03** Who owns a job-alert mailbox read for someone else's search? *Closed (owner decision, 12 Nov 2026): job search left the reference scenario; it will be a separate incubation app outside this repository, which may later connect to CC through an adapter.*
4. **OQ-05-04** Should `local_mcp` transport be allowed for third-party connectors? It runs a local process. *Default: first-party and connector developer mode (§15.5) only.*
5. **OQ-05-05** WhatsApp: automating WhatsApp Web may breach WhatsApp's terms. Should Alderwick use the WhatsApp Business Platform (Cloud API) as an API connector instead? *Default: offer both; recommend the Business Platform for sending; keep the browser connector read-mostly.*
6. **OQ-05-06** Buffer's public API availability for new apps was not checked for this design. Verify before D-0008 lists Buffer as having a connector.
7. **OQ-05-07** Should packages from the user's own repository also carry a signature, such as a GitHub artifact attestation? Private repositories use GitHub's Sigstore instance, but GitHub's pages disagree on which plans offer it for private repositories (checked 2026-11-06). *Default: the user-merged sha256 pin is the anchor; an attestation is an optional second check once spike S8 confirms availability.*
8. **OQ-05-08** Do the team task tracker connectors (`google-sheets`, `jira`, `linear`; §16 item 4, owner decision C2) implement one capability contract, such as a `tasks@1` like `calendar@1`, so that core calls the contract and not each connector? *Default: decided with the first tracker connector (P2-13); until then, no contract.*
9. **OQ-05-09** For the Google Sheets tracker: does CC create the sheet (with the `drive.file` scope, as for backups) or does the user name an existing sheet, and which columns does it read and write? *Default: none yet; settled in P2-13's task contract.*
