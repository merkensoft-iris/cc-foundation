# Command Center: design documents

- **Purpose:** Index and shared conventions for the Command Center (CC) design. CC is a local-first desktop app that joins two things: running a company well (operating rhythm, decisions, accountability), and getting every decision and action item carried out and verified. These documents are written for an AI developer who will build CC.
- **Depends on:** nothing. Read this file first.
- **Related files:** all of them (see §2). The phased build plan is its own file: [09-build-plan.md](09-build-plan.md).

## 1. How to read these documents

1. Read this index, then [03](03-decisions-and-action-items.md) (the record model), then the file for the area being built. Each file stands alone: it has a header with Purpose, Depends on and Related files, and it restates any convention it relies on.
2. Each file has the same shape: summary, scope, typed definitions (TypeScript), behaviour, a worked part of the reference scenario, **contracts** (`C-<file>-<n>`, binding rules), **acceptance criteria** (`AC-<file>-<n>`, testable statements) and **open questions** (`OQ-<file>-<n>`).
3. A reference such as "03 §9.2" means file 03, section 9.2. Links are relative, so they work in the GitHub file view and in a local checkout.
4. An open question's *Default* (in italics) is the assumption the design uses until the user decides.
5. [09](09-build-plan.md) sets the build order (the foundation, a basic engine, the owner's own instance, then connectors on demand) and assigns every acceptance criterion to a phase gate or a connector-track item. Build in that order.

## 2. Document map

| File | Brief section | Covers | Main types it owns | First phase |
|---|---|---|---|---|
| [01-onboarding-and-frameworks.md](01-onboarding-and-frameworks.md) | 1 | Onboarding steps S1 to S9; framework templates `personal-os`, `4dx`, `eos-lite` (and later `eos`, `okr`, `scaling-up`); the fixed backbone and bounded parameters; packs; the decision tree as inputs, rules (R1 to R9, M1 to M8, T1 and T2) and outputs | `OnboardingProfile`, `FrameworkTemplate`, `Invariant`, `ParameterSpec`, `FrameworkInstance`, `FrameworkRecommendation`, `Pack` | P1 |
| [02-rhythm-and-calendar.md](02-rhythm-and-calendar.md) | 2 | Meeting series and instances, absorption and merged meetings, agendas with timeboxes, inputs, pre-reads and outputs, carry-forward, the escalation ladder E0 to E4, modular calendar sync through one provider contract, and notifications | `MeetingSeries`, `MeetingInstance`, `AgendaTemplate`, `MeetingOutputs`, `InputQuery`, `CalendarProvider`, `CalendarMapping` | P1 (`.ics`), P2 (Google), connector track (Microsoft 365, CalDAV, on demand) |
| [03-decisions-and-action-items.md](03-decisions-and-action-items.md) | 3 | The record model: workstreams, goals, measures, decisions, issues, risks, action items, execution plans with performers (user, person, connector, agent, external agent), evidence and the review loop, domain events, persistence | `Actor`, `Workstream`, `Decision`, `ActionItem`, `ExecutionPlan`, `EvidenceRequirement`, `VerificationRecord`, `DomainEvent` | P1 |
| [04-platform.md](04-platform.md) | 4 | Electron process architecture, the local API and identity rules, the browser sandbox with separate persistent sessions, the AI layer (one `AiProvider` interface; adapters for Claude CLI, Anthropic API, OpenAI, and Codex CLI proposed; no agent framework in P3), the Policy Engine and confirmations, the MCP server, storage, encrypted backups, building and updating the app from the user's engine, and security | `BrowserSession`, `AiProvider`, `AiAdapterManifest`, `AiTask`, `ConfirmationRequest`, `StandingApproval`, `BackupPolicy` | P0 spikes, P1 |
| [05-connectors.md](05-connectors.md) | 5 | Connector plugins (API and browser), the manifest and capability contracts, runtime API, auth, permissions, bindings, execution, ingest, no-AI enforcement per package kind, testing, the signed index and `connectors.lock`, staged activation and rollback, and the tool question at onboarding | `ConnectorManifest`, `ConnectorModule`, `ConnectorContext`, `ConnectorBinding`, `RegistryIndex`, `ConnectorsLock` | P2 |
| [06-connector-discovery.md](06-connector-discovery.md) | 6 | Finding a missing connector or AI adapter with AI: research of every route and the user's choice, live proof of communication, human-step capture, tools, safety limits (may, must ask, never), secret handling, the build spec, development requests, the review screen, the ticket run and the build handoff | `DiscoveryTools`, `ConnectorSpecReport`, `PathOption`, `CommunicationProof`, `HumanStep`, `DevelopmentRequest`, `SelectorSpec` | P6, P7 |
| [07-agent-friendly-design.md](07-agent-friendly-design.md) | 7 | The `cc-axi` CLI built on the AXI principles, errors and exit codes, agent principals and scopes, firstmate and Grok integration, the MCP tool surface, hooks and the product skill | `Scope`, `AgentPrincipal` | P1, P7 |
| [08-repository-and-automation.md](08-repository-and-automation.md) | 8 | The three repositories (`cc-foundation`, `cc-engine`, `cc-connectors`) and each user's two private copies, stack, layouts, engine extension points, dependency rules, one `AGENTS.md` per repository, scripts and skills for repeatable work, testing, CI and release | (conventions; no runtime types) | P0 |
| [09-build-plan.md](09-build-plan.md) | closing | Build stages, phases P0 to P7, ordered P1 build steps, phase gates, the on-demand connector track, risks | `BuildTask`, `PhaseGate` | n/a |

## 3. Global conventions

### 3.1 Identifiers and references

```ts
/** `<prefix>_<ULID>`. Examples use readable placeholders such as `ws_ald` or `act_a0142`. */
type Id<P extends string> = `${P}_${string}`;
// Prefixes: wsp workspace · per person · ws workstream · fwi framework instance · goal · msr measure
//           dec decision · act action item · iss issue · rsk risk · evd evidence · ser meeting series
//           mtg meeting instance · bnd connector binding · run run · agt agent principal · evt event · sec secret ref
//           req development request

/** Per-workspace counters for people and agents to type: A-0142 (action item), D-0008 (decision),
 *  I-0012 (issue), R-0002 (risk), M-0031 (meeting instance), G-0004 (goal), K-0009 (measure). */
type HumanRef = string;
```

1. The CLI and MCP accept either form. Stored references always use the ID.
2. Binding labels (`gmail-alderwick`) name connector bindings for people and in tool allowlists. Binding IDs (`bnd_gmail_ald`) are what records store ([05 §16](05-connectors.md#16-onboarding-tool-selection-step-s7-and-the-reference-scenario)).
3. All IDs, refs, labels, names and amounts in these documents are **illustrative placeholders**. Fixtures in the code repository use the same placeholders, and never real data.

### 3.2 Time

```ts
type UtcTimestamp = string;   // RFC 3339 in UTC: "2026-11-13T09:30:00Z"
type LocalDate = string;      // "2026-11-13", read in the owning workstream's time zone
type IanaTimeZone = string;   // "Asia/Kolkata"
```

Recurrence uses RFC 5545 RRULEs, evaluated in the series' time zone. The scenario's user works in `Asia/Kolkata` (IST). No workstream in the scenario uses another time zone; the US daylight-saving check ([02 §8.1](02-rhythm-and-calendar.md#81-series-all-times-ist-asiakolkata)) is a product rule the scenario does not exercise.

### 3.3 Actors

```ts
type Actor =
  | { kind: 'user' }                                                // the workspace user, in the app UI only
  | { kind: 'agent'; principalId: Id<'agt'>; runId?: Id<'run'> }    // AI, CLI or MCP caller
  | { kind: 'connector'; bindingId: Id<'bnd'>; runId: Id<'run'> }
  | { kind: 'system'; component: 'rhythm' | 'review' | 'escalation' | 'ingest' | 'scheduler' | 'migration' };
```

Every CLI and MCP call is an `agent` actor, even when a person typed it. Human-only operations (approving confirmations, verifying claims, deciding decisions, accepting and dropping items, confirming meeting read-back, installing connectors, granting scopes, creating browser sessions, starting discovery and choosing its path, activating or rolling back connectors and adapters, granting the ticket-run standing approval, approving, rejecting or deferring development requests, setting the backup passphrase or destination, restoring a backup) happen only in the app UI ([04 §4.3](04-platform.md#43-who-counts-as-the-user)).

### 3.4 Risk classes

```ts
type RiskClass =
  | 'read' | 'write_internal' | 'write_external_draft' | 'write_external'
  | 'send_publish' | 'destructive' | 'credential' | 'financial';
```

Every connector action and every agent tool has one. The Policy Engine turns risk class, settings and approvals into allow, confirm or deny ([04 §7](04-platform.md#7-policy-engine-and-confirmations)). `financial` is never allowed in v1.

### 3.5 Errors

Errors carry `{ code, message, help[] }`. The codes and CLI exit codes (0 success or no-op, 1 error, 2 usage error) are defined once, in [07 §4.4](07-agent-friendly-design.md#44-errors-and-exit-codes).

## 4. The reference scenario

The example user runs two small companies alone, Alderwick and Quillmarsh (both fictional). One CC workspace holds two workstreams, plus the Workspace pseudo-workstream:

| Workstream | Kind | Framework (from [01 §7.2](01-onboarding-and-frameworks.md#72-recommendations)) | Notes |
|---|---|---|---|
| Alderwick | company (solo) | `eos-lite` with client-services, product and marketing packs | Shares the weekly CEO review with Quillmarsh |
| Quillmarsh | company (solo) | `eos-lite` with product and marketing packs | Merged weekly review |

Job search is not part of the reference scenario (owner decision, 12 Nov 2026): it will be a separate incubation app outside this repository, which may later connect to CC through an adapter. The product's job-search features (the `job_search` workstream kind, rules R2 and M4, the job-search packs) stay in the design and the code.

The rhythm ([02 §8](02-rhythm-and-calendar.md#8-reference-scenario-series-and-scorecards)): daily start at 09:00 and shutdown at 17:20 on weekdays, the weekly CEO review on Fridays at 15:00, the monthly review on the last Friday (absorbing that week's review), quarterly planning on the second-to-last Friday of each quarter, and an annual review. Onboarding happens on 2026-11-04. Meetings start in the week of 2026-11-09, and the first weekly review is on 2026-11-13.

Worked examples used across the files:

- **A-0142** Send a revised proposal to a consulting lead (Alderwick). An agent drafts it, the user approves the send, and the sent folder proves it ([03 §13.1](03-decisions-and-action-items.md#131-a-0142-follow-up-to-a-consulting-lead-alderwick-mixed)).
- **A-0160** The weekly Alderwick LinkedIn batch. A recurring template, verified by reading the posts ([03 §13.2](03-decisions-and-action-items.md#132-a-0160-alderwick-linkedin-batch-week-47-recurring-template-mixed)).
- **A-0152** The client contact signs the statement of work. A person performer with an attested result, on an item marked `sensitive` in Alderwick ([03 §13.3](03-decisions-and-action-items.md#133-a-0152-the-client-contact-signs-the-statement-of-work-alderwick-person-performer)).
- **A-0144** Fix the Quillmarsh contact form, delegated to firstmate ([03 §13.4](03-decisions-and-action-items.md#134-a-0144-fix-the-contact-form-on-the-quillmarsh-site-external-agent), [07 §6.3](07-agent-friendly-design.md#63-operating-with-firstmate)).
- **D-0008** Which social scheduler to use from week 3 ([03 §13.5](03-decisions-and-action-items.md#135-d-0008-which-social-scheduler-from-week-3)).
- **Hostinger**, which has no connector, so discovery runs ([06 §9.1](06-connector-discovery.md#91-hostinger-quillmarsh-website-hosting)).

Privacy rules for the scenario: no client names and no name for the client contact appear in these documents or in calendar titles. No workstream in the scenario is `sensitive`; the confidential statement of work A-0152 is a `sensitive` item. Rules R5 (an engagement under a company) and M3 (another person's goal, or a confidential workstream) have no scenario example. All company names, people and figures in the scenario are fictional.

## 5. Key decisions

1. **Local-first, single user.** One Electron app per user. All state is in one SQLite store owned by the core service ([04 §3](04-platform.md#3-process-architecture)). See decision 11 for where answers live and how they are backed up.
2. **One API, three clients.** The UI, `cc-axi` and the MCP relay call the same handlers over a local socket or named pipe. No TCP port is opened ([04 §4](04-platform.md#4-local-api-and-identity)).
3. **People approve; agents propose.** Agents create drafts, claims with evidence and proposals. Only the user, in the UI, approves outward effects, verifies claims and decides ([04 §4.3](04-platform.md#43-who-counts-as-the-user), [04 §7](04-platform.md#7-policy-engine-and-confirmations)).
4. **Fixed backbone, configurable rest.** Each framework has invariants that cannot be removed without forking, and parameters with bounds ([01 §5](01-onboarding-and-frameworks.md#5-framework-catalogue)).
5. **Closed by evidence.** An item closes only as `verified_done` (checked, confirmed or attested) or `dropped` with a reason. Carry-forward and escalation make sure nothing fades ([03 §9](03-decisions-and-action-items.md#9-evidence-and-the-review-loop), [02 §7](02-rhythm-and-calendar.md#7-carry-forward-and-escalation)).
6. **Deterministic connectors, AI in two fenced places with one rule each.** Connectors contain no AI. AI SDK code lives only in adapter packages (`adapters/ai/*` in `cc-connectors`), and orchestration only in the foundation's `packages/orchestrator`, which imports no AI SDK and applies data policies and budgets. The provider is the user's choice at onboarding: Claude CLI, Anthropic API, OpenAI, Codex CLI (proposed, after spike S3b) or none. No agent framework (LangChain or LangGraph) in P3 ([05 §12](05-connectors.md#12-no-ai-in-connectors-enforcement), [04 §6](04-platform.md#6-ai-layer-providers-and-agent-profiles)).
7. **Separate, persistent browser sessions.** One Playwright persistent context per session, with guards on every run ([04 §5](04-platform.md#5-browser-sandbox)).
8. **AXI first for agents.** The CLI is the main agent surface. MCP mirrors it with 14 tools ([07](07-agent-friendly-design.md)).
9. **Works with firstmate without reaching into it.** CC prints handoff briefs and reads the opt-in fleet ledger. firstmate's intake for a connector build is an issue in the user's engine repository that the user approved on CC's review screen, plus the brief the screen prints. CC never writes into a firstmate home ([07 §6](07-agent-friendly-design.md#6-agent-framework-integration)).
10. **Three repositories.** CC is built in new repositories, not in workie: **`cc-foundation`** (the modular core, published as versioned `@cc/*` packages), **`cc-engine`** (the template each user copies; all business customisation, including UI and theme; its AI never changes code), and **`cc-connectors`** (connectors and AI adapters; also the template for a user's own connectors repository). Each user owns a private engine copy and a private connectors copy ([08](08-repository-and-automation.md)).
11. **The local store is the source of truth, backed up regularly.** Onboarding answers and records live in the local store, never in git. Backups are scheduled and encrypted with a user passphrase, kept as 7 daily and 4 weekly archives locally and copied to an off-machine destination the user chooses, with a periodic restore test and a visible "last good backup" status ([04 §9.1](04-platform.md#91-backups), [01 §9.1](01-onboarding-and-frameworks.md#91-where-answers-live)).
12. **Missing connectors: research, choose, prove, review, build.** Discovery researches every route and the user picks one; communication is proven live before a build spec exists; the user approves requests on a review screen; a scheduled run files them in the user's engine repository; firstmate builds them; CC activates them staged, with rollback ([06](06-connector-discovery.md)).
13. **Modular calendar sync.** The rhythm engine talks to any calendar through one `calendar@1` contract; each provider is a connector, and the engine holds only the mapping ([02 §9](02-rhythm-and-calendar.md#9-calendar-integration)).

## 6. Glossary

| Term | Meaning |
|---|---|
| Workspace | One user's CC data: all workstreams, people, records and settings |
| Workstream | A unit of work with its own framework instance: a company, a business unit, a job search, a personal area |
| Framework template / instance | A versioned operating system (meetings, goal model, invariants, parameters) and its configured use in one workstream |
| Backbone | The invariants and meetings of a template that cannot be removed without forking |
| Pack | An add-on with agenda sections, measures and recurring items for a kind of work (marketing, job search) |
| Series / instance | A recurring meeting definition and one occurrence of it |
| Absorption | A higher-cadence meeting taking the place of a lower-cadence one on the same day (the monthly absorbs the weekly) |
| Action item | One deliverable with exactly one owner, a due date and done-means |
| Done-means | What a stranger could check to see the item is done |
| Evidence requirement | What proof an item needs, and optionally a deterministic check |
| Claim / verification | "It is done" with evidence / the review result: auto-checked, confirmed or attested |
| Performer | Who or what executes a step: the user, another person, a connector, an AI agent or an external agent |
| Connector / binding | A plugin that talks to one tool / one configured account of it |
| Browser session | A persistent, isolated browser profile that a browser connector uses |
| Principal | A named agent identity with scopes and a token |
| Confirmation | A single-use, payload-bound approval request shown only in the UI |
| Standing approval | A scoped, revocable pre-approval for a class of actions |
| Discovery | An AI-assisted, supervised session that researches every route to a service, lets the user pick one, proves communication live, and ends in a connector-spec report |
| Foundation (`cc-foundation`) | The upstream repository and `@cc/*` packages that hold the essence of the app |
| Engine (`cc-engine`, *your-engine*) | The template a user copies, and the user's private copy: configuration and customisation only, no code changes by its AI |
| Connectors repository (`cc-connectors`, *your-connectors*) | Connectors and AI adapters, upstream and in the user's private copy |
| `connectors.lock` | The engine file pinning which connector and adapter packages CC may load, by version and sha256 |
| Adapter | A package in a connectors repository that implements `AiProvider` for one AI provider; the only place AI SDK code lives |
| Capability contract | A named interface, such as `calendar@1`, that connectors implement and foundation engines call |
| Path option / path choice | One researched route to a service (API, MCP, existing connector, export, browser, hybrid) / the user's pick among them |
| Communication proof | A host-logged, successful exchange with a service for one needed capability |
| Human step | A step only the user can do (sign-in, CAPTCHA, a code); recorded as a procedure, never a value |
| Development request | A tracked request to build a connector, an adapter or an engine change, reviewed on the review screen |
| Review screen | The human-only screen where the user approves, rejects or defers development requests |
| Last good backup | The newest backup archive that completed, shown with the last restore test |
| Dirty-tree mode | The labelled start from an engine checkout with uncommitted changes or lockfile drift ([04 §10](04-platform.md#10-packaging-updates-and-os-support) rule 4). Named apart from connector developer mode by owner decision, 10 Nov 2026 |
| Connector developer mode | Settings → Developer → Load unpacked connector: a local connector loaded with an "unsigned" badge ([05 §15.5](05-connectors.md#155-connector-developer-mode)) |
| Rebuild now | The in-app rebuild CC offers when the running app is older than the engine checkout the user pulled; it reads the checkout and writes only build output, outside it ([04 §10](04-platform.md#10-packaging-updates-and-os-support) rule 2; owner decisions C1 and Rebuild now, 10 Nov 2026) |
| Workspace pseudo-workstream | The one workstream of kind `workspace` that holds workspace-level risks ([03 §5.2](03-decisions-and-action-items.md#52-workstream); owner decision Q4, 10 Nov 2026) |
| AXI | The agent experience interface principles CC's CLI follows ([07 §4.1](07-agent-friendly-design.md#41-axi-principles-applied)) |
| TOON | Token-Oriented Object Notation, the CLI's output format |
| Fleet ledger | firstmate's opt-in, append-only activity record that CC can read |

## 7. Sources

Internal (workie, read for this design):

- `regime/plan.md`: weekly routine for work, content and mail; protected blocks; the scheduler question.
- `regime/ceo-operating-cadence.md`: meetings, action items and reviews.
- `regime/founder-to-growth.md`: frameworks at each level, and the founder-to-growth transition report.

External (read on 2026-11-04 at pinned revisions, details in [07 §2](07-agent-friendly-design.md#2-sources-read)):

- [kunchenguid/axi](https://github.com/kunchenguid/axi) at `a8a320cc426a5f136a797a5ad138b84cb88bd172`.
- [kunchenguid/firstmate](https://github.com/kunchenguid/firstmate) at `bb8dd209132ef6b0f26395b082cc789de0260738`.
- The installed Claude Code CLI (2.1.318): `claude --help`, to check the flags used by the `claude_cli` provider ([04 §6.3](04-platform.md#63-providers-and-adapter-rules)).

Board review of the architecture (6 Nov 2026, rounds 2 and 3, and the board comments on path choice, live proof, the review screen, backups and calendar sync), with external facts read on 2026-11-06:

- GitHub documentation: repositories created from a template, fork visibility, scheduled-workflow rules, fine-grained token permissions for issues and labels, and artifact attestations (plan availability for private repositories not settled; OQ-05-07).
- Codex CLI 0.167.0 (`codex --help`, `codex exec --help`, `codex mcp --help`, `codex features list`, a logged-out `codex exec` run), the `openai/codex` config schema at `55897425e839d943a744c658701445ff732568a0`, and the non-interactive mode and config reference pages ([04 §6.3](04-platform.md#63-providers-and-adapter-rules)).
- LangGraph.js documentation (persistence, interrupts, memory, observability) and npm registry data for the LangChain packages ([04 §6.7](04-platform.md#67-orchestration-framework-no-langchain-or-langgraph-in-p3)).

Not re-verified for this design, and flagged where used: Buffer's API (OQ-05-06), and Grok's own hook documentation (OQ-07-01). The 4DX facts were checked against FranklinCovey's own pages on 11 Nov 2026 ([01 §5.2](01-onboarding-and-frameworks.md#52-4dx-v1-ships-in-p1); OQ-01-04, closed).

## 8. Cross-cutting open questions

1. **OQ-X-01** Solo or with leads? `regime/plan.md` says the user works mostly alone, while `regime/ceo-operating-cadence.md` assumes a few leads. That choice changes the meeting modes, the owners and the P1 scope (OQ-01-01, OQ-09-04). *Default: solo.*
2. **OQ-X-02** The job-search workstream of the earlier scenario. *Closed (owner decision, 12 Nov 2026): job search left the reference scenario; it will be a separate incubation app outside this repository, which may later connect to CC through an adapter.*
3. **OQ-X-03** A client contact's data: what the client contact agrees to, and retention of sensitive items when the client work ends (OQ-03-03). *Needs the user's answer, and the client's agreement, before CC binds any mailbox beyond `gmail-alderwick` to client work (the `gmail` connector-track item, [09 §13](09-build-plan.md#13-connector-track-on-demand)).*
4. **OQ-X-04** Names: "Command Center" as the product name, the `commandcenter://` URL scheme and the `cc-axi` binary (OQ-07-02) may clash with existing products. *Default: keep them as working names; check before the first public release.*
5. **OQ-X-05** Where these documents live once the code repositories exist (OQ-08-02). *Default: move them to `cc-foundation/docs/design/` at P0. The engine template gets a user guide in its README.*
