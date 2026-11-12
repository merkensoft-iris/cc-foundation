# 04 · Platform

- **Purpose:** Defines the desktop platform: the Electron process model, the local API and agent identity, the built-in browser sandbox, the AI layer (the foundation's orchestrator behind one `AiProvider` interface, with provider adapters from `cc-connectors`: Claude CLI, Anthropic API, OpenAI, and Codex CLI proposed), the Policy Engine and confirmations, the MCP server transport, storage, secrets and backups, building and updating the app from the user's engine repository, and the security model.
- **Depends on:** [README.md](README.md) (conventions, risk classes). [03](03-decisions-and-action-items.md) (`Actor`, `Run`, `ActionItem`, the persistence layout).
- **Related files:** [05](05-connectors.md) (the Connector Host runs inside this platform; browser connectors use §5). [06](06-connector-discovery.md) (discovery uses §5 and §6). [07](07-agent-friendly-design.md) (CLI and MCP tool surface on top of §4 and §8). [08](08-repository-and-automation.md) (the three repositories and their package layout). [09](09-build-plan.md) (spikes S1 to S9 in P0).

## 1. Summary

1. Command Center (CC) is an **Electron** desktop app. It keeps running in the tray when its windows are closed, so rhythms, syncs and checks keep working.
2. All domain logic runs in one **core service** process, which owns the SQLite store. The UI, the `cc-axi` CLI, the MCP relay and the AI layer are all clients of the same typed **local API**. There is one handler per operation, so every caller gets the same validation and the same Policy Engine.
3. The **browser sandbox** keeps one persistent, isolated browser profile per signed-in service account, managed by a Playwright-based **browser host**. The user signs in by hand. CC never types, reads or stores passwords or one-time codes, and connector code cannot export cookies.
4. **AI is used only in the AI layer.** The foundation's orchestrator owns the agent profiles, the data policy and the budgets, and imports no AI SDK. **Provider adapters**, packages from `cc-connectors` (or the user's own connectors repository), hold all AI SDK code and CLI handling, behind one `AiProvider` interface. Providers are the user's choice at onboarding S8: Claude CLI (the user's own Claude Code login), the Anthropic API, OpenAI, Codex CLI (proposed, after spike S3b) or none. AI output is always a draft, a proposal or a tool call checked by the Policy Engine.
5. Every operation with outside effects passes the **Policy Engine**. It allows, asks for a **payload-bound confirmation**, or denies. Only the human in the app UI can approve. CLI and MCP callers are always agent principals, never "the user".
6. The **MCP server** is a stdio relay (`cc-axi mcp`) to the local API. No TCP port is opened by default.
7. **The local store is the source of truth** for answers and records. It is backed up on a schedule, encrypted, to a local set and to an off-machine destination the user chooses, with a periodic restore test and a visible "last good backup" status (§9.1).
8. **The app a user runs is a build of their own engine repository**, which pins the foundation's packages. Foundation updates arrive as dependency PRs the user merges and then pulls; CC detects the stale build, offers Rebuild now, rebuilds in the app without writing the checkout, and restarts when idle (§10; owner decisions C1 and Rebuild now, 10 Nov 2026).

## 2. Scope and non-goals

- In scope: processes, IPC, local API transport, identity, browser sandbox, AI providers and profiles, the policy model, storage paths, secrets, updates, security.
- Non-goals: UI visual design; cloud sync and multi-device (OQ-04-05); mobile.

## 3. Process architecture

```mermaid
flowchart LR
  subgraph App["Electron app"]
    R["Renderer UI<br/>sandboxed, no Node<br/>engine theme and UI slots"] -- "typed IPC via contextBridge" --> M["Main process<br/>windows, tray, deep links,<br/>notifications, restart when idle"]
    M -- "MessagePort" --> C["Core service (utilityProcess)<br/>store, rhythm engine, review,<br/>Policy Engine, step runner,<br/>orchestrator + API adapters,<br/>lock loader, scheduler, local API"]
    C -- "IPC" --> CR["Connector runs<br/>one utilityProcess per run"]
    C -- "IPC" --> BH["Browser host (utilityProcess)<br/>Playwright + one profile per session"]
    C -- "child process" --> CL["claude / codex CLI<br/>(CLI adapters; codex proposed)"]
  end
  C -- "HTTPS" --> API["Anthropic API / OpenAI API"]
  C -- "encrypted archives" --> BK["Backup destination<br/>folder, Google Drive or S3"]
  CLI["cc-axi CLI"] -- "local socket, JSON-RPC" --> C
  RELAY["cc-axi mcp (stdio relay)"] -- "local socket, JSON-RPC" --> C
  MC["MCP clients<br/>(Claude Code, others)"] -- "stdio" --> RELAY
  AG["Agents in shells<br/>(firstmate, Grok, Codex, OpenCode)"] --> CLI
  CL -- "MCP via relay" --> RELAY
```

