# 08 · Repositories and repeatable work

- **Purpose:** Defines the Command Center (CC) code repositories: three upstream repositories (`cc-foundation`, `cc-engine`, `cc-connectors`) and the two private copies each user owns, the stack, the layouts, the dependency rules that keep the architecture honest, the instructions for AI developers and for the engine's own AI, and repeatable work packaged as scripts (mechanics) and skills (judgement), plus CI and release.
- **Depends on:** [04](04-platform.md) (processes, storage, building and updating the app §10). [05](05-connectors.md) (connector package layout §4, testing contract §13, the index and `connectors.lock` §15). [07](07-agent-friendly-design.md) (`cc-axi`, generated skill, AXI conformance, firstmate projects).
- **Related files:** [01](01-onboarding-and-frameworks.md) (framework template and pack files, the engine customisation level §9). [02 §9.6](02-rhythm-and-calendar.md#96-calendar-mapping-the-engines-choice-no-provider-code) (the calendar mapping in the engine's `cc.config`). [03](03-decisions-and-action-items.md) (schemas, migrations, export). [06](06-connector-discovery.md) (`cc:new-connector --from-spec`, discovery rule fixtures, the ticket run and include PRs). [09](09-build-plan.md) (P0 creates `cc-foundation`, P1 creates `cc-engine` and the owner's *your-engine*, P2 creates `cc-connectors`; each phase adds scripts).

## 1. Summary

1. CC is built in **three new repositories**, not in workie. workie stays the user's personal workspace. It holds private material (such as `regime/`), and none of it is copied into any CC repository.
   - **`cc-foundation`**: the essence of the app, modular. A pnpm-workspace TypeScript monorepo of focused packages, published as versioned `@cc/*` packages released in lockstep: schemas, store, domain, frameworks, rhythm, policy, core, the connector SDK and host, the browser host, the orchestrator (profiles, data policy, budgets, the tool loop; no AI SDK), the UI kit with extension slots and theme tokens, the desktop shell, `cc-axi` and the MCP relay, and the build tooling.
   - **`cc-engine`**: the template a user copies, and the only repository a user clones to set up their own CC. It holds no foundation code: exact pins of the `@cc/*` packages, and all business customisation (configuration, theme, UI widgets in declared slots, framework and pack files, the calendar mapping, `connectors.lock`). Its `AGENTS.md` forbids the engine's own AI from changing code. When the app first starts, it asks the onboarding questions ([01 §3](01-onboarding-and-frameworks.md#3-onboarding-flow)).
   - **`cc-connectors`**: connectors (no AI) and AI adapters (the only AI SDK code), the signed index, and the connector templates. It doubles as the template for a user's own connectors repository.
2. **Each user owns two private copies:** *your-engine* (from the `cc-engine` template) and *your-connectors* (from the `cc-connectors` template). Copies are made with GitHub's "Use this template", never as forks: a fork of a public repository is public and cannot be made private by itself, and a template copy starts with a single commit and unrelated history.
3. Architecture rules from [04](04-platform.md) and [05](05-connectors.md) are enforced mechanically, by dependency rules in each repository's CI: AI SDK code only in adapter packages, and none in the foundation; connectors import only the connector SDK; domain packages are pure; engine code reaches the app only through extension points.
4. Repeatable work follows firstmate's split ("Logic that can be exact lives in deterministic scripts; work that requires understanding lives in an agent", [07 §2](07-agent-friendly-design.md#2-sources-read)). Scripts (`pnpm cc:*`) do the exact parts. Development skills (`.agents/skills/`) guide an AI developer through the judgement parts and call the scripts.
5. Everything that can be generated is generated from `packages/schemas` in the foundation: JSON Schemas, MCP and AI tool definitions, the CLI reference and the product skill. CI fails on drift.
6. Every acceptance criterion in `docs/design` is traced to tests by ID.

## 2. Scope and non-goals

1. In scope: the repository design, the conventions and the automation for building CC with AI developers, and for running a user's own copy.
2. Not in scope: creating the repositories. This document is a design only; [09](09-build-plan.md) creates them in build order: `cc-foundation` in P0, `cc-engine` in P1 (P1-18), `cc-connectors` in P2 (P2-12).

## 3. Stack

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript, `strict`, ES modules | One language across app, CLI, connectors, adapters and scripts |
| Runtime | Electron (main, renderer, `utilityProcess`) and Node LTS for the CLI and headless core | Versions pinned in P0; Electron upgrades are their own PRs |
| Workspace | pnpm workspaces, frozen lockfile in CI | `pnpm -r` runs package scripts in dependency order |
| Packages | `@cc/*` foundation packages, released in lockstep at one version; the engine pins them exactly | The package registry is OQ-08-07 |
| UI | React with Vite in the renderer; engine widgets through `@cc/ui-sdk` | No remote content ([04 §10](04-platform.md#10-packaging-updates-and-os-support)) |
| Schemas | zod 4, JSON Schema generated with `z.toJSONSchema()` | One source for API validation, MCP tools, AI tools and record files ([04 §4.1](04-platform.md#41-endpoint-and-protocol)) |
| Database | SQLite (WAL) through `better-sqlite3`, rebuilt for Electron | FTS5 for search ([03 §12](03-decisions-and-action-items.md#12-persistence)); OQ-08-06 |
| Dates and recurrence | `temporal-polyfill` (one Temporal per process, imported from `@cc/schemas`) and `rrule-temporal` in floating mode (only in `packages/rhythm`), both pinned exactly ([ADR 0001](../adr/0001-recurrence-and-time-zone-libraries.md)) | Recurrence fixtures from [02 §8.1](02-rhythm-and-calendar.md#81-series-all-times-ist-asiakolkata) decided the choice; they run as `packages/rhythm` fixture tests under three host time zones |
| CLI | `axi-sdk-js` (`runAxiCli()`, `tryFastPath()` from `axi-sdk-js/fast-path`, `installSessionStartHooks()`) | [07 §4](07-agent-friendly-design.md#4-cc-axi-the-axi-command-line) |
| MCP | `@modelcontextprotocol/sdk` (TypeScript), stdio server in the relay | [04 §8](04-platform.md#8-mcp-server) |
| Browser | `playwright` library, persistent contexts, pinned Chromium | [04 §5](04-platform.md#5-browser-sandbox) |
| AI | `@anthropic-ai/sdk`, `openai`, and the `claude` CLI (and `codex` CLI, proposed) as child processes | Only in `cc-connectors/adapters/ai/*` (rule D1). No agent framework in P3 ([04 §6.7](04-platform.md#67-orchestration-framework-no-langchain-or-langgraph-in-p3)) |
| Tests | Vitest (unit, integration, fixtures); Playwright's Electron support for UI end-to-end | §8 |
| Lint and boundaries | ESLint, Prettier, dependency-cruiser | §4.2 |
| Packaging | electron-builder inside `@cc/build`, run by the user's engine build | [04 §10](04-platform.md#10-packaging-updates-and-os-support) |
| Supply chain | Locked dependencies, `pnpm audit` and an OSV scan in CI, a secret scanner (gitleaks), Renovate or Dependabot PRs reviewed by a human | [04 §11](04-platform.md#11-security-model) |

## 4. Repository layout

### 4.1 Tree

**`cc-foundation`** (upstream; maintainers' work):

```text
cc-foundation/
  AGENTS.md                         # instructions for AI developers (§5.1)
  CLAUDE.md                         # one line: @AGENTS.md
  README.md                         # what CC is, development quick start
  package.json                      # root scripts: dev, test, lint, typecheck, e2e, cc:*
  pnpm-workspace.yaml
  tsconfig.base.json
  .dependency-cruiser.cjs           # rules D1-D7 (§4.2)
  .github/workflows/                # ci.yml, release.yml, nightly.yml (§9)
  apps/
    desktop/                        # @cc/desktop: Electron shell
      src/main/                     # windows, tray, deep links, notifications, idle restart, process supervision
      src/preload/                  # contextBridge: window.cc.invoke(method, params)
      src/renderer/                 # React UI (the screens listed in 09's P1 build steps) with extension slots
      src/core-host/                # the core's utilityProcess entry: starts @cc/core, serves the UI port
      src/shared/                   # the main <-> core-host message types
    cli/                            # cc-axi: commands, TOON views, MCP stdio relay, hook installer
      src/version.ts                # leaf module for the --version fast path
  packages/
    schemas/                        # zod types for records (03), API methods (04 §4), MCP tools (07 §7), config (§4.3)
      records/<type>@<major>.json   # generated JSON Schemas
    store/                          # SQLite, repository layer, event log, FTS, backups and restore tests (04 §9.1)
      migrations/NNNN_name.sql      # forward-only (03 §12)
    domain/                         # lifecycle, invariants, health, review loop, metrics (pure)
    frameworks/                     # recommend(), templates, packs, validators (pure)
      templates/<id>/<version>.yaml
      packs/<id>/<version>.yaml
      validators/
      test/recommend.test.ts
    rhythm/                         # RRULE expansion, instance state machine, absorption, placement,
                                    # carry-forward, escalation, reconciliation over calendar@1, .ics export (pure)
    policy/                         # Policy Engine, risk classes, confirmations, standing approvals (pure)
    core/                           # core service: wires the packages above, local API server,
                                    # schedulers, Connector Host supervisor, lock loader, headless mode
    connector-sdk/                  # ConnectorModule, ConnectorContext, record types, capability contracts (calendar@1)
    connector-host/                 # connector runs in utilityProcess, ScopedHttp, auth injection, cursors
    browser-host/                   # Playwright contexts, guards G1-G8, GuardedPage, needs-you,
      discovery-rules.ts            # click classification K1-K8 (06 §6.2)
    orchestrator/                   # AiProvider interface, adapter loading, agent profiles, data policy,
                                    # budgets, the tool loop; imports no AI SDK (rule D1)
      profiles/<id>.md              # versioned profile prompts (04 §6.4)
    registry-client/                # index fetch, signature checks, lock verification, install, update, rollback
    ui-sdk/                         # @cc/ui-sdk: slots, theme tokens and schema types for engine widgets
    build/                          # @cc/build: electron-builder config, fuses, hardening, theme compile; the engine's
                                    # cc-build, cc-start, cc-install-stamp and cc-upgrade commands (a development dependency)
    build-runtime/                  # @cc/build-runtime: build and install stamps, clean-tree check, Rebuild now, idle restart;
                                    # no dependencies, so @cc/desktop imports it and the app never carries the build tooling
    test-kit/                       # fake clock, fixture HTTP server, fake calendar services, canaries, scenario seeder
  templates/
    framework-template/             # scaffold for cc:new-template
  fixtures/
    onboarding/scenario.json        # the reference scenario (01 §7.1)
    onboarding/sample-profile.md    # the scenario's answers as an essay: input for the P3 extractor (01 §3.2)
    onboarding/sample-profile.json  # the same answers as an OnboardingProfile for apply --file (01 §3.2)
    records/<type>@<major>/         # one record per file, validated by cc:gen against its schema
    scenario/                       # seeded workspace: series, items A-0142 etc., measures
    ledger/                         # firstmate fleet-ledger fixtures (07 AC-07-04)
    discovery/                      # synthetic vendor pages for 06's acceptance criteria
    repos/                          # fixture engine and connectors repositories for the P7 end-to-end loop
  skills/
    command-center/SKILL.md         # generated product skill for users' agents (07 §8)
  .agents/skills/                   # development skills for AI developers (§7)
  scripts/                          # implementations of the pnpm cc:* scripts (§6)
  docs/
    design/                         # these documents (OQ-08-02)
    adr/NNNN-title.md               # architecture decision records, including P0 spike results
    runbooks/                       # release, key rotation, incident response
```

**`cc-engine`** (the template; each user's *your-engine* is a private copy of it):

```text
cc-engine/
  AGENTS.md                         # the engine's AI never changes code (§5.2)
  CLAUDE.md                         # one line: @AGENTS.md
  README.md                         # user guide: clone, install, build, run, update
  package.json                      # exact pins of @cc/* and the build, start, test and cc:* scripts
  pnpm-lock.yaml
  cc.config.ts                      # validated by @cc/schemas: modules on or off, vocabulary, calendars (02 §9.6)
  theme/tokens.json                 # theme tokens
  ui/                               # widgets in declared slots, built with @cc/ui-sdk only (rule D3)
  frameworks/                       # custom: templates (01 §9)
  packs/                            # custom packs
  connectors.lock                   # the connector and adapter packages this CC may load (05 §15.6)
  profile.json                      # optional: exported, non-sensitive onboarding answers (01 §9.1)
  .claude/settings.json             # harness deny rules for edits and shell (spike S9)
  .codex/config.toml                # read-only sandbox for Codex in this repository (spike S9)
  .github/
    CODEOWNERS                      # the user owns everything
    ISSUE_TEMPLATE/connector-request.md   # used by the ticket run (06 §11.2)
    workflows/ci.yml                # build and test the user's app; path guard (§9)
    renovate.json                   # or dependabot.yml: @cc/* update PRs
```

**`cc-connectors`** (upstream; each user's *your-connectors* is a private copy of it):

```text
cc-connectors/
  AGENTS.md                         # agents may build connectors from specs; never weaken a check (§5.3)
  CLAUDE.md
  connectors/<id>/                  # each laid out as in 05 §4: google-calendar, microsoft-calendar, caldav-calendar,
                                    # gmail, google-drive, s3, github, linkedin, whatsapp-web, wordpress, toggl-track ...
  adapters/ai/<id>/                 # anthropic_api, openai, claude_cli, codex_cli (proposed); adapter.json, README contract
  templates/
    connector-api/  connector-browser/  adapter-api/  adapter-cli/   # scaffolds for cc:new-connector and cc:new-adapter
  index/                            # the signed index, built and signed only by the protected release job
  fixtures/                         # recorded HTTP exchanges, saved HTML, provider transcripts
  .github/workflows/                # ci.yml, release.yml, nightly.yml (§9)
```

The signed index lives in `cc-connectors` (it replaces a separate `command-center-registry` repository). Its protected release job builds and signs the index, and signing keys never reach PR workflows (C-08-06, OQ-08-04).

### 4.2 Dependency rules (dependency-cruiser and ESLint, enforced in CI)

| Rule | Statement | Why |
|---|---|---|
| D1 | **AI boundary, both sides.** In `cc-foundation`, no package imports an AI SDK (`@anthropic-ai/sdk`, `openai` and the §12 denylist of [05](05-connectors.md#12-no-ai-in-connectors-enforcement)) or starts an AI CLI (`claude`, `codex`); `packages/orchestrator` loads adapters through `AiProvider`. A test also searches the built output for spawns of `claude` or `codex`. In `cc-connectors` and user connectors repositories, only `adapters/ai/*` may do either | [04 §6.1](04-platform.md#61-boundary) |
| D2 | `connectors/*` (in `cc-connectors` and user connectors repositories) may import only `@cc/connector-sdk` and an allowlist of pure libraries. They may not import Node built-ins for network, files or processes, any AI SDK, or anything under `adapters/`. Adapters may not import `@cc/connector-sdk` | [05 §12](05-connectors.md#12-no-ai-in-connectors-enforcement); the host supplies HTTP and the browser |
| D3 | `apps/desktop/src/renderer` and the engine's `ui/` import only `@cc/ui-sdk`, `packages/schemas` types and UI libraries. No Node built-ins, no network and no internal runtime packages | [04 §3](04-platform.md#3-process-architecture) rules 1 and 3 |
| D4 | `domain`, `frameworks`, `rhythm` and `policy` are pure: no I/O, no clock and no randomness. The clock, ID generator and stores are passed in. `rhythm` reaches calendars only through the `calendar@1` contract | Deterministic tests; "the two never mix"; [02](02-rhythm-and-calendar.md) C-02-09 |
| D5 | Only `packages/core` imports `packages/store`. | One writer, one transaction per command ([03 §12](03-decisions-and-action-items.md#12-persistence)) |
| D6 | `packages/schemas` imports nothing internal. | No cycles; generation stays simple |
| D7 | Headless mode (`cc-axi serve --headless`) and the test keyring are excluded from production builds, and refuse to start when `NODE_ENV=production`. | [04 §3](04-platform.md#3-process-architecture) rule 2 |

### 4.3 Engine extension points

The engine customises CC only through these, each validated by the foundation (C-08-08):

1. **`cc.config.ts`**: a typed object checked against `@cc/schemas` at build and at start: modules on or off, vocabulary, default framework parameters, the calendar mapping ([02 §9.6](02-rhythm-and-calendar.md#96-calendar-mapping-the-engines-choice-no-provider-code)).
2. **Theme tokens** in `theme/tokens.json`.
3. **UI slots**: widgets in `ui/`, registered for slots the foundation declares, built with `@cc/ui-sdk` (rule D3).
4. **Framework and pack files** in `frameworks/` and `packs/`, validated by the foundation's validators ([01 §9](01-onboarding-and-frameworks.md#9-customisation-and-forking), C-01-03).
5. **`connectors.lock`** ([05 §15.6](05-connectors.md#156-connectorslock-and-the-users-own-connectors)).

The foundation supports extension API N and N−1, so an engine keeps building across one foundation major; `pnpm cc:upgrade` applies codemods for template changes (spike S6). The user runs it locally, pulls merged foundation updates into the engine checkout themselves, and CC offers Rebuild now when the running build is older than the checkout ([04 §10](04-platform.md#10-packaging-updates-and-os-support) rule 2; owner decisions D-1 and C1, 10 Nov 2026). The theme tokens are colours, fonts, radius and density only. The layout is fixed by the foundation, and engine widgets appear only in the slots it declares (owner decision Q9, 10 Nov 2026).

## 5. AGENTS.md for each repository

Each repository has its own `AGENTS.md`, written for any coding agent: Claude Code (through `CLAUDE.md`'s import), Codex, OpenCode, Grok, and firstmate crewmates.

### 5.1 `cc-foundation`

The skeleton the P0 repository starts with:

```markdown
# Command Center foundation: agent instructions

Command Center is a local-first Electron app that runs a company's operating rhythm
(meetings, decisions, action items) and gets every decision and action item carried out
and verified. This repository is its foundation, published as @cc/* packages that users'
engine repositories pin. The design is in docs/design/; it is the specification.

## Commands
- pnpm install            install (frozen lockfile in CI)
- pnpm dev                run the app with a throwaway profile (--profile-dir under /tmp)
- pnpm test               unit, integration and fixture tests (offline)
- pnpm lint               ESLint, Prettier check, dependency rules D1-D7
- pnpm typecheck          tsc --noEmit across the workspace
- pnpm e2e                headless-core scenario tests; pnpm e2e:app for the Electron UI
- pnpm cc:gen [--check]   regenerate schemas, tool definitions, CLI reference and skill
- pnpm cc:doctor          check the toolchain and local limits

## Rules
1. The design docs are the spec. If code and docs disagree, say so in the PR and update
   the doc in the same PR. Cite contract and acceptance IDs (C-03-02, AC-02-05).
2. Name tests after the acceptance criteria they prove: it('AC-02-05 carry count ...').
3. No AI SDK and no AI CLI in this repository: AI code lives only in cc-connectors
   adapters/ai/*. Connectors contain no AI. The lint rules enforce this; never disable them.
4. Human-only operations (04 §4.3) are never reachable from the CLI, MCP or AI code.
   Never add a flag, tool or test hook that bypasses a confirmation.
5. Never use real personal data. Fixtures are synthetic: no real names, client names,
   emails, phone numbers or tokens. The secret scan and the canary denylist enforce this.
6. Generated files are never edited by hand. Change packages/schemas, then pnpm cc:gen.
7. Migrations are forward-only. Create them with pnpm cc:new-migration <name>.
8. Tests are hermetic and worktree-safe: a temp profile directory per test, no fixed
   paths, no listening TCP ports except fixture servers on 127.0.0.1 inside the test.
9. Live connector tests (--live) run only by a human on a real machine. Never in CI.
10. Use the scripts for mechanics (pnpm cc:*) and the skills in .agents/skills for
    judgement-heavy tasks. Do not hand-roll what a script does.
11. Use gh-axi for GitHub and chrome-devtools-axi for browser work.
12. Conventional commits. Never add an agent name as a commit co-author, and no
    "generated by" lines in commits or PRs.
13. Extension points (08 §4.3) keep API N-1 working; a breaking change ships a codemod.

## Layout
apps/desktop, apps/cli, packages/*, templates/*, fixtures/*, skills/, scripts/,
docs/design, docs/adr. See docs/design/08-repository-and-automation.md.
```

Rule 11 and rule 12 follow firstmate's `AGENTS.md`: "Use `gh-axi` for GitHub, `chrome-devtools-axi` for browser work" and "Never add an agent name as a commit co-author" ([07 §2](07-agent-friendly-design.md#2-sources-read)).

### 5.2 `cc-engine` (and each *your-engine*)

```markdown
# Your Command Center engine: agent instructions

This repository configures one person's Command Center. It holds configuration, theme,
UI widgets, framework and pack files and connectors.lock, and pins the @cc/* foundation.

## Rules
1. The engine's AI never changes code. You may read files, run cc-axi, and propose
   changes through Command Center (cc-axi requests propose). You do not edit, create or
   delete files here, run build scripts that write, commit, or push.
2. connectors.lock changes only through an include PR made with pnpm cc:include by the
   firstmate project for this repository; CI's path guard rejects anything else in it.
3. Never put records, secrets, client names or personal data in this repository.
4. Use gh-axi for GitHub. Never add an agent name as a commit co-author.
```

`AGENTS.md` is advice that a model may ignore, so the rule is enforced in software as well ([04 §11](04-platform.md#11-security-model)):

1. **Capability.** The in-app AI has no file or shell tools: CLI adapters run with built-in tools off in an empty run directory outside the repository, and API adapters get only CC's tool definitions ([04 §6.3](04-platform.md#63-providers-and-adapter-rules), [07 §7](07-agent-friendly-design.md#7-mcp-server-surface)).
2. **Credential.** CC's GitHub token has Issues read and write and no Contents access, so it cannot push.
3. **Repository.** `main` is protected, the user is the CODEOWNER, and the path guard limits include PRs to `connectors.lock` (§9).
4. **Runtime.** CC starts normally only from a clean tree that matches the lockfiles; a dirty tree runs in labelled dirty-tree mode ([04 §10](04-platform.md#10-packaging-updates-and-os-support) rule 4), which is not connector developer mode ([05 §15.5](05-connectors.md#155-connector-developer-mode)). CC itself never writes the checkout: the user pulls merged updates, and Rebuild now writes only build output outside the checkout ([04 §10](04-platform.md#10-packaging-updates-and-os-support) rule 2, owner decisions C1 and Rebuild now, 10 Nov 2026; C-01-09).
5. **Harness.** The engine ships `.claude/settings.json` deny rules for edits and shell, and a read-only Codex sandbox configuration. The exact syntax is confirmed in spike S9 (P0-13).

### 5.3 `cc-connectors` (and each *your-connectors*)

```markdown
# Command Center connectors and adapters: agent instructions

Connectors (connectors/*) are deterministic plugins with no AI. AI adapters
(adapters/ai/*) are the only place AI SDKs or AI CLIs may appear.

## Rules
1. Agents may build connectors and adapters from a ConnectorSpecReport or an approved
   development request; the first tests replay the spec's proven exchanges.
2. Never weaken a check: the no-AI rules per package kind (05 §12), the guards, the
   fixture hygiene scan, the testing contract (05 §13).
3. Fixtures are synthetic or sanitised. Live tests (--live) only by a human.
4. Release only through the release workflow; never sign or publish by hand.
5. Use gh-axi for GitHub. Conventional commits; no agent co-author lines.
```

## 6. Scripts (deterministic, repeatable mechanics)

All scripts live in `scripts/` of the repository named in the table, run with `pnpm cc:<name>`, print a short summary, never prompt, and exit 0 (success or no-op), 1 (failure) or 2 (usage error), like `cc-axi` ([07 §4.4](07-agent-friendly-design.md#44-errors-and-exit-codes)). The engine's scripts come from `@cc/build`, so the engine holds no script code: one bin per script, `cc-build` (`build`, and `cc-build check`), `cc-start` (`start`), `cc-install-stamp` (`postinstall`) and `cc-upgrade` (`cc:upgrade`) (`packages/build/README.md`).

| Script | Repository | What it does | Phase | Specified in |
|---|---|---|---|---|
| `cc:doctor [--profile-dir <dir>]` | all | Checks Node, pnpm, the Electron native rebuild, Playwright's Chromium and, if present, `claude --version` and `codex --version`. Warns when a socket path would exceed the UNIX limit (104 bytes on macOS, 108 on Linux): the default profile's, the test profiles' and the `--profile-dir` one's. A missing optional tool (an AI CLI, or Electron and Playwright before the phase that adds them) warns and does not fail | P0 | §8 |
| `cc:gen [--check]` | foundation | From `packages/schemas`: record JSON Schemas, API method schemas, the `cc.config` schema, MCP tool definitions (and the 12 KB budget check), AI tool definitions, the CLI reference, `skills/command-center/SKILL.md`. Validates all fixtures, including [03 §13](03-decisions-and-action-items.md#13-worked-examples-reference-scenario); record fixtures live in `fixtures/records/<type>@<major>/`. `--check` fails on any drift: a generated file changed, missing or added by hand | P0 | [07 §8](07-agent-friendly-design.md#8-ambient-context-hooks-and-skill), AC-03-06 |
| `cc:trace [--phase <P>] [--repo <dir>]` | foundation | Extracts every contract and acceptance ID from `docs/design/*.md` and the test names that cite them (test files, and CI step names in `.github/workflows/`), across the three repositories: `--repo` adds a `cc-engine` or `cc-connectors` checkout. It lists every ID with its covering tests, marks uncovered IDs, and fails for phases and connector-track items marked done in `docs/design/09-build-plan.md` ([09 §2](09-build-plan.md#2-planning-rules) rule 8). `--phase` checks one gate, done or not, except its `manual:` criteria | P0 | C-08-07 |
| `cc:new-migration <name>` | foundation | Creates `packages/store/migrations/NNNN_<name>.sql` with the next number and a fixture-upgrade test stub. CI also checks that existing migration files are unchanged (hash list) | P1 | [03 §12](03-decisions-and-action-items.md#12-persistence) |
| `cc:seed --scenario reference --profile-dir <dir> [--today <date>]` | foundation | Seeds the reference scenario into a headless core with a fake clock: workspace, workstreams, framework instances, series and the worked-example items | P1 | [01 §7](01-onboarding-and-frameworks.md#7-reference-scenario-walk-through), [02 §8](02-rhythm-and-calendar.md#8-reference-scenario-series-and-scorecards) |
| `cc:new-template --id <id> [--from <id>@<version>] [--pack]` | foundation | Scaffolds a framework template or pack YAML, validator stubs and recommender test cases | P1 | [01 §4](01-onboarding-and-frameworks.md#4-types), [01 §9](01-onboarding-and-frameworks.md#9-customisation-and-forking) |
| `cc:axi-conformance` | foundation | The AXI suite over every `cc-axi` command (AC-07-01, AC-07-02) | P1 | [07 §4.1](07-agent-friendly-design.md#41-axi-principles-applied) |
| `cc:release --channel beta\|stable [--dry-run]`, `cc:release --tag` | foundation | On a release branch, `--channel` bumps every `@cc/*` package to one version, writes the changelog and commits; after the release PR merges, `--tag` on `main` checks the versions and changelog and creates the tag locally. The owner pushes the tag; CI publishes the packages (`release.yml`, which runs `--verify-tag` first). Two steps because `main` is protected (§9 rule 1) | P1 | §9 |
| `cc:engine-template pack --out <dir>`, `cc:engine-template pin --engine <dir> --tarballs <dir>` | foundation | `pack` runs `pnpm pack` on every `@cc/*` package; `pin` pins those tarballs into a scratch copy of the `cc-engine` template the way the template's "Pinning the foundation" steps describe a release PR (`@cc/desktop` and `@cc/build`, `overrides` for the rest, `allowBuilds`, the build flags). CI's engine-template job uses it to install, build and start a fresh template copy on the current packages, without a registry | P1 | §9, AC-08-11 |
| `cc:upgrade [--to <version>] [--check]` | engine | Runs the foundation's codemods for template changes between the pinned and the target version, then type-checks. The user runs it locally; `--check` writes nothing and lists the planned edits, for the engine's CI on dependency PRs (owner decision D-1, 10 Nov 2026). Exits 1 when `--check` finds an upgrade due, when a site is left marked for a person, or when the type-check fails ([ADR 0003](../adr/0003-engine-extension-api.md) decision 6) | P1 | §4.3 |
| `cc:include <id>@<version>` | engine | Adds or updates one `connectors.lock` entry from a release (sha256, permissions digest, source). Run by firstmate for include PRs | P5 | [05 §15.6](05-connectors.md#156-connectorslock-and-the-users-own-connectors) |
| `cc:path-guard` | engine | In CI: a PR labelled `connector-include` may change only `connectors.lock`; fails otherwise | P1 | C-08-09 |
| `cc:new-connector --id <id> --kind api\|browser [--from-spec <spec.json>]` | connectors | Scaffolds `connectors/<id>/` from `templates/connector-<kind>`. With `--from-spec`, fills the manifest from `manifestDraft`, adds handler stubs per action, fixture placeholders and one failing test per capability, with the spec's proven exchanges as the first live checks | P2 (spec input P6) | [05 §4](05-connectors.md#4-package-layout), [06 §11](06-connector-discovery.md#11-handoff-to-build) |
| `cc:new-adapter --id <id> --kind api\|cli` | connectors | Scaffolds `adapters/ai/<id>/` with `adapter.json`, the README contract skeleton and recorded-transcript tests | P3 | [04 §6.3](04-platform.md#63-providers-and-adapter-rules) |
| `cc:test-connector <id> [--live --binding <label>]` | connectors | The testing contract of [05 §13](05-connectors.md#13-testing-contract), including the per-kind no-AI checks and, for `implements`, the contract suite (AC-02-10). `--live` is refused when `CI=true` | P2 | [05 §13](05-connectors.md#13-testing-contract) |
| `cc:test-provider <provider> [--live]` | connectors | Runs a provider adapter against recorded transcripts: streaming, tool calls, structured output, refusals, budgets. `--live` uses the developer's own credentials | P3 | [04 §6.3](04-platform.md#63-providers-and-adapter-rules) |
| `cc:registry build\|verify` | connectors | Builds the index, computes `sha256` and `permissionsDigest`, and verifies signatures. Signing runs only in the protected release job | P5 | [05 §15](05-connectors.md#15-plugin-repository) |

## 7. Skills (repeatable work that needs judgement)

Development skills live in `.agents/skills/<name>/SKILL.md` of the repository they serve, with a trigger-shaped `description` in the frontmatter. Each lists its inputs, the scripts it calls, the decisions the agent must make, and when it is done. Skills never re-implement a script. The engine has no development skills: its AI does not develop.

| Skill | Repository | Use when | Calls | Done when |
|---|---|---|---|---|
| `cc-implement-step` | foundation | Implementing one build step from [09](09-build-plan.md) | `cc:trace`, `cc:gen`, tests | The step's acceptance IDs have passing tests, and the docs match the code |
| `cc-add-connector` | connectors | Building a connector from vendor docs, a `ConnectorSpecReport`, or an approved development request (an issue labelled `cc:approved`) | `cc:new-connector`, `cc:test-connector` | Fixture tests pass, the spec's proven exchanges replay as tests, README lists "what it never does", every action has a risk class |
| `cc-add-adapter` | connectors | Building or updating an AI adapter, for example `codex_cli` after spike S3b | `cc:new-adapter`, `cc:test-provider` | The adapter meets the rules of [04 §6.3](04-platform.md#63-providers-and-adapter-rules); its README states `dataSent` and the tested version range |
| `cc-port-browser-extractor` | connectors | Porting readers from an existing browser automation into a connector, or fixing a broken browser connector after a vendor release | `cc:test-connector` | Fixtures are sanitised, `selectorsVersion` is bumped, and no guard is weakened |
| `cc-change-schema` | foundation | Changing a record or API type | `cc:new-migration`, `cc:gen` | A migration exists if storage changed; a breaking change bumps the major version; fixtures validate |
| `cc-add-framework-template` | foundation | Adding or changing a framework template or pack | `cc:new-template`, recommender tests | Invariants and bounds are cited to a source; the scenario's recommendations are unchanged unless the change intends it |
| `cc-add-cli-command` | foundation | Adding a `cc-axi` command or MCP tool | `cc:gen`, `cc:axi-conformance` | The AXI checklist in [07 §4.1](07-agent-friendly-design.md#41-axi-principles-applied) holds; no human-only path is exposed |
| `cc-change-extension-api` | foundation | Changing a slot, theme token, config field or the lock format | `cc:gen`, codemod tests | API N−1 still builds against the fixture engine, or a codemod upgrades it |
| `cc-review-connector-pr` | connectors | Reviewing a third-party connector, or a connector firstmate built for a user | `cc:test-connector` | The permission diff, flags, the no-AI checks and fixture sanitisation are reviewed and noted in the PR |
| `cc-include-connector` | engine (firstmate's project for it) | Including a released connector or adapter in a user's engine | `cc:include` | The include PR changes only `connectors.lock` and links the request's issue |
| `cc-spike-report` | foundation | Running a P0 spike, or any scout task | none | An ADR in `docs/adr/` with question, method, result, decision and evidence |

The product skill `skills/command-center/SKILL.md` is different: it is generated for users' agents, and is not a development skill ([07 §8](07-agent-friendly-design.md#8-ambient-context-hooks-and-skill)).

## 8. Testing strategy

1. **Unit tests** cover the pure packages, table-driven where the design has tables: the recommender rules R1 to R9 and modifiers M1 to M8, lifecycle transitions, escalation levels E0 to E4, click classes K1 to K8, and policy evaluation order.
2. **Fixture tests:** connectors against recorded HTTP exchanges or saved HTML; providers against recorded transcripts; calendar connectors against fake calendar services with the provider-neutral suite (AC-02-10); discovery against synthetic vendor pages; the fleet-ledger reader against `fixtures/ledger/`.
3. **Scenario tests:** `cc:seed` seeds the reference scenario with `today = 2026-11-04`, then a fake clock advances through weeks 1 to 4. That covers the first weekly review on 2026-11-13, the monthly absorption on 2026-11-27 and carry-forward. Most acceptance criteria in 01, 02 and 03 run here.
4. **App end-to-end:** Playwright drives the Electron app built from a fixture engine for the human-only screens (confirmations, review queue, the review screen for requests, meeting runner, onboarding, backups) on macOS and Windows runners.
5. **Security tests:** canary values for redaction (AC-04-09, AC-06-02), backups (AC-04-10) and human steps (AC-06-10), a guard suite for the browser host (AC-04-01, AC-04-03), a listening-socket check (AC-04-08), and an Electron hardening check (fuses, CSP, navigation blocks).
6. **Hermetic and worktree-safe:** each test creates its own profile directory under a short base path (`/tmp/cc-test-<random>` on macOS and Linux, a short path under `%TEMP%` on Windows). macOS's default temp directory is long enough to push a UNIX socket path past 104 bytes.
7. **Cross-repository end-to-end** (P7): fixture engine and connectors repositories in `fixtures/repos/` and a fixture GitHub run the loop of [06 §11](06-connector-discovery.md#11-handoff-to-build), from an approved request to an active connector, and a rollback (AC-07-07).
8. **Traceability:** test names start with the acceptance ID they prove. `cc:trace` reports coverage per phase.

## 9. CI and release

| Repository | Workflow | Trigger | Jobs |
|---|---|---|---|
| `cc-foundation` | `ci.yml` | Every PR and every push to `main` | Install (frozen), typecheck, lint with D1-D7, unit and fixture tests, `cc:gen --check`, `cc:axi-conformance`, `cc:trace`, secret scan and canary denylist, `pnpm audit` and OSV scan, headless scenario tests on Linux, macOS and Windows; the engine-template job on Linux, macOS and Windows: a fresh clone of `cc-engine` `main` on the current packages packed locally (`cc:engine-template`) runs `pnpm install`, `pnpm build` and `pnpm start --smoke`, which proves the packaged app starts on the core in normal mode, reads its fuses back, and checks that a later commit gets the Rebuild now offer (AC-08-11); app end-to-end smoke on macOS and Windows against a fixture engine built from the current packages and the N−1 extension API |
| `cc-foundation` | `release.yml` | A tag `v*` on `main` | Publish every `@cc/*` package at one version to the package registry (OQ-08-07), with provenance. Optional signed demo builds; they are not the user's path. Signing secrets live in a protected environment with a required reviewer |
| `cc-foundation` | `nightly.yml` | Daily | Dependency audit and a Chromium pin check |
| `cc-connectors` | `ci.yml` | Every PR and every push to `main` | Lint with D1 and D2 per package kind, `cc:test-connector` for every changed connector, `cc:test-provider` (recorded) for every changed adapter, fixture hygiene, secret scan |
| `cc-connectors` | `release.yml` | A tag on `main` | In a protected environment: build and pack changed packages, upload them to a GitHub Release, compute `sha256` and `permissionsDigest`, rebuild and sign the index |
| `cc-connectors` | `nightly.yml` | Daily | The `claude_cli` and `codex_cli` flag probes against the latest CLI releases, which open an issue when a flag changes ([04 §6.3](04-platform.md#63-providers-and-adapter-rules)) |
| *your-connectors* | `ci.yml`, `release.yml` | PRs; tags | As `cc-connectors`, without the index: the release publishes each package with its sha256 (spike S8 for attestations) |
| `cc-engine` and *your-engine* | `ci.yml` | Every PR and every push to `main` | Install (frozen), validate `cc.config` and the extension files, build and test the user's app, `cc:path-guard`, check every `connectors.lock` entry's sha256 against its release |
| `cc-engine` and *your-engine* | Renovate or Dependabot | Schedule | One PR per foundation release, updating every `@cc/*` pin together. The engine's `ci.yml` runs `pnpm cc:upgrade --check` on it and comments the planned codemod edits; the PR merges as it is, and the user runs `pnpm cc:upgrade` locally (owner decision D-1, 10 Nov 2026). After the merge the user pulls; CC never pulls, and offers Rebuild now ([04 §10](04-platform.md#10-packaging-updates-and-os-support) rule 2, owner decision C1, 10 Nov 2026) |

Rules:

1. `main` is protected in every repository. Changes land through PRs with green CI. Nobody pushes to `main` directly, agents included.
2. Pull requests from forks never receive secrets. Release and signing jobs never run on PRs.
3. Release artifacts are built only by CI, from a tag on `main`.
4. User copies are made from the templates, private by default, never forks (§1 item 2).

## 10. Contracts

1. **C-08-01** Every repeated task with a fixed procedure is a script. Skills call scripts and never duplicate their logic.
2. **C-08-02** Dependency rules D1 to D7 run in the CI of every repository they apply to. A violation fails the build, and no inline disable is accepted for D1, D2 or D3.
3. **C-08-03** Generated files are never edited by hand. `cc:gen --check` runs in CI.
4. **C-08-04** No repository holds real personal data, credentials or client names. Fixtures are synthetic or sanitised.
5. **C-08-05** Tests are hermetic: no network beyond loopback fixture servers, no shared profile directory, no fixed socket path. Two worktrees can run the full suite at once.
6. **C-08-06** Release artifacts come only from CI on a tag of `main`. Signing keys are never available to PR workflows.
7. **C-08-07** A phase in [09](09-build-plan.md) is done only when `cc:trace --phase <P>` reports every acceptance ID of that phase covered by a passing test, except criteria marked *manual* there.
8. **C-08-08** The engine holds no foundation code and no provider or connector code. It customises CC only through the extension points of §4.3.
9. **C-08-09** In an engine repository, a PR labelled `connector-include` may change only `connectors.lock`, and CI enforces this.
10. **C-08-10** The engine's AI never changes code. This is enforced by the five layers of §5.2, not by `AGENTS.md` alone.

## 11. Acceptance criteria

1. **AC-08-01** On a fresh clone of `cc-foundation` on macOS, Windows and Linux, `pnpm install && pnpm cc:doctor && pnpm test` passes, and the tests make no network calls after install.
2. **AC-08-02** Adding `import Anthropic from '@anthropic-ai/sdk'` to `packages/core` or `packages/orchestrator` in `cc-foundation` fails `pnpm lint` with a message naming rule D1.
3. **AC-08-03** Hand-editing a file under `packages/schemas/records/` fails `pnpm cc:gen --check`.
4. **AC-08-04** Two worktrees run `pnpm test` and `pnpm e2e` at the same time, and both pass.
5. **AC-08-05** `pnpm cc:new-connector --id demo --kind api`, then `pnpm cc:test-connector demo`, runs, and fails only on the unimplemented handlers (compare AC-06-06).
6. **AC-08-06** `pnpm cc:trace` lists every `AC-` ID found in `docs/design/` with its covering tests. Removing the only test of a done phase's criterion fails CI.
7. **AC-08-07** A commit adding a fixture with a string from the canary denylist, or a value matching a secret pattern, fails CI.
8. **AC-08-08** Changing an existing file in `packages/store/migrations/` fails CI. `pnpm cc:new-migration add_x` creates the next number.
9. **AC-08-09** In a fixture engine, a PR labelled `connector-include` that also changes `ui/` fails `cc:path-guard`; one that changes only `connectors.lock` passes.
10. **AC-08-10** A fixture engine written against extension API N−1 builds against the current foundation, and `pnpm cc:upgrade` moves it to API N with type-checks passing.
11. **AC-08-11** A fresh private copy of `cc-engine` builds and starts the app with `pnpm install && pnpm build && pnpm start`, contains no foundation source, and opens onboarding on first start.

## 12. Open questions

1. **OQ-08-01** Owner, visibility and licence of the three upstream repositories. *Default: upstream repositories may be public once P5 decides the licence (it affects third-party connectors); user copies are private template copies, never forks.*
2. **OQ-08-02** Do these design documents move to `cc-foundation/docs/design/` at P0, leaving a pointer in workie, or stay in workie? *Default: move at P0, so the code and its spec change in the same PRs. The engine template gets a user guide in its README.*
3. **OQ-08-03** Code-signing certificates (an Apple Developer ID, and a Windows signing certificate or cloud signing service). *Default: optional; a personal build from the user's own engine needs none. Decide only if signed builds are distributed to others.*
4. **OQ-08-04** Custody of the index signing key in `cc-connectors`: a GitHub environment secret with a required reviewer, or a hardware key held by the user with offline signing? This is linked to OQ-05-02.
5. **OQ-08-05** If a user's `<userData>/run/cc.sock` path exceeds the UNIX socket limit, where does the socket go instead? *Default: a per-user directory under `/tmp` with mode 0700, with the path recorded in `<userData>/run/endpoint`.*
6. **OQ-08-06** `better-sqlite3` or Node's built-in `node:sqlite`? *Default: `better-sqlite3`; revisit when `node:sqlite` is stable in the Node version that Electron ships.*
7. **OQ-08-07** Where are the `@cc/*` packages published: the public npm registry or GitHub Packages? *Default: npm, public, with provenance, once the licence is decided (OQ-08-01); GitHub Packages until then.*
8. **OQ-08-08** The harness deny rules for Claude Code and Codex in the engine repository (§5.2 layer 5) were not verified for this design. *Default: confirm the syntax in spike S9 (P0-13); until then the other four layers stand.*