| Process | Responsibilities | Privileges | On crash |
|---|---|---|---|
| Main | Single-instance lock; windows; tray; `commandcenter://` deep links; OS notifications; restarts core and the renderer when idle after a rebuild or a lock change (§10); starts and supervises core and the browser host | Full Electron main | App exits; OS restarts it only if "open at login" is on |
| Renderer | React UI; calls `window.cc.invoke(method, params)` exposed by a preload through `contextBridge`. Shows the engine's theme tokens and UI widgets in declared slots, loaded through `@cc/ui-sdk` | `contextIsolation`, `sandbox`, no `nodeIntegration`, strict CSP, no remote content. Engine widgets get the same: no Node, no network (rule D3, [08 §4.2](08-repository-and-automation.md#42-dependency-rules-dependency-cruiser-and-eslint-enforced-in-ci)) | Window reloads; no data loss (all state is in core) |
| Core service | Store; domain logic; schedulers (rhythm, backups §9.1, the ticket run [06 §11.2](06-connector-discovery.md#112-ticket-run)); Policy Engine; Connector Host supervisor; the lock loader (`connectors.lock` → staged → active, [05 §15.6](05-connectors.md#156-connectorslock-and-the-users-own-connectors)); AI layer, including API adapters loaded through `AiProvider` (an adapter from the user's own repository runs in its own `utilityProcess`, OQ-04-09); local API server | Node in an Electron `utilityProcess`; the only process that opens the database and decrypts secrets (secrets are passed to it from main through `safeStorage`) | Main restarts it with backoff; in-flight runs are marked `failed` with `E_CRASH` and retried only if idempotent |
| Connector run | Executes one connector action or sync ([05](05-connectors.md)) | Separate `utilityProcess`; capability API only; Node permission flags where supported (spike S2) | Run `failed`; never retried unless the action is idempotent |
| Browser host | Playwright; one persistent context per open browser session; runtime guards (§5.5) | Separate `utilityProcess`; profile directories readable only by the user (0700) | Sessions reopen on demand; profiles persist on disk |
| `claude` or `codex` CLI | Agent loop for a CLI adapter, `claude_cli` or `codex_cli` (proposed) (§6.3) | Runs as the user, in an empty per-run directory, with built-in tools disabled and only CC's MCP tools allowed | Run `failed` |

Rules:

1. The renderer never reaches the database, the network or secrets directly. Every call goes through the local API handlers in core, over IPC.
2. Core can also run headless under plain Node for development and tests (`cc-axi serve --headless --profile-dir <dir>`), without Electron, the browser host or `safeStorage`. Secrets then come from a test keyring. This mode is refused when `NODE_ENV=production` ([08](08-repository-and-automation.md)).
3. Code from the user's engine (theme, UI widgets, frameworks, packs) runs only in the renderer, through declared extension points. Connector and adapter packages run only after the lock loader has verified them ([05 §15.6](05-connectors.md#156-connectorslock-and-the-users-own-connectors)).

## 4. Local API and identity

### 4.1 Endpoint and protocol

1. Endpoint: a UNIX socket at `<userData>/run/cc.sock` (mode 0600, directory 0700) on macOS and Linux, and a named pipe `\\.\pipe\command-center-<username>-<random>` on Windows, whose random part makes the name unguessable. The core always writes the endpoint record `<userData>/run/endpoint` (mode 0600, written to a temporary file and renamed): one JSON line `{"v":1,"transport":"unix"|"pipe","path":…,"fallbackDir"?:…,"pid":…,"startedAt":…}`. Clients read the record first, and compute the default path only when there is no record and the default needs no fallback. A socket path may be at most `sizeof(sun_path)` − 1 bytes (107 on Linux, 103 on macOS); server and client both check this before any bind or connect, because Node 22 truncates silently. When the preferred path is longer, `mkdtemp('/tmp/command-center-<uid>-')` makes a private 0700 directory and the socket goes at `<dir>/cc.sock`, found only through the record. Both sides verify before trusting: every directory is owned by the user, mode 0700 and not a symlink, the socket is a socket and the record is mode 0600; the client checks them before it sends anything derived from a token. The server probes before it unlinks: a refused connection means a stale socket, which is removed; a live one means `E_ALREADY_RUNNING`; anything that is not a socket means `E_ENDPOINT_UNSAFE` and is never deleted. A watchdog runs every 60 seconds and rebinds a socket or recreates a fallback directory that a `/tmp` cleaner deleted. On stop, the core removes its record and fallback directory ([ADR 0002](../adr/0002-local-api-and-cli.md), closing OQ-08-05). No TCP port is opened, ever.
2. Protocol: JSON-RPC 2.0, one JSON object per line. Methods are `<namespace>.<verb>`: `home.get`, `items.list`, `items.get`, `items.create`, `items.update`, `items.claim`, `items.drop`, `items.history`, `items.handoff`, `items.link`, `evidence.add`, `search.query`, `decisions.*`, `issues.*`, `risks.*` (03 §5.6), `meetings.*`, `measures.*`, `goals.*`, `workstreams.*`, `principals.*` (Settings → Agent access, [07 §5](07-agent-friendly-design.md#5-agent-principals-and-scopes)), `connectors.*`, `sessions.*`, `confirmations.*`, `onboarding.*`, `requests.*` (development requests, [06 §10.4](06-connector-discovery.md#104-development-requests)), `backups.*` (status and history; running and restoring stay in the UI), `export.run`.
3. Parameters and results are validated with the zod schemas in `packages/schemas`. The same schemas generate the JSON Schemas used by MCP tool definitions and AI tool definitions (one source, [08](08-repository-and-automation.md)).
4. Errors use JSON-RPC error objects whose `data` holds `{ code, message, help[] }`. `code` is one of the CC error codes in [07 §4.4](07-agent-friendly-design.md#44-errors-and-exit-codes).

### 4.2 Principals and tokens

1. Every local API connection begins with a mutual-proof handshake ([ADR 0002](../adr/0002-local-api-and-cli.md) decision 6). The client sends `auth.hello { principal, nonce }`; the server answers with its own nonce and an HMAC-SHA-256 over both nonces keyed with the principal's token, proving it knows the token. Only after checking that proof does the client send `auth.prove { proof }`, its own HMAC over both nonces under a different role label. No token, and nothing derived from one, goes to an endpoint that has not proved it knows the token. Any other call before the handshake completes fails with `E_FORBIDDEN`, and a failed proof closes the connection. A principal is an `AgentPrincipal` ([07 §5](07-agent-friendly-design.md#5-agent-principals-and-scopes)) with scopes and an optional workstream filter.
2. Tokens are random 256-bit values. Each is stored in a file `<userData>/run/tokens/<principal>.token` (mode 0600), created when the user adds the principal in Settings → Agent access, and deleted when the user revokes it.
3. The principal `cli-default` exists from install, with the default scopes listed in [07 §5](07-agent-friendly-design.md#5-agent-principals-and-scopes) (read, drafts, claims with evidence; nothing human-only). Other principals (`claude-code`, `firstmate-main`, `grok-cc`, `orchestrator-<profile>`) are created explicitly.
4. Principal scopes provide least privilege and an audit trail among cooperating agents on one machine. They are **not** a security boundary against other code running as the same OS user. That boundary is the confirmation gate: only the UI can approve (§4.3 and §11).

### 4.3 Who counts as the user

1. Actor `user` exists only for operations made in the app UI (renderer → main → core over IPC). The main process attaches the actor. The renderer cannot claim another actor.
2. Every CLI and MCP call is an `agent` actor bound to its principal, even when a human typed the command. Agents run in the same shells as humans, so a typed command cannot be told apart from an agent's.
3. Human-only operations return `E_HUMAN_REQUIRED` from the CLI and MCP. The error carries a deep link (`commandcenter://confirmations/<id>`, `commandcenter://items/<ref>` or `commandcenter://requests/<id>`) that opens the right screen. **Owner decision Q3, 10 Nov 2026:** phase 1 has no Confirmations screen. A pending confirmation is shown as an inline prompt where it arises (on the item, the meeting or the onboarding step), and `commandcenter://confirmations/<id>` opens that inline prompt; the Confirmations screen comes in phase 2 (P2-01, [09 §7](09-build-plan.md#7-p2-connector-platform-and-the-first-connector)). The human-only operations are: approving or denying confirmations; confirming, attesting or rejecting claims; deciding decisions; accepting draft items (including on behalf of an absent owner) and dropping items ([03 §7](03-decisions-and-action-items.md#7-action-item-lifecycle)); confirming meeting read-back; installing, updating or uninstalling connectors; granting or revoking scopes; creating or deleting browser sessions; starting connector discovery and choosing its path ([06 §4](06-connector-discovery.md#4-procedure) step 2b); activating a connector or adapter from a new `connectors.lock` entry, and rolling one back; granting or revoking the ticket-run standing approval (§7.4 rule 5); approving, rejecting or deferring a development request on the review screen ([06 §11.1](06-connector-discovery.md#111-review-screen)); setting the backup passphrase or destination, and restoring from a backup (§9.1); editing a goal outside a meeting, on the Scorecard's Goals tab ([03 §5.3](03-decisions-and-action-items.md#53-goal), owner decision Q2, 10 Nov 2026: goals are edited in the app, and agents have no goal scope in [07 §5](07-agent-friendly-design.md#5-agent-principals-and-scopes)).

## 5. Browser sandbox

### 5.1 Requirements

1. The user signs in to browser-only services (WhatsApp Web, LinkedIn) inside CC, not in their personal browser.
2. Sessions are separate (no shared cookies or storage between sessions) and persistent (they survive app restarts).
3. CC never handles credentials beyond that sign-in. No code path types, reads or stores a password, an OTP or a 2FA code, and none answers a security challenge.
4. Browser connectors are Playwright scripts ([05](05-connectors.md)).

### 5.2 Decision

The browser host uses **Playwright persistent contexts**: one `chromium.launchPersistentContext(profileDir, …)` per session, each with its own profile directory under `<userData>/browser/profiles/<sessionId>/`. Isolation and persistence come from construction: one profile per session, one context per profile, and a connector run receives only its session's context. Every API used here is documented Playwright API.

The rejected alternative: Electron partitions (`persist:<id>`) shown inside the main window, with Playwright attached over the Chrome DevTools Protocol. This needs a remote-debugging endpoint that every local process could reach, plus a filtering proxy to keep runs inside one session. Embedding stays an open question (OQ-04-01). Session windows are therefore app-managed Chromium windows, not panes inside the main window.

### 5.3 Types

```ts
type BrowserSessionId = Id<'ses'>;

interface BrowserSession extends Audit {
  id: BrowserSessionId;
  label: string;                         // "LinkedIn (self)", "WhatsApp (Alderwick)"
  service: string;                       // matches a connector manifest's browser.service, e.g. "linkedin"
  origins: string[];                     // top-level navigation allowlist
  accountOwnerId: PersonId;              // must be the user in v1 (contract C-04-06)
  purpose: 'connector' | 'discovery';
  profileDir: string;
  state: 'new' | 'signing_in' | 'signed_in' | 'needs_user' | 'expired' | 'locked' | 'disabled';
  needsUserReason?: 'signed_out' | 'challenge' | 'two_factor' | 'consent_screen' | 'unexpected_page';
  lastProbeAt?: UtcTimestamp;
  bindingIds: ConnectorBindingId[];
  engine: { playwrightVersion: string; browserRevision: string };
  pacing: { minGapMs: number; maxGapMs: number; maxPageLoadsPerHour: number };  // from the manifest, may be tightened
}
```

### 5.4 Flows

1. **Create.** A binding of a browser connector, or a discovery run, asks for a session. The user approves it in the UI (human-only). CC creates the profile directory (0700) and records the origins from the manifest.
2. **Sign in.** The browser host launches the context headed and opens the manifest's `loginUrl`. No connector code is loaded. The user signs in by hand: password, 2FA, whatever the service asks. Then the user clicks **Done** in CC. Only then does the connector's read-only `probeSignedIn` run. Success sets `signed_in`.
3. **Run.** A connector run requests the session. The host takes the per-session lock. If the user's window is open, the run gets a new tab in the same context. Otherwise the host launches the context headless, or headed when the manifest sets `requiresHeaded`. After the run the context closes, or stays warm for up to 10 minutes.
4. **Needs you.** If a run lands on a sign-in page, a challenge or an unexpected page (by the connector's call to `ctx.needsUser`, or by the host's signature checks), the run ends with status `needs_user`. The session state becomes `needs_user`, and an attention entry appears. **Open** shows the page headed. The user resolves it by hand and clicks **Done**, and the probe runs again.
5. **Take over.** The user can open any session window at any time. Running connector work on that session pauses until the window is released.
6. **Sign out.** "Sign out of this session" deletes the profile directory after confirmation. Bound connectors go to `needs_user`.

### 5.5 Runtime guards (applied to every connector run)

| ID | Guard | Behaviour |
|---|---|---|
| G1 | Navigation allowlist | `context.route` aborts document (top-level and frame) requests whose origin is not in `origins`. The run is logged, and fails with `E_GUARD_NAVIGATION` if it was a top-level navigation. |
| G2 | Credential fields | The guarded page refuses `fill`, `type`, `press`, `pressSequentially`, `setInputFiles` and `selectText` on elements with `type=password`, `autocomplete` of `current-password`, `new-password` or `one-time-code`, or a name or id matching `/pass|otp|2fa|totp|pin|cvv/i`. It throws `E_GUARD_CREDENTIAL_FIELD`. |
| G3 | Storage export | The guarded context refuses `cookies`, `addCookies`, `clearCookies` and `storageState`. Request and response header accessors strip `cookie`, `set-cookie` and `authorization`. Connector code never reaches the `Browser` object. |
| G4 | Downloads | Off unless the manifest sets `browser.downloads: true`. Then files go to a run-scoped temporary directory with a size cap, and are deleted after the run. |
| G5 | Permissions | No geolocation, camera, microphone, notifications or clipboard grants unless the manifest declares them. |
| G6 | Pacing | One page load at a time per session. A random gap within [`minGapMs`, `maxGapMs`] between loads. An hourly cap. A cap hit fails the run with a retry-after time and never queues silently. The defaults are 3 to 7 seconds, at most 40 loads an hour. |
| G7 | Challenge detection | After each navigation, the host checks the connector's challenge signatures and common CAPTCHA frames. A match ends the run as `needs_user`. CC never tries to solve a challenge. |
| G8 | No evasion | CC does not hide automation: no changes to `navigator.webdriver`, the user agent or fingerprints. If a service refuses automated sessions, the connector is marked unsupported there, and the API or manual path applies. |

### 5.6 Engine install and pinning

1. The Chromium build is the one pinned by the bundled Playwright version. It is downloaded the first time a browser session is created, after the user agrees to the download, into `<userData>/browser/engine/`.
2. Each session records the Playwright version and browser revision. After an app update changes them, sessions are re-probed before use. A failed probe sets `needs_user`, and data is never deleted.

## 6. AI layer: providers and agent profiles

### 6.1 Boundary

1. Only provider adapter packages (`adapters/ai/<id>` in `cc-connectors`, or in the user's own connectors repository) may import AI SDKs or start an AI CLI (`claude`, `codex`). The foundation's `packages/orchestrator` imports none: it owns profiles, data policy, budgets and the tool loop, and loads adapters through `AiProvider` (§6.2). Dependency rule D1 enforces both sides in CI ([08 §4.2](08-repository-and-automation.md#42-dependency-rules-dependency-cruiser-and-eslint-enforced-in-ci)). Connectors contain no AI ([05](05-connectors.md)).
2. AI tasks: draft (posts, emails, outlines), extract (draft items and decisions from notes or messages, structured onboarding answers from free text), plan (draft execution plans), review (advisory verification), summarize (pre-reads), tailor (job-search material grounded in the candidate's files), discover (connector discovery, [06](06-connector-discovery.md)).
3. AI output never directly causes a `send_publish`, `destructive`, `credential` or `financial` effect. Those always pass a confirmation (§7).
4. Adapters need a stricter bar than connectors, because they receive workspace data and API keys. An adapter loads only from a verified lock entry with the human-only activation of [05 §15.6](05-connectors.md#156-connectorslock-and-the-users-own-connectors), and its manifest states in plain words what data leaves the machine (`dataSent`), which the activation consent shows.

### 6.2 Provider interface

```ts
/** An adapter ID from an installed adapter manifest. Unknown IDs are refused at load.
 *  First-party IDs: 'claude_cli', 'anthropic_api', 'openai'; 'codex_cli' is proposed (spike S3b, P0-09). */
type ProviderId = string;

interface AiAdapterManifest {
  id: ProviderId;
  kind: 'api' | 'cli';
  version: string;                       // semver
  engines: { foundation: string; aiProviderApi: '1' };   // supported @cc/* range (05 §14)
  hosts?: string[];                      // api kind: provider hosts it may reach
  executable?: string;                   // cli kind: 'claude', 'codex'
  dataSent: string;                      // plain words: what leaves the machine, shown at activation
  testedVersions?: string;               // cli kind: the CLI version range its flag probe covers
}

interface AiProvider {
  id: ProviderId;
  probe(): Promise<ProviderProbe>;       // version, auth present (yes/no), models; never returns secrets
  run(task: AiTask, tools: ToolDef[], onEvent: (e: AiEvent) => void, signal: AbortSignal): Promise<AiResult>;
}

interface ProviderProbe { ok: boolean; version?: string; models: string[]; detail: string; verified: boolean }

interface AiTask {
  runId: RunId;
  profile: AgentProfileId;               // §6.4
  system: string;                        // the versioned profile prompt
  input: AiInput[];
  outputSchema?: object;                 // JSON Schema when structured output is required
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  budget: AgentBudget;                   // 03 §5.8
}

type AiInput =
  | { kind: 'instruction'; text: string }                                   // from CC or the user
  | { kind: 'data'; label: string; trust: 'trusted' | 'untrusted'; content: string };

interface ToolDef { name: string; description: string; inputSchema: object }  // generated from packages/schemas

type AiEvent =
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; ok: boolean }
  | { type: 'text'; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; usd?: number };

interface AiResult {
  status: 'completed' | 'refused' | 'budget_exceeded' | 'failed';
  output?: unknown;                      // validated against outputSchema
  text?: string;
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number; usd?: number };
}
```

Tool execution: for API adapters (`anthropic_api`, `openai`), the orchestrator runs the tool loop, and each tool call becomes a local API call as principal `orchestrator-<profile>`. For CLI adapters (`claude_cli`, and `codex_cli` once spike S3b passes), the CLI runs the loop and reaches the same handlers through the MCP relay. Every path therefore meets the same Policy Engine. `none` is an onboarding answer, not a `ProviderId`: no adapter, so no AI step runs.

### 6.3 Providers and adapter rules

Each adapter is a package in `cc-connectors` (`adapters/ai/<id>/`), and its README carries its full provider contract; the table below is the starting text of those READMEs. The rules every adapter must meet stay here:

1. **No built-in tools.** A CLI adapter turns off every built-in tool and allows only CC's MCP tools for the run's principal. An API adapter offers the model only the `ToolDef`s it is given.
2. **Empty run directory.** CLI adapters run in `<userData>/ai/runs/<runId>/`, so no project instructions are read.
3. **Version probe.** `probe()` reports the version and whether auth is present; an untested version is `verified: false` until `pnpm cc:test-provider <id>` passes.
4. **Budgets.** CC enforces `maxMinutes` by killing the process tree or aborting the request, and `maxToolCalls` in the relay or the tool loop.
5. **Secrets** come only from the secret store (§9), or from the CLI's own login, which CC never reads.

| Provider | Contract |
|---|---|
| `claude_cli` | Uses the user's own Claude Code installation and login. CC never sees the credentials. Command (flags checked against `claude --help` of Claude Code 2.1.318 on 2026-11-04): `claude -p "<task prompt>" --output-format stream-json --model <model> --mcp-config <runDir>/mcp.json --strict-mcp-config --tools "" --allowedTools "<mcp__command-center__… list>" --permission-prompts none --no-session-persistence --append-system-prompt "<profile prompt>"`, plus `--json-schema '<schema>'` for structured output and `--effort <level>` when set. It runs in an empty per-run directory `<userData>/ai/runs/<runId>/`, so no `CLAUDE.md` is read. `mcp.json` starts `cc-axi mcp --principal orchestrator-<profile> --run <runId>`. CC enforces `maxMinutes` by killing the process, and `maxToolCalls` in the relay. The adapter has a tested version range: at start it runs `claude --version` and a flag probe, and an unknown version is marked `verified: false` until `pnpm cc:test-provider claude_cli` passes. |
| `anthropic_api` | Official `@anthropic-ai/sdk` TypeScript SDK, with the API key in the secret store (§9). Default model `claude-opus-5-5` for every task type. The user may choose another model per task type in Settings, and CC never switches models by itself, not even to save cost. Effort is set explicitly per profile (Opus 5.5 defaults to `medium`). Tools use `strict: true` with `tool_choice: auto`, because forced tool choice is rejected on current models. Structured output uses `output_config.format` with a JSON Schema. Long tasks stream. Code checks `stop_reason` before reading content (`end_turn`, `tool_use`, `max_tokens`, `refusal`, `pause_turn`). The stable prefix (tools, then the system prompt) is cached. Untrusted data never goes in the system prompt. At setup, the Models API checks that the chosen models are available. |
| `openai` | Official `openai` SDK, Responses API with function tools and strict JSON-Schema structured output. API key in the secret store. The model ID is entered by the user. CC ships no default OpenAI model ID, so no default goes stale. A probe call at setup checks it. |
| `codex_cli` (proposed) | Uses the user's own Codex CLI installation and login (checked with `codex-cli 0.167.0` on 2026-11-06; not verified with a logged-in run). Draft command: `codex exec --json --ephemeral --skip-git-repo-check --ignore-user-config --ignore-rules -C <userData>/ai/runs/<runId> -s read-only -m <model> --output-schema <runDir>/schema.json -c approval_policy="never" -c web_search="disabled" -c model_reasoning_effort="<effort>" -c developer_instructions="<profile prompt>" -c mcp_servers.command-center.command="cc-axi" -c 'mcp_servers.command-center.args=["mcp","--principal","orchestrator-<profile>","--run","<runId>"]' -c 'mcp_servers.command-center.enabled_tools=[<profile allowlist>]' -c mcp_servers.command-center.required=true --disable shell_tool --disable view_image --disable image_generation --disable browser_use --disable computer_use --disable multi_agent --disable plugins --disable apps "<task prompt>" </dev/null`. Budgets as for `claude_cli`. Version probe: `codex --version`, `codex exec --help`, `codex features list`; auth probe: `codex login status` (exits 1 when logged out). **Not verified:** that the disables leave only CC's MCP tools (Codex documents that `unified_exec` opt-outs are ignored); whether a global `$CODEX_HOME/AGENTS.md` is still read; which `default_tools_approval_mode` avoids prompts in `exec`; the usage and cost fields of `turn.completed`; whether `enabled_tools` takes bare tool names. **Main risk:** if a command tool cannot be removed, `-s read-only` still lets shell commands read any file the user can read. It ships only after spike S3b (P0-09) proves AC-04-13. |

### 6.4 Agent profiles

| Profile | Purpose | Default tools (allowlist) | Output | Default effort |
|---|---|---|---|---|
| `drafter` | Draft posts, emails, blog outlines, nudge messages | `cc_get`, `cc_search`, `cc_connector_invoke` limited to `write_external_draft` actions, `cc_attach_evidence` | Drafts saved as evidence or connector drafts | `high` |
| `extractor` | Turn notes, messages and emails into draft items and decisions; turn onboarding free text into suggested answers | `cc_get`, `cc_create_action` (drafts), `cc_propose_decision` | Drafts with `source.kind = 'agent_suggestion'` | `medium` |
| `planner` | Propose an execution plan and evidence requirements for an item | `cc_get`, `cc_connector_actions` | A plan draft the user accepts | `high` |
| `reviewer` | Advisory check of evidence against done-means (03 §9.2) | `cc_get` | `{ verdict, notes }` | `high` |
| `summarize` | Pre-read summary (02 §6.2) | none (input is given) | Text labelled "AI-drafted" | `medium` |
| `tailor` | Job-search material grounded in the workstream's `groundingRefs`, following the never-invent rule (no invented experience, titles or numbers) | `cc_get` | Draft files plus a grounding audit (every claim traced to a source line) | `high` |
| `discoverer` | Connector discovery ([06](06-connector-discovery.md)) | `discovery_*` tools only | `ConnectorSpecReport` | `high` |

Rules:

1. Profile prompts are versioned files at `packages/orchestrator/profiles/<id>.md`. A run records the profile version.
2. Step allowlists may narrow a profile's tools, never widen them. The syntax is `<tool>` or `cc_connector_invoke:<binding-label>.<action>`.
3. The provider and model come from Settings: a per-task-type entry first, then the default provider.

### 6.5 Data policy and untrusted content

1. Profiles receive only the records referenced by the step, with minimal fields.
2. The workstream's `aiDataPolicy` applies: `allow`; `redact_people` (names become role tokens such as `[Client contact]`, and emails, phone numbers and street addresses are masked before sending); or `deny` (no AI step can run for that workstream, and the planner and drafter are disabled there).
3. Secrets and credentials are never part of any input.
4. Untrusted content is wrapped as `{ kind: 'data', trust: 'untrusted' }`: emails, postings, web pages, chat messages, connector outputs, firstmate ledger text. It is rendered as `{"untrusted_content": …}`, with the standing instruction that it is data, never instructions. Posted text from outside (job postings, web pages) first passes a sanitiser that strips hidden text and instruction-like markup.
5. A tool call that an injection could have caused (for example an unexpected recipient) is still bound by the confirmation, which shows the exact payload.

### 6.6 Usage and budgets

1. Every run records provider, model, tokens and cost where the provider reports them.
2. Budgets: per step (`AgentBudget`); per day for the workspace (`dailyBudgetUsd`). A run that would exceed a budget stops with `E_BUDGET` and keeps partial drafts.
3. Settings shows cost per workstream per week.

### 6.7 Orchestration framework: no LangChain or LangGraph in P3

Decision (board review, 6 Nov 2026): do not adopt LangChain, and do not adopt LangGraph for P3.

1. CC must build the hard parts anyway: the policy gate, payload-bound approvals, durable waits that survive restarts (§7.3, [03 §12](03-decisions-and-action-items.md#12-persistence)), and local run records (§6.6). LangGraph's `interrupt()` restarts the whole node on resume, which is weaker than a payload-bound confirmation, and its hosted tracing would conflict with `aiDataPolicy`.
2. CLI adapters run their own loop, so a graph could only wrap a whole run as one opaque node.
3. Cost, measured on 2026-11-06: the minimum `@langchain/langgraph` 1.7.1 plus `@langchain/core` 1.3.5 install is 15 top-level packages and 67 MB of `node_modules`, with 64 and 81 stable releases in the previous 12 months. The JS SQLite checkpointer depends on `better-sqlite3`, which would need its own Electron rebuild.
4. **Revisit only** for a long, branching loop inside one AI run, such as connector discovery in P6. Even then, use only `@langchain/langgraph` and `@langchain/core` inside `packages/orchestrator`, with a checkpointer on CC's SQLite store and tracing off. The `AiProvider` seam keeps that later decision cheap. `langchain*` stays on the connector AI denylist ([05 §12](05-connectors.md#12-no-ai-in-connectors-enforcement)).

## 7. Policy engine and confirmations

### 7.1 Risk classes

| Class | Meaning | Examples |
|---|---|---|
| `read` | Reads data; no effect outside CC | list events, search mail, read posts |
| `write_internal` | Changes CC data only | create a draft item, record a measure |
| `write_external_draft` | Creates an unpublished object only the user sees | Gmail draft, CMS draft |
| `write_external` | Changes outside state visible only to the user | upsert a CC calendar event, label mail |
| `send_publish` | Sends or publishes to other people | send mail, publish a post, send a WhatsApp message, calendar invites |
| `destructive` | Deletes or irreversibly changes outside state | delete a post, delete mail |
| `credential` | Creates, rotates or revokes credentials, or changes security settings | create an API key during discovery |
| `financial` | Purchases, billing, payments | none allowed in v1 |

### 7.2 Evaluation order

`evaluate(actor, operation) → allow | confirm | deny`. The first rule that decides wins:

1. Human-only operation (§4.3) and actor is not `user`: **deny** `E_HUMAN_REQUIRED`.
2. Agent actor lacks the scope: **deny** `E_FORBIDDEN`.
3. Agent actor's workstream filter excludes the target: **deny** `E_FORBIDDEN`.
4. The connector action is missing from the installed manifest, or needs an OAuth scope the binding was not granted: **deny** `E_PERMISSION`.
5. Rate limit or budget exceeded: **deny** `E_RATE_LIMIT` with a retry time.
6. Risk class:
   - `read`, `write_internal`, `write_external_draft`: **allow**.
   - `write_external`: **allow** if a standing approval covers it (§7.4), else **confirm**.
   - `send_publish`: **allow** only if a pre-approved payload hash matches exactly (§7.4), else **confirm**. Actions in the UI by the user (pressing "Send" on a shown payload) count as that confirmation.
   - `destructive`: **confirm**, with a typed reason. Standing approval is never possible, except deleting CC-owned calendar events inside the calendar standing approval (02 §9.2).
   - `credential`: **confirm**, and only inside a discovery run ([06](06-connector-discovery.md)). Elsewhere **deny**.
   - `financial`: **deny**.
7. A step with `confirmation: 'always'` turns any `allow` above into **confirm**.

Every non-`read` evaluation is recorded as a domain event (`policy.evaluated`) with the result.

### 7.3 Confirmation requests

```ts
type ConfirmationId = Id<'cfm'>;

interface ConfirmationRequest {
  id: ConfirmationId;
  createdAt: UtcTimestamp;
  expiresAt: UtcTimestamp;               // default 24 h; for scheduled content, the scheduled time
  requestedBy: Actor;
  subject:
    | { kind: 'connector_action'; bindingId: ConnectorBindingId; action: string; risk: RiskClass }
    | { kind: 'discovery_step'; runId: RunId; description: string; risk: RiskClass }
    | { kind: 'calendar_batch'; seriesIds: MeetingSeriesId[]; eventCount: number; calendarId: string }
    | { kind: 'session_create'; service: string };
  actionItemId?: ActionItemId;
  payloadPreview: string;                // exact human-readable preview: full text, recipients, URLs, counts
  payloadHash: string;                   // sha256 of the canonical JSON payload
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'consumed';
  decidedAt?: UtcTimestamp;
  decisionNote?: string;
}
```

Rules:

1. Approve, deny or edit happens only in the app (human-only): in phase 1 in the inline prompt, from P2 also on the Confirmations screen (§4.3 rule 3, owner decision Q3, 10 Nov 2026). Editing changes the payload, and therefore the hash. The edited payload is what gets approved and executed.
2. An approval is single-use and bound to `payloadHash`. If execution would use any other payload, it is refused (`E_PAYLOAD_CHANGED`).
3. Requests are idempotent: repeating the same operation with the same payload returns the same pending request.
4. CLI and MCP callers get `status: pending_confirmation` with the request ID and a deep link. They can wait with `cc-axi confirmations wait <id> --timeout <s>` ([07](07-agent-friendly-design.md)).

### 7.4 Standing approvals and pre-approved payloads

```ts
interface StandingApproval {
  id: string;
  bindingId: ConnectorBindingId;
  action: string;
  risk: 'write_external' | 'send_publish' | 'destructive';
  constraints: {
    ccOwnedOnly?: boolean;               // calendar: events whose cc_ws matches
    calendarId?: string;
    noAttendees?: boolean;
    maxPerDay?: number;
    repo?: string;                       // ticket run: the user's engine repository, "owner/name"
    labels?: string[];                   // ticket run: exactly ["cc:request"]
    issueTemplate?: string;              // ticket run: "connector-request"
    destination?: string;                // backups: the destination label (§9.1)
  };
  payloadHashes?: string[];              // required for send_publish: exact pre-approved payloads
  createdAt: UtcTimestamp;
  expiresAt: UtcTimestamp;
  createdBy: { kind: 'user' };
}
```

1. `write_external` standing approvals are scope-based, for example the calendar approval of 02 §9.2.
2. `send_publish` is pre-approved only by exact payload hash, with the one exception of rule 5. Approving three LinkedIn drafts in a content review creates one approval holding their three text hashes, valid until each scheduled time plus 1 hour. Publishing any other text needs a new confirmation.
3. `destructive` standing approval is allowed only for deleting CC-owned calendar events (02 §9.2). `credential` and `financial` never get standing approvals.
4. The user can list and revoke standing approvals in Settings at any time.
5. **Ticket-run standing approval.** The scheduled ticket run ([06 §11.2](06-connector-discovery.md#112-ticket-run)) files issues in the user's own engine repository, which is `send_publish` for the `github` connector's `create_issue`. It is the one scope-based `send_publish` approval: action `create_issue` on the `github` binding whose token is limited to that repository, with constraints `repo`, `labels: ["cc:request"]`, `issueTemplate: "connector-request"` and `maxPerDay`. Granting it is human-only (§4.3). It never covers adding or removing labels, so it can never apply `cc:approved` or `cc:rejected` ([06](06-connector-discovery.md) C-06-11).
6. **Backup uploads** to a Google Drive or S3 destination (§9.1) are `write_external` under a scope-based approval created when the user sets the destination, limited to that destination's folder or prefix.

## 8. MCP server

1. **Transport.** stdio. The MCP client starts `cc-axi mcp --principal <name>`. This relay connects to the local socket (§4.1), authenticates with the principal's token, and forwards MCP requests to the same handlers as the CLI. It holds no state.
2. **Not running.** If the app is not running, the relay starts nothing. It answers every tool call with a structured error (`E_APP_NOT_RUNNING`, with help "Open Command Center, then retry"). The tools list still works, so clients can discover the server.
3. **Registration.** Settings → Agent access → Add client creates the principal and its scopes, and prints the command, for example `claude mcp add command-center -- cc-axi mcp --principal claude-code`.
4. **Surface.** Tools only in v1 (no resources or prompts), so that clients behave the same. The tool list, inputs and outputs are in [07 §7](07-agent-friendly-design.md#7-mcp-server-surface).
5. **Streamable HTTP** on `127.0.0.1` with a bearer token is off by default (OQ-04-04).

## 9. Storage, secrets and data location

```text
<userData>/                          # Electron app.getPath('userData'):
                                     # macOS ~/Library/Application Support/Command Center/
                                     # Windows %APPDATA%\Command Center\   Linux ~/.config/Command Center/
  workspace.db, workspace.db-wal     # SQLite (03 §12)
  blobs/<aa>/<sha256>                # content-addressed files
  secrets/                           # safeStorage ciphertext, one file per secret ref
  browser/engine/                    # pinned Chromium (5.6)
  browser/profiles/<sessionId>/      # one profile per browser session (0700)
  connectors/<id>/<version>/         # installed connector packages (05)
  adapters/<id>/<version>/           # installed AI adapter packages (§6.3)
  connectors-state/<bindingId>.json  # cursor stores (at most 64 KB each)
  lock/last-known-good.json          # the last connectors.lock whose entries all activated (05 §15.6)
  discovery/<runId>/                 # spec reports, sanitised fixtures, human-steps.json, audit.jsonl (06)
  requests/<requestId>.json          # development requests: run ID -> issue URL and status (06 §10.4)
  ai/runs/<runId>/                   # CLI adapter working dirs; deleted after the run unless debug is on
  run/cc.sock, run/tokens/           # local API endpoint and principal tokens
  logs/                              # redacted JSON lines, rotated 10 x 5 MB
  backups/                           # the local set: 7 daily + 4 weekly encrypted archives (§9.1)
```

1. **Secrets** (API keys, OAuth access and refresh tokens, registry trust keys) are encrypted with Electron `safeStorage`, which uses the OS keychain or credential store. Only main and core decrypt them. Secrets are never written to logs, events, exports or AI inputs, and never passed to connector code: the host injects auth ([05](05-connectors.md)).
2. **Logs** pass a redaction filter: known secret values, `Authorization` and `Cookie` headers, and email addresses in sensitive workstreams.
3. **Backups** are scheduled and encrypted, kept locally and copied off the machine (§9.1).
4. User data never goes into any of the three repositories (`cc-foundation`, `cc-engine`, `cc-connectors`) or the user's copies of them. The user's engine repository holds only non-sensitive configuration, and CC itself never commits to git ([01 §9.1](01-onboarding-and-frameworks.md#91-where-answers-live)). Fixtures are synthetic or sanitised ([08](08-repository-and-automation.md)).
5. **`<userData>` must not sit inside a synced folder** (Google Drive, Dropbox, OneDrive, iCloud Drive or similar). A live SQLite database with its WAL file is corrupted by file-level sync. At start, CC checks the path against the known sync roots and refuses to open the store there, with help to move it.

### 9.1 Backups

The local store is the source of truth (README decision 11), so it is backed up regularly, encrypted, and tested by restoring it.

```ts
interface BackupPolicy {
  localRetention: { daily: number; weekly: number };        // default 7 and 4
  destination?: BackupDestination;                           // off-machine copy; none until the user picks one
  offMachineRetention: { daily: number; weekly: number };    // default 7 and 4
  passphraseSetAt?: UtcTimestamp;                            // the passphrase itself is never stored
  restoreTestEveryDays: number;                              // default 30
}

type BackupDestination =
  | { kind: 'folder'; label: string; path: string }          // e.g. the Google Drive desktop synced folder, a NAS, a USB disk
  | { kind: 'google_drive'; label: string; bindingId: ConnectorBindingId; folderName: string }  // drive.file scope only
  | { kind: 's3'; label: string; bindingId: ConnectorBindingId; bucket: string; prefix: string; region: string };

interface BackupRecord {
  id: string;
  at: UtcTimestamp;
  trigger: 'scheduled' | 'pre_migration' | 'pre_update' | 'manual';
  archiveSha256: string;
  local: { path: string; ok: boolean };
  offMachine?: { destination: string; ok: boolean; error?: string };
}

interface BackupStatus {
  lastGoodLocalAt?: UtcTimestamp;
  lastGoodOffMachineAt?: UtcTimestamp;
  lastRestoreTest?: { at: UtcTimestamp; ok: boolean; detail: string };
  state: 'ok' | 'warning' | 'failing' | 'not_configured';
}
```

1. **Schedule.** Daily, after the daily shutdown (or at the first idle moment of the day if the app was closed), and always before a migration, a foundation update or a restore. Runs never overlap a meeting `in_progress`.
2. **What a backup holds.** A consistent snapshot of `workspace.db` from SQLite's online backup API, the blobs it references, and a manifest of hashes, packed into one archive. It never holds `secrets/` (the `safeStorage` ciphertext is bound to this machine's keychain), browser profiles, tokens or logs. After a restore on a new machine, the user re-enters keys and signs in again.
3. **Encryption** (settles OQ-04-06). Every archive, local and off-machine, is encrypted with an authenticated cipher under a key derived from a **user passphrase** with a memory-hard KDF; the exact algorithms and parameters are fixed in an ADR in P1-17. The derived key is kept wrapped by `safeStorage`, so scheduled runs need no prompt (OQ-04-08). Until the user sets a passphrase, the local set is still written, under a random key held in `safeStorage`, off-machine copies are off, and the status stays `not_configured`. CC cannot recover a lost passphrase; setup offers a printable recovery sheet.
4. **Local set.** 7 daily and 4 weekly archives in `<userData>/backups/`, pruned after each run.
5. **Off-machine destination**, chosen by the user at onboarding S1 or in Settings → Backups:
   - **A folder** anywhere, such as the Google Drive desktop app's synced folder, Dropbox, a NAS or a USB disk. CC writes only finished, encrypted archives (to a temporary name, then renamed); the sync client uploads them.
   - **Google Drive** through the `google-drive` connector with the `drive.file` scope, so CC sees only the files it created.
   - **S3** (or an S3-compatible store) through the `s3` connector, with credentials in the secret store and a bucket prefix.
   The same retention applies there, by default. Uploads through a connector run under the standing approval of §7.4 rule 6.
6. **Never the live database in a synced folder.** Only encrypted archives go to a destination; `workspace.db` and its WAL never do (§9 rule 5, C-04-09).
7. **Restore test.** Every `restoreTestEveryDays` days, and after a destination or passphrase change, CC fetches the newest off-machine archive (or the newest local one if there is no destination), decrypts it into a temporary directory, verifies the manifest hashes, opens the database read-only, runs `PRAGMA integrity_check`, and compares row counts with the live store at the snapshot's event ID. The result is recorded.
8. **Status.** Settings → Backups and the Home screen show "Last good backup" (time and destination), the last restore test and the state. The state is `warning` when no off-machine backup succeeded in 48 hours, and `failing` when the last restore test failed or no backup at all succeeded in 72 hours. `warning` and `failing` are attention items, and `failing` is pushed ([02 §10](02-rhythm-and-calendar.md#10-notifications)). **`not_configured`** (no off-machine destination yet) follows **owner decision Q8, 10 Nov 2026**: a one-time notice when onboarding commits without a destination, then a standing line in the weekly CEO review ([02 §5.1](02-rhythm-and-calendar.md#51-agendaeos-liteweekly1-60-min)) until a destination is set. There is no permanent banner, and `not_configured` is not a daily attention item (this replaces the earlier default of OQ-01-07). Which weekly meeting carries the line in a workspace with no weekly CEO review is open (OQ-04-12).
9. **Restore** is human-only, in Settings → Backups. CC first backs up the current store, then restores the chosen archive and restarts core.

## 10. Packaging, updates and OS support

1. **The app is a build of the user's engine repository.** The user creates their engine from the `cc-engine` template ([08](08-repository-and-automation.md)), then runs install and build. The engine holds no foundation code: it pins the `@cc/*` packages at exact versions, and the foundation's build tooling (`@cc/build`, electron-builder) produces the app for the current OS: macOS arm64 or x64, Windows x64, and Linux from P7. Code signing is optional for a personal build (OQ-08-03).
2. **Foundation updates** arrive as dependency PRs (Renovate or Dependabot) in the user's engine repository, updating every `@cc/*` pin together. The foundation supports extension API N and N−1, so the PR builds and merges as it is; the engine's CI runs `pnpm cc:upgrade --check` on it and comments the codemod edits the next API version will need. The user runs `pnpm cc:upgrade` locally when convenient, before the next major, and merges its edits like any change (owner decision D-1, 10 Nov 2026, spike S6). **Owner decision C1, 10 Nov 2026:** after the merge, the user pulls the merged update into their local engine checkout themselves, as they already run `cc:upgrade` themselves. CC never pulls: C-01-09 keeps no exception. Then:
   - **Stale build.** The build records the engine commit and the lockfile hashes it was built from. At every start, and when the app is idle, CC compares them with the checkout's `HEAD` and lockfiles (the same read-only check as the clean-tree start of rule 4; its speed is settled by spike S7, P0-11). When they differ and the checkout is clean, CC shows that the running app is older than the checkout and offers **Rebuild now** and **Later**. The user may defer; the offer stays until the build matches. A dirty checkout gets no Rebuild now offer; rule 4 applies at the next start.
   - **Rebuild now runs in the app** (owner decision, 10 Nov 2026: "The app should rebuild itself"). CC takes a pre-update backup (§9.1), then builds from the clean checkout: it reads the committed tree at `HEAD` and builds it in a build directory under `<userData>`, with a frozen install from the checked-in lockfiles. It writes only build output, there, and never the checkout's source or anything else inside the checkout, so C-01-09 holds. When the build succeeds, main restarts core and the renderer on it when idle: no meeting `in_progress` and no run in flight. A failed build changes nothing: the running app stays, and the failure is shown with the build log. Until backups exist (P1-17) the pre-update backup step has nothing to take and the app log records that it was skipped; until runs exist (P3) idle means no meeting `in_progress`. Rebuild now runs the Node and pnpm the build recorded in its stamp, so it works in an app started from the Dock or the Start menu.
   - Rebuild now is an app action; whether the CLI or MCP may start it is open (OQ-04-11).
3. **Connector and lock changes** need no rebuild. The lock loader activates a new `connectors.lock` entry between runs ([05 §15.4](05-connectors.md#154-update-and-rollback) rule 2). Adapters, engine UI and theme changes, and foundation updates need the idle restart.
4. **Clean-tree start.** CC starts normally only when the running build was made from a clean checkout whose lockfiles matched the install, and the checkout is still clean at that commit (runtime-read files such as `connectors.lock` excepted). `@cc/build` writes a build stamp into the app and an install stamp at every `pnpm install`, builds only git's view of the tree, and runs the check at start and when idle ([ADR 0004](../adr/0004-clean-tree-start.md)). Otherwise CC starts in labelled **dirty-tree mode** (spike S7, P0-11); a clean checkout whose build is out of date gets the Rebuild now offer of rule 2. Dirty-tree mode is not **connector developer mode**, the human-only Settings → Developer → Load unpacked connector of [05 §15.5](05-connectors.md#155-connector-developer-mode); the two had the same name before (review finding 10, named apart by owner decision, 10 Nov 2026).
5. Electron hardening lives in the foundation's build tooling, so every engine build gets it: `contextIsolation`, `sandbox`, no `nodeIntegration`, a strict CSP, `setWindowOpenHandler` deny, `will-navigate` blocked, a permission request handler that denies everything, and these fuses: RunAsNode off, EnableNodeOptionsEnvironmentVariable off, EnableNodeCliInspectArguments off, EnableEmbeddedAsarIntegrityValidation on, OnlyLoadAppFromAsar on.
6. Optional open-at-login keeps rhythms and syncs running. When the app is closed, nothing runs, and the reconciler catches up at the next start (02 §9.4).

## 11. Security model

| Threat | Example | Mitigations |
|---|---|---|
| Prompt injection | A job posting or email says "send the CV to x@y" | Untrusted wrapping (§6.5); AI output is a draft; payload-bound confirmations for every send (§7) |
| Buggy or compromised connector | A connector posts more than asked, or exfiltrates data | Manifest permissions (hosts, origins, scopes); host-injected auth (no raw secrets); risk classes from the manifest; guards G1 to G8; signed registry packages; static checks ([05](05-connectors.md)) |
| Malicious registry package | A tampered tarball | Signature and checksum verification against pinned publisher keys; permission diff on update ([05](05-connectors.md)) |
| Buggy or hostile connector built by firstmate | A connector from the user's own repository misbehaves | The user reviews and merges the PR; the sha256 pin in the user-merged `connectors.lock`; static checks re-run at load; staged, human-only activation; crash-loop disable and last-known-good rollback ([05 §15.6](05-connectors.md#156-connectorslock-and-the-users-own-connectors)) |
| The engine's AI changes code | An agent working in the engine repository edits a widget or the lock | Five layers ([08 §5](08-repository-and-automation.md#5-agentsmd-for-each-repository)): `AGENTS.md` states the rule; the in-app AI has no file or shell tools; CC's GitHub token has no Contents access; `main` is protected with the user as CODEOWNER and a path guard; CC starts normally only from a clean tree, and a dirty one runs in labelled dirty-tree mode (§10 rule 4); the start check ignores repository-configured git hooks and fsmonitor, and detects index flags and local excludes ([ADR 0004](../adr/0004-clean-tree-start.md)); harness deny rules |
| Leaked GitHub token | The ticket run's token is copied | Fine-grained: one repository, Issues and Metadata only, no Contents; kept in the secret store and used only by the host; revocable in Settings |
| Data loss | A disk failure, a lost laptop, a corrupt database | Scheduled encrypted backups, local and off-machine, with restore tests and a visible status (§9.1) |
| Backup leak | An archive in a cloud folder is read by someone else | Passphrase encryption of every archive; `drive.file` scope for Google Drive; no secrets in archives (§9.1) |
| Same-user local process | Malware running as the user | Out of scope as a full boundary (§4.2 rule 4). Reduced by: no TCP ports, 0600 sockets and tokens, approvals only in the UI, Electron fuses, OS code-signing protections |
| AI mistakes | Wrong recipient, wrong text | Exact payload previews; payload hashes; nothing sent without the user |
| Credential leakage | Session cookies or API keys copied out | G3; `safeStorage`; redacted logs; discovery stores keys without showing them to the model ([06](06-connector-discovery.md)) |
| Over-sharing with AI providers | A sensitive workstream's or item's data (e.g. the confidential A-0152) sent to a provider | `aiDataPolicy`; minimal context; `sensitive` privacy (INV-03-10) |
| Calendar leaks | Item titles in event text | Event text limited to the agenda outline (02 §9.2 rule 3) |
| Supply chain | A dependency compromise | Locked dependencies, update review, audit in CI ([08](08-repository-and-automation.md)) |

## 12. Performance budgets

1. Cold start to usable UI in 3 seconds or less on a 2023 laptop.
2. `home.get` p95 of 150 ms or less with 10,000 items.
3. `cc-axi --version` within 50 ms of the bare `node -e` floor measured on the same machine (AXI §10 fast path).
4. MCP read tools p95 of 300 ms or less, excluding connector calls.
5. A reconciliation pass over 200 events in 5 seconds or less.

## 13. Contracts

1. **C-04-01** Every operation from UI, CLI, MCP or the AI layer runs the same handler and the same Policy Engine evaluation.
2. **C-04-02** No code path types into, reads from or stores a password, OTP or 2FA field (G2), and none answers a security challenge (G7).
3. **C-04-03** Connector code cannot read cookies, storage state or auth headers (G3), and cannot reach secrets.
4. **C-04-04** No TCP listener is opened unless the user enables the HTTP MCP transport.
5. **C-04-05** Only the UI can approve confirmations or perform the other human-only operations of §4.3.
6. **C-04-06** In v1, a browser session belongs to the user's own account (`accountOwnerId` = self). CC offers no flow for signing in as another person.
7. **C-04-07** A `send_publish` effect happens only with a matching single-use approval or a pre-approved payload hash.
8. **C-04-08** Only provider adapter packages talk to AI providers or start an AI CLI. The foundation, including `packages/orchestrator`, imports no AI SDK (checked by dependency rule D1 in each repository's CI).
9. **C-04-09** Every backup archive is encrypted before it is written anywhere. CC never writes the live database or its WAL into a backup destination, and never opens a store inside a synced folder.
10. **C-04-10** A restore is human-only, and always takes a backup of the current store first.
11. **C-04-11** The ticket-run standing approval covers only `create_issue` on the user's engine repository with the `cc:request` label and the `connector-request` template. It never covers labels or other repositories.

## 14. Acceptance criteria

1. **AC-04-01** A connector fixture test that calls `fill` on `input[type=password]` fails with `E_GUARD_CREDENTIAL_FIELD`. One that calls `context.cookies()` fails with a guard error.
2. **AC-04-02** A LinkedIn session survives an app restart without a new sign-in, and a WhatsApp session in a second profile shares no cookies with it (verified in spike S1 on macOS and Windows).
3. **AC-04-03** A navigation from a LinkedIn run to an outside origin is aborted and logged (G1).
4. **AC-04-04** `cc-axi confirmations approve <id>` does not exist. Any attempt to approve through MCP returns `E_HUMAN_REQUIRED` with a deep link.
5. **AC-04-05** Editing an approved draft's text before sending fails the send with `E_PAYLOAD_CHANGED`, and creates a new confirmation request.
6. **AC-04-06** With `claude_cli` selected, a drafter run executes with `--tools ""` and an empty working directory, and can call only the allowlisted CC MCP tools (verified by the relay's audit log).
7. **AC-04-07** With `anthropic_api`, the default model sent is `claude-opus-5-5`. Changing it in Settings changes it, and nothing changes it otherwise.
8. **AC-04-08** `lsof` (macOS and Linux) and `netstat` (Windows) show no listening TCP socket owned by CC in the default configuration.
9. **AC-04-09** A `redact_people` workstream's AI inputs contain no email address, phone number or person name from that workstream (checked with canary values).
10. **AC-04-10** With a folder destination and a passphrase set, a scheduled backup writes one archive locally and one to the folder. Neither contains a canary record title in plain bytes, and the folder never holds `workspace.db` or a `-wal` file. The local set is pruned to 7 daily and 4 weekly over a simulated 60 days.
11. **AC-04-11** Corrupting the newest off-machine archive makes the next restore test fail, sets the backup state to `failing`, pushes one notification and adds an attention item; "last good backup" still shows the previous archive. Restoring that previous archive in the UI first backs up the current store.
12. **AC-04-12** Starting CC with a profile directory inside a fixture sync root (a folder with a Google Drive or Dropbox marker) refuses to open the store and exits with help to move it.
13. **AC-04-13** With `codex_cli` selected, a drafter run can call only the allowlisted CC MCP tools, and an attempt by the model to run a shell command produces no command execution (verified by the relay's audit log and a canary file the run must not read). *Proved in spike S3b before `codex_cli` ships.*
14. **AC-04-14** In a fixture engine checkout, committing a change that moves `HEAD` past the running build makes CC offer Rebuild now, and a dirty checkout gets no offer. Rebuild now takes a pre-update backup, builds, and restarts on the new build when idle, and a hash of every file under the checkout, ignored files included, is the same before and after (owner decisions C1 and Rebuild now, 10 Nov 2026; C-01-09).

## 15. Open questions

1. **OQ-04-01** Should browser sessions be embedded in the main window (Electron partitions with CDP attach) rather than shown as separate app-managed windows? It needs a spike on Playwright's CDP support for Electron partitions, plus a filtering proxy. *Default: separate windows in v1.*
2. **OQ-04-02** Are Chromium profiles launched by Playwright encrypted at rest with the OS keychain on each OS, or is the cookie store readable by any process running as the user? *Default: verify in spike S1; document the result; rely on OS disk encryption meanwhile.*
3. **OQ-04-03** Should the sign-in window be a plain Chromium launch (not driven by Playwright), so services see no automation during sign-in? This must not become automation-hiding (G8). *Default: Playwright-launched; revisit only if a service blocks sign-in.*
4. **OQ-04-04** Is an HTTP MCP transport needed for clients that cannot spawn stdio processes? *Default: off; add it behind a setting with a bearer token if needed.*
5. **OQ-04-05** Multi-device use (laptop and desktop)? *Default: single device; export and import only.*
6. **OQ-04-06** Should backups copied outside `<userData>` be encrypted with a user passphrase? *Settled by the board (6 Nov 2026): yes. Every archive is encrypted with a passphrase-derived key (§9.1).*
7. **OQ-04-07** Can Electron `utilityProcess` apply Node's permission model flags to connector runs? *Spike S2; if not, run connectors in a bundled Node binary with `--permission`, or rely on static checks plus review.*
8. **OQ-04-08** Where does the passphrase-derived backup key live between runs? *Default: wrapped by `safeStorage`, so scheduled backups run unattended; the user can choose "ask for the passphrase each time" instead, which pauses off-machine copies until it is entered.*
9. **OQ-04-09** Do API adapters run inside core, or in their own `utilityProcess`? *Default: first-party adapters from `cc-connectors` run in core; adapters from the user's own repository run in their own `utilityProcess`.*
10. **OQ-04-10** Which off-machine destination does onboarding recommend? *Default: none is pre-selected; the folder option is shown first, as the simplest, with Google Drive and S3 as alternatives.*
11. **OQ-04-11** May the CLI or MCP start Rebuild now (§10 rule 2), or only the app? It takes a backup and restarts the app, but changes no record. *Default: the app only; `cc-axi` reports the stale build in its home view.*
12. **OQ-04-12** Owner decision Q8 puts the standing "no off-machine backup destination" line in the weekly CEO review (§9.1 rule 8). Where does it go in a workspace with no weekly CEO review? *Default: under the first section of every weekly meeting that covers all of the user's own workstreams (`headlines` where the agenda has one, 02 §5.1); if none does, the daily start's attention list.*
