# 07 · Agent-friendly design

- **Purpose:** Defines how agents use Command Center (CC). It applies the AXI design principles to the `cc-axi` command line and the MCP server, defines agent principals and scopes, and specifies how CC works with agent frameworks such as firstmate and Grok, for building CC and for running it day to day.
- **Depends on:** [04](04-platform.md) (local API, identity rules §4, Policy Engine §7, MCP transport §8). [03](03-decisions-and-action-items.md) (the records the CLI and MCP expose).
- **Related files:** [08](08-repository-and-automation.md) (repository conventions for agents, scripts and skills). [02](02-rhythm-and-calendar.md) (`meetings` commands). [05](05-connectors.md) and [06](06-connector-discovery.md) (`connectors` commands). [09](09-build-plan.md) (P1 ships the CLI, MCP, hooks and skill; P7 ships the framework integrations).

## 1. Summary

1. `cc-axi` is CC's primary agent surface. It is built on `axi-sdk-js` and follows all ten AXI principles. The no-argument home view shows live state, output is TOON, errors are structured, it never prompts, and unknown flags fail loudly.
2. The MCP server mirrors the same handlers with 14 compact tools, for clients that cannot run a shell.
3. Every agent acts as a named **principal** with scopes. Human-only operations (approvals, verification, decisions) are never available to agents. They return `E_HUMAN_REQUIRED` with a deep link into the app.
4. CC adopts firstmate's principles where they fit: scripts own mechanics and agents own judgement; authority is explicit; obligations close by records; browser adapters are quarantined and version-pinned. It integrates with firstmate only through documented surfaces: a handoff brief the user gives to firstmate, the opt-in fleet activity ledger, which CC reads, and, for connector builds, an issue in the user's engine repository that the user approved on CC's review screen (§6.3). CC never writes into a firstmate home.
5. Grok works through the same CLI, per-bot principals, and a SessionStart hook in the `.grok/hooks/` shape that firstmate uses.

## 2. Sources read

Both repositories were read on 2026-11-04 through `gh-axi` (GitHub API), at pinned revisions. Quotes below are from these files.

| Repository | Revision | Files read |
|---|---|---|
| [kunchenguid/axi](https://github.com/kunchenguid/axi) | `a8a320cc426a5f136a797a5ad138b84cb88bd172` | `README.md`, `principles.yaml`, `.agents/skills/axi/SKILL.md` (full principle specs), `packages/axi-sdk-js/README.md`, `VISION.md` |
| [kunchenguid/firstmate](https://github.com/kunchenguid/firstmate) | `bb8dd209132ef6b0f26395b082cc789de0260738` | `README.md`, `VISION.md`, `AGENTS.md`, `docs/fleet-ledger.md`, `GROK_BOT.md`, `.grok/hooks/fm-primary-sessionstart-nudge.json` |

Points used from AXI:

- The ten principles (`principles.yaml`), detailed in `SKILL.md` §1 to §10.
- The SDK's `runAxiCli()`, `tryFastPath()` from `axi-sdk-js/fast-path`, `installSessionStartHooks()` (Claude Code, Codex, OpenCode) and the built-in `update` command.
- The benchmark tables in `README.md`. In the GitHub benchmark, `gh-axi` had 100% success at $0.050 average cost, against GitHub MCP at 87% and $0.148.

Points used from firstmate:

- `VISION.md`: "Logic that can be exact lives in deterministic scripts; work that requires understanding lives in an agent; the two never mix." Also: "autonomy exists only as an explicit grant, never as a default"; "Evidence is never authorization"; "Obligations are closed by records, not by recollection"; "Every task gets an explicit contract before it starts"; "Workers are supervised, not trusted"; "progress, retries, and internal mechanics are never news"; and the rule that a rendered-surface reading is allowed "only as a named, quarantined, version-pinned adapter that carries its own verification and is expected to break on that vendor's next release".
- `README.md`: ship and scout task shapes; project modes `no-mistakes`, `direct-PR` and `local-only`; disposable worktrees.
- `AGENTS.md`: "Use `gh-axi` for GitHub, `chrome-devtools-axi` for browser work"; "Never add an agent name as a commit co-author"; status appends are "sparse supervisor-actionable events, not routine progress".
- `docs/fleet-ledger.md`: the fleet activity ledger is "the stable, documented hook for firstmate status". Its record contract is `state/fleet-ledger.jsonl`, v1 records `task.dispatched`, `task.status`, `task.pr_ready`, `task.merged` and `task.cleaned_up`. A `task.status` record's `state` is the status line's leading word, "such as `working`, `needs-decision`, `blocked`, `paused`, `done`, `failed`, or `resolved`". Readers "must ignore members and events they do not recognize", and "a reader that must not double-count should tolerate duplicates".
- `GROK_BOT.md`: persistent, role-based bot crewmates with charters; "Secrets are per-bot"; "Browser logins persist for every bot"; hand-offs marked "with a short task id", with the outcome reported back against that ID.
- `.grok/hooks/fm-primary-sessionstart-nudge.json`: Grok project hooks in the shape `hooks.SessionStart[].hooks[] { type: "command", command, timeout }`. The README says "For Grok, `--trust` is needed once per clone so project hooks and the turn-end guard load".

What was not verified: Grok's own documentation for its hook format. The shape above comes from firstmate's tracked file only (OQ-07-01).

## 3. Agent surfaces

| Surface | For | Defined in |
|---|---|---|
| `cc-axi` CLI | Any agent with a shell (firstmate crewmates, Claude Code, Codex, Grok, OpenCode, Cursor, Pi) | §4 |
| MCP server (`cc-axi mcp`, stdio) | MCP-only clients, and CC's own `claude_cli` provider | §7, [04 §8](04-platform.md#8-mcp-server) |
| SessionStart hooks | Ambient context at the start of every agent session | §8 |
| Agent Skill `command-center` | On-demand guidance in any skill-capable agent | §8 |
| Handoff brief and fleet-ledger reader | firstmate operation | §6.3 |
| Repository conventions | Agents building CC | [08](08-repository-and-automation.md) |

## 4. `cc-axi`: the AXI command line

### 4.1 AXI principles applied

| # | AXI principle (`SKILL.md`) | How `cc-axi` applies it | Test (AC-07-01) |
|---|---|---|---|
| 1 | Token-efficient output: "Use TOON … as the output format on stdout", converted "at the output boundary" | Handlers return JSON. The CLI renders TOON through the SDK. `--format json` is an escape for non-agent scripts. | Output parses as TOON |
| 2 | Minimal default schemas: "typically an identifier, a title, and a status"; "Offer a `--fields` flag" | Lists show 4 fields (`ref,title,due,state`). Detail views hold long text. `--fields owner,health,carry,workstream` adds fields. The default `--limit` is 50. | Field count per list type |
| 3 | Content truncation, with a size hint and `--full`, at "500-1500 chars" | `done_means`, notes and pre-reads are truncated at 1,000 characters with the total size. The `--full` hint appears only when something was cut. | Hint present only on truncation |
| 4 | Pre-computed aggregates: "include the **total count**" plus derived status | `count: 5 of 23 open items due within 7 days`; per item `evidence: 1/2 checks passed`, `steps: 1/2 done`, `carry: 2`, and the next meeting | Totals equal store counts |
| 5 | Definitive empty states | `items: 0 open items owned by you in workstream quillmarsh` | Every list has a zero message |
| 6 | Structured errors and exit codes: idempotent mutations, errors on stdout, "No interactive prompts", fail loud on unknown flags, exit codes 0/1/2 | A repeated claim prints `no-op`, exit 0. Errors print `error:` and `help:` on stdout (§4.4). Confirmations never prompt: they return `pending_confirmation`, exit 0, and `confirmations wait` polls. Unknown flags exit 2 and list the valid flags of that subcommand. Renamed flags get a targeted hint. Progress goes to stderr only. | Conformance suite |
| 7 | Ambient context: an explicit setup command; default targets Claude Code, Codex, OpenCode; portable commands; idempotent; directory-scoped; "Token-budget-aware"; a skill generated from the home view | `cc-axi setup hooks` (§8) through `installSessionStartHooks()`, plus Grok. The hook output is directory-scoped through `Workstream.repoPaths`. The skill is generated from the home view with a CI `--check`. | Repeat install is a no-op; skill drift check |
| 8 | Content first: "Running your CLI with no arguments should show the most relevant live content" | `cc-axi` prints the home view (§4.3) | No-args output has live data |
| 9 | Contextual disclosure: "a few next steps", parameterised placeholders, omitted on self-contained views | `help[]` after lists and mutations, with `<ref>` placeholders and the current `--workstream` carried forward. None on detail views without truncation. | Suggestions present or absent per rule |
| 10 | Consistent help: the home view shows `bin:` (with `~`) and `description:`; per-subcommand `--help`; `-v`, `-V` and `--version` fast path | The home header holds `bin:` and `description:`. Each subcommand's `--help` gives flags, defaults and 2 or 3 examples. The version is answered through `tryFastPath()` from a leaf `version.ts` before the command graph loads. | Version latency within 50 ms of the node floor |

### 4.2 Commands

Global always-allowed flags (AXI §6 allows a standard set): `--help`, `--format toon|json`, `--principal <name>`. They come after the command, as `runAxiCli()` requires; a flag before the command is the SDK's `VALIDATION_ERROR`, exit 2 ([ADR 0002](../adr/0002-local-api-and-cli.md)). `cc-axi` finds the app through `<userData>`, which `CC_PROFILE_DIR` overrides (for an app started with `--profile-dir`); `CC_PRINCIPAL` names the principal when `--principal` is absent (default `cli-default`).

```text
cc-axi                                              home view
cc-axi home [--format <f>] [--principal <name>]     the home view, accepting the global flags (ADR 0002)
cc-axi items list    [--workstream <slug>] [--owner me|<person>] [--state <lifecycle>|active] [--health <h>]
                     [--due-before <date>] [--fields <list>] [--limit <n>]
cc-axi items view    <ref> [--full]
cc-axi items create  --workstream <slug> --title "<verb + deliverable>" --due <YYYY-MM-DD> --done-means "<text>"
                     [--owner <person>] [--evidence "<requirement>"]... [--kind todo|follow_up] [--meeting <M-ref>]
cc-axi items update  <ref> [--health on_track|at_risk|off_track --note "<text>"] [--propose-due <date> --reason "<text>"]
cc-axi items claim   <ref> --evidence <url|file:<path>|record:<binding>/<type>/<externalId>> [--note "<text>"]
cc-axi items attach  <ref> --evidence <url|file:<path>|record:<binding>/<type>/<externalId>> [--requirement <er-id>]
cc-axi items history <ref>
cc-axi search        "<text>" [--types items,decisions,issues,meetings] [--limit <n>]
cc-axi items handoff <ref> --to firstmate|grok|other
cc-axi items link    <ref> --firstmate-task <id> --home <path>
cc-axi decisions list|view <ref>|propose --workstream <slug> --question "<q>" [--option "<text>"]... [--decider <person>]
                     [--reversibility two_way|one_way] [--due-by <date>]
cc-axi issues list|view <ref>|raise --workstream <slug> --title "<text>"
cc-axi meetings list [--range today|week|<from>..<to>] | view <ref> | preread <ref> [--full]
                     | capture <ref> --section <id> (--action "<title>" --owner <p> --due <d> --done-means "<t>" | --note "<t>")
                     | export-ics --weeks <n> --out <file>
cc-axi measures list [--workstream <slug>] | record <ref> --value <v> [--period <date>] [--note "<t>"]
cc-axi goals list [--workstream <slug>] [--period current|previous|next]
cc-axi workstreams list | view <slug>
cc-axi connectors list | search <text> | view <id> | actions <binding> | health [<binding>]
                     | invoke <binding> <action> --input '<json>' [--wait <seconds>]
                     | test <path> [--live --binding <label>] | discover --tool "<name>"
cc-axi sessions list
cc-axi confirmations list | view <id> | wait <id> --timeout <seconds>
cc-axi onboarding status | recommend --file <profile.json> | apply --file <profile.json> [--dry-run]
                     | rerun --step <S1..S9> --file <answers.json> [--dry-run] | export --out <profile.json>
cc-axi requests list [--status <s>] | view <id> | propose --title "<t>" --body-file <path>   (06 §10.4)
cc-axi backups status                               last good backup, last restore test (04 §9.1)
cc-axi open [<ref>|<id>]                            opens the app at the matching deep link
cc-axi export --out <dir>
cc-axi mcp [--run <runId>]                          stdio MCP relay (§7)
cc-axi setup hooks [--agents claude-code,codex,opencode,grok] [--scope user|project] | skill | status
cc-axi hook session-start                           used by installed hooks (§8)
cc-axi serve --headless --profile-dir <dir>         development and tests only
cc-axi update [--check]                             prints the version: cc-axi ships inside the app and updates
                                                    with it; shadows the SDK's npm-based built-in (ADR 0002, OQ-07-02)
```

No command approves, confirms, attests, rejects or decides, and none approves, rejects or defers a development request, runs a restore or activates a connector. Those are human-only ([04 §4.3](04-platform.md#43-who-counts-as-the-user)).

`items update --propose-due <date> --reason "<text>"` does not move the due date. It records an `action_item.due_proposed` event with the proposed date and the reason, and leaves the item unchanged. The proposal shows in the item's history (`items history`, C-03-04) for the user to re-plan in the app. The same proposal again, or the date the item already has, is `no-op` (owner decision, 12 Nov 2026).

This is the full surface across all phases. Commands arrive with their phase in [09](09-build-plan.md) (for example `items handoff` and `items link` in P7). A command that is not built yet is absent from `--help`, not stubbed.

### 4.3 Output examples

Home view (no arguments), as `axi-sdk-js` renders it: a value holding `:` or `,` is quoted, and `help[n]` is one comma-joined line ([ADR 0002 measurements §4](../adr/0002-local-api-and-cli/measurements.md#4-home-view)):

```text
bin: ~/.local/bin/cc-axi
description: "Command Center - decisions, action items and meeting rhythm across your workstreams"
workspace: main
now: "2026-11-13T09:02:00+05:30"
today[3]{ref,time,meeting}:
  M-0028,"09:00",Daily start
  M-0031,"15:00",Weekly CEO review
  M-0029,"17:20",Daily shutdown
attention:
  overdue: 2
  at_risk: 3
  awaiting_review: 4
  confirmations_pending: 1
  sessions_needing_you: 1
items[3]{ref,title,due,state}:
  A-0142,Send revised proposal with phased pricing to the consulting lead,2026-11-12,overdue
  A-0150,Ship the Quillmarsh onboarding checklist,2026-11-16,open
  A-0160,"Alderwick LinkedIn batch, week 47",2026-11-19,in_progress
count: 3 of 9 items overdue or due within 7 days (23 open in total)
help[3]: Run `cc-axi items view <ref>` for details,Run `cc-axi items list --due-before 2026-11-20` for all 9,Run `cc-axi meetings preread M-0031` to prepare today's review
```

An empty part is a definitive message, such as `today: 0 meetings today` or `items: 0 items overdue or due within 7 days (23 open in total)`. Help lines name only commands that exist in the running build.

In lists, `state` is the display state: `overdue` when the due date has passed and the item is not claimed, otherwise the lifecycle. The home view picks up to 3 items: overdue first, then by due date.

Detail view (P1 has no person lookup in the local API, so `owner` is the person ID):

```text
item:
  ref: A-0142
  title: Send revised proposal with phased pricing to the consulting lead
  workstream: alderwick
  kind: todo
  owner: per_self
  due: 2026-11-12
  state: waiting
  waiting_on: confirmation cfm_7q2 since 2026-11-11
  health: off_track
  health_note: Past due and not claimed (set by the escalation job)
  done_means: The revised proposal is sent from the Alderwick mailbox to the lead and filed in the client folder.
  evidence: 0/1 checks passed
  steps: 1/2 done (s2 waiting_confirmation cfm_7q2)
  carry: 0
  source: manual
```

A field cut at 1,000 characters ends with `… (truncated: 1000 of <n> chars)`, and only then does the view end with a `help[1]` line suggesting `cc-axi items view A-0142 --full`.

Pending confirmation (exit 0):

```text
invoke:
  binding: gmail-alderwick
  action: send_draft
  status: pending_confirmation
  confirmation: cfm_7q2
  expires: "2026-11-14T09:00:00Z"
help[2]: "Approve or deny it in the app: commandcenter://confirmations/cfm_7q2",Run `cc-axi confirmations wait cfm_7q2 --timeout 600` to wait for the decision
```

### 4.4 Errors and exit codes

| Code | Exit | Meaning | Help line points to |
|---|---|---|---|
| (none) `no-op` | 0 | Desired state already holds | none |
| (none) `pending_confirmation` | 0 | Accepted; waits for the user in the app | the deep link and `confirmations wait` |
| `E_USAGE` | 2 | Missing or invalid argument | the exact flag format |
| `E_UNKNOWN_FLAG` | 2 | Unrecognised flag or argument | the subcommand's valid flags, listed inline |
| `VALIDATION_ERROR` | 2 | A flag before the command, reported by `axi-sdk-js`, which cannot be overridden ([ADR 0002](../adr/0002-local-api-and-cli.md) follow-up 1) | the command with the flag moved after it |
| `E_NOT_FOUND` | 1 | No record with that ref or ID | the matching `list` command |
| `E_INVARIANT`, `E_PARAM_BOUNDS` | 1 | A model or framework rule was violated | the rule ID and the allowed values |
| `E_CONFLICT` | 1 | Stale version | re-run `view` and retry |
| `E_FORBIDDEN`, `E_PERMISSION` | 1 | Scope, workstream or connector permission missing | Settings → Agent access |
| `E_HUMAN_REQUIRED` | 1 | Human-only operation | `cc-axi open <ref>` and the deep link |
| `E_EVIDENCE_MISSING` | 1 | A claim without required evidence | the requirement IDs |
| `E_PAYLOAD_CHANGED` | 1 | The approved payload differs | a new confirmation ID |
| `E_RATE_LIMIT`, `E_BUDGET` | 1 | Limit reached | the retry time or budget setting |
| `E_APP_NOT_RUNNING` | 1 | The local API is not reachable | "Open Command Center, then retry" |
| `E_ALREADY_RUNNING` | 1 | Another Command Center already serves this profile's endpoint (ADR 0002) | "Use the running app, or quit it first" |
| `E_ENDPOINT_UNSAFE` | 1 | The endpoint, its directory, its record or a token file fails the ownership and mode checks, or the endpoint cannot prove it knows the token (ADR 0002) | the file to remove or fix |
| `E_INTERNAL` | 1 | An unexpected failure inside a core handler; the core logs it | retry, and report it if it repeats |
| `E_CRASH` | 1 | A run failed because a CC process crashed ([04 §3](04-platform.md#3-process-architecture)) | `cc-axi items view <ref>`; retried automatically only if the action is idempotent |
| `E_GUARD_*`, `E_SIGNATURE`, `E_AGENDA_FIT` | 1 | See [04](04-platform.md), [05](05-connectors.md) and [02](02-rhythm-and-calendar.md) | specific fix |

Error format on stdout (TOON as `axi-sdk-js` renders it; JSON with `--format json`):

```text
error: unknown flag --stat for `items list`
code: E_UNKNOWN_FLAG
help[1]: "valid flags for `items list`: --workstream, --owner, --state, --health, --due-before, --fields, --limit, --format, --principal (--help always allowed)"
```

## 5. Agent principals and scopes

```ts
type Scope =
  | 'read'                 // home, list, view, history, preread
  | 'items:write'          // create drafts; update health and notes; propose due changes (§4.2)
  | 'items:claim'          // claim with evidence; attach evidence
  | 'decisions:propose'    // propose decisions, options, recommendations
  | 'meetings:capture'     // add draft outputs to an in_progress meeting
  | 'measures:write'       // record manual measure values
  | 'connectors:read'      // list actions, health; invoke actions with risk 'read'
  | 'connectors:invoke'    // invoke other actions (still evaluated by the Policy Engine)
  | 'sessions:read'        // list browser sessions and their state, never their contents
  | 'discovery:request'    // create discovery requests; starting a run stays human-only
  | 'requests:propose'     // propose development requests such as engine changes (06 §10.4); approving stays human-only
  | 'onboarding:apply';    // apply a profile or a re-run plan (01 §3); calendar writes still need confirmation

interface AgentPrincipal extends Audit {
  id: AgentPrincipalId;
  name: string;            // "cli-default", "claude-code", "firstmate-main", "grok-cc", "orchestrator-drafter"
  kind: 'cli' | 'mcp_client' | 'external_framework' | 'internal_orchestrator';
  scopes: Scope[];
  workstreamFilter: WorkstreamId[] | 'all';
  sensitiveAccess: boolean;        // may read sensitive workstreams; default false
  tokenPath: string;               // <userData>/run/tokens/<name>.token (04 §4.2)
  lastUsedAt?: UtcTimestamp;       // set on authentication, written at most once a minute
  revokedAt?: UtcTimestamp;
}
```

| Principal | Scopes (default) | Workstreams | Sensitive |
|---|---|---|---|
| `cli-default` | read, items:write, items:claim, measures:write, connectors:read, sessions:read | all | no |
| `claude-code` (MCP) | read, items:write, items:claim, decisions:propose, meetings:capture, connectors:read | all | no |
| `firstmate-main` | read, items:write, items:claim | Alderwick, Quillmarsh | no |
| `grok-cc` | read, items:write | all | no |
| `orchestrator-<profile>` | set per profile ([04 §6.4](04-platform.md#64-agent-profiles)) and narrowed per step | the step's workstream | by `aiDataPolicy` |

Rules:

1. Principals are created, changed and revoked only in the app (human-only). Every call records the principal in its domain event.
2. Scopes give least privilege among cooperating agents. They do not secure against code running as the same OS user ([04 §4.2](04-platform.md#42-principals-and-tokens) rule 4). Outward effects stay behind UI-only confirmations.
3. No `cli`, `mcp_client` or `external_framework` principal has `connectors:invoke`, `discovery:request`, `requests:propose` or `onboarding:apply` by default. Internal orchestrator principals get only what their profile and step allow. The user grants these scopes per principal in Settings → Agent access, for example `onboarding:apply` to `cli-default` while setting up from a terminal (AC-01-06).

## 6. Agent framework integration

### 6.1 Principles adopted from firstmate

| firstmate principle (`VISION.md`) | CC design consequence |
|---|---|
| "Scripts own the mechanics, agents own the judgment" | Connectors, the recommender, escalation, placement and click classification are deterministic code. AI SDK code is only in adapter packages, and orchestration only in the foundation's orchestrator ([05 §12](05-connectors.md#12-no-ai-in-connectors-enforcement), [01 §6](01-onboarding-and-frameworks.md#6-decision-tree-inputs-rules-outputs)) |
| "Authority is explicit and never inferred" | Every non-read effect goes through the Policy Engine. Approvals happen only in the UI. Standing approvals are explicit, scoped and revocable ([04 §7](04-platform.md#7-policy-engine-and-confirmations)) |
| "Evidence is never authorization" | The AI reviewer's verdict never closes an item ([03 §9.2](03-decisions-and-action-items.md#92-the-loop)) |
| "Obligations are closed by records, not by recollection" | Items close only as `verified_done` or `dropped`. Carry-forward is a query, so nothing can fade ([02 §7](02-rhythm-and-calendar.md#7-carry-forward-and-escalation)) |
| "Every task gets an explicit contract before it starts" | Agent steps carry instructions, a tool allowlist, a budget and the evidence they must produce ([03 §5.8](03-decisions-and-action-items.md#58-execution-plan)) |
| Rendered-surface readings only as "a named, quarantined, version-pinned adapter that carries its own verification" | Browser connectors are flagged `unofficial_surface`, carry `selectorsVersion` and a live probe, and degrade to user steps on failure ([05 §3](05-connectors.md#3-connector-kinds)) |
| "progress, retries, and internal mechanics are never news" | The notification policy pushes only decisions, confirmations, needs-you and escalations ([02 §10](02-rhythm-and-calendar.md#10-notifications)) |

### 6.2 Developing CC with firstmate

1. Three kinds of firstmate project, each with its own rules ([08 §1](08-repository-and-automation.md#1-summary)):
   - **`cc-foundation`** (and upstream `cc-connectors`): maintainers' work. Ship tasks deliver PRs, and scout tasks deliver reports. The P0 spikes in [09](09-build-plan.md) are scout tasks.
   - **The user's connectors repository**: ship tasks build connectors and adapters from approved development requests ([06 §11.3](06-connector-discovery.md#113-build-include-and-activate)).
   - **The user's engine repository**: include PRs only, which change `connectors.lock` through `pnpm cc:include` and nothing else (the path guard enforces this).
2. The delivery mode (`no-mistakes`, `direct-PR` or `local-only`) is the captain's choice per firstmate's project registry (OQ-07-03).
3. Each repository's `AGENTS.md` lists its commands, rules and layout ([08 §5](08-repository-and-automation.md#5-agentsmd-for-each-repository)). They tell agents to use `gh-axi` and `chrome-devtools-axi`, as firstmate's own `AGENTS.md` does, and forbid agent co-author lines. The engine's `AGENTS.md` also forbids its AI from changing code.
4. Everything is worktree-safe. Tests and the headless core take `--profile-dir`, so parallel crewmate worktrees never share an app data directory, a socket or a database.

### 6.3 Operating with firstmate

**Handoff.** CC never writes into a firstmate home: not its backlog, its steering inbox or its status files. firstmate's intake comes from the captain, and authority is never inferred.

1. For an item whose step performer is `external_agent: firstmate`, `cc-axi items handoff <ref> --to firstmate` prints a brief:

```text
handoff:
  item: A-0144
  title: Fix the contact form on quillmarsh.example
  intent: The contact form sends messages again and shows its confirmation.
  acceptance[2]:
    PR merged in the site repository
    Contact page returns 200 and shows "Thank you" after a test submission (checked by the user)
  report_back: cc-axi items claim A-0144 --evidence <pr-url> --principal firstmate-main
help[1]:
  Give this brief to your first mate, or say "take Command Center item A-0144"
```

2. The user gives the brief to firstmate. firstmate, or the user, links the task: `cc-axi items link A-0144 --firstmate-task <task-id> --home <FM_HOME>`.

**Tracking through the fleet ledger.** This is read-only and needs the user to opt in on both sides: the firstmate home's `config/fleet-ledger` flag, and Settings → Integrations → firstmate home path in CC.

1. CC tails `<FM_HOME>/state/fleet-ledger.jsonl`. It follows the contract: ignore unknown members and events; deduplicate by a hash of the whole record; keep a byte offset; restart from 0 if the file shrinks (it may be truncated).
2. Ledger text is untrusted data, as the ledger contract says: "give its readers exactly the trust you give `state/`".

| Ledger record | CC effect on the linked item |
|---|---|
| `task.dispatched` | Step `waiting_external`, with a note naming the harness |
| `task.status` with state `working` or `paused` | Note only. Not pushed (progress is not news) |
| `task.status` with state `needs-decision` or `blocked` | Health `at_risk`, note "firstmate needs a decision", and an attention entry. The decision itself is answered in firstmate, not in CC |
| `task.status` with state `failed` | Step `failed`, health `at_risk` |
| `task.status` with state `done` or `resolved` | Note |
| `task.pr_ready` | `external_task` evidence with the PR URL; check `external_task_state: pr_ready` passes |
| `task.merged` | Check `external_task_state: merged` passes, then is cross-checked with the `github` connector (`get_pull`, merged = true) before it counts |
| `task.cleaned_up` | Step `succeeded` |

**Connector builds.** The intake for building a connector or adapter is an issue in the user's engine repository, filed by the ticket run ([06 §11.2](06-connector-discovery.md#112-ticket-run)), labelled `cc:approved` by the user (on CC's review screen, or on GitHub), plus the captain's go: the user hands firstmate the brief the review screen prints.

```text
handoff:
  request: req_01J... (connector hostinger)
  issue: https://github.com/<you>/<your-engine>/issues/<n>
  intent: Build the hostinger connector from the attached spec in <your-connectors>, then include it.
  acceptance[3]:
    Connector PR merged in <your-connectors>; its first tests replay the spec's proven exchanges
    Include PR merged in <your-engine>, changing only connectors.lock
    CC shows hostinger active (or the issue carries the rollback comment)
  checks[1]:
    The cc:approved label on the issue was applied by <your GitHub account>
help[1]:
  Give this brief to your first mate with the sanitised fixtures exported from the review screen
```

1. firstmate checks who applied the label: GitHub records the account. A ticket's existence is not approval.
2. firstmate builds in the user's connectors repository and opens a PR; after the user merges and the release publishes a sha256, firstmate opens the include PR in the user's engine repository.
3. CC follows progress from the issue and the PRs (through the `github` connector) and, when linked, from the fleet ledger. C-07-04 is unchanged: CC writes nothing into a firstmate home.

### 6.4 Grok

1. **Harness.** firstmate lists Grok as one of its "equal co-primary recommendations", and tracks its Grok project hooks as JSON files under `.grok/hooks/`, which load once the clone is trusted. That Grok reads every JSON file in that directory is an inference from firstmate's layout (OQ-07-01). `cc-axi setup hooks --agents grok --scope project` writes `.grok/hooks/command-center-sessionstart.json` in the shape observed in firstmate (§2): `{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"<cc-axi path> hook session-start","timeout":10}]}]}}`.
2. **Bot crews.** For `GROK_BOT.md`-style crews, each bot that needs CC gets its own principal and token. This follows "Secrets are per-bot". Tokens are never pasted in chat.
3. **Charter snippet** for a CC crewmate bot:

```text
Charter: Command Center crewmate. Keep the Command Center register current for the captain's
workstreams through `cc-axi --principal grok-cc`. Start with `cc-axi` (home view). Never approve,
confirm, attest or decide: the Command Center app does that with the captain. Use the Command Center
item ref (for example A-0142) as the task id, and report outcomes and blockers to Firstmate against it.
```

4. **Browser logins.** "Browser logins persist for every bot" in a Grok crew, so CC's browser sessions live in app-private profiles ([04 §5](04-platform.md#5-browser-sandbox)). A bot's shared browser never holds CC sessions, and CC never uses a bot's browser.

### 6.5 Other harnesses

| Harness | Integration |
|---|---|
| Claude Code | MCP registration (`claude mcp add command-center -- cc-axi mcp --principal claude-code`), CLI, hooks through `installSessionStartHooks()`, the skill |
| Codex, OpenCode | CLI, hooks through `installSessionStartHooks()` (AXI default targets), the skill |
| Cursor, Pi, Antigravity and others | CLI and the skill. MCP where the client supports stdio servers |

## 7. MCP server surface

The server name is `command-center`, using stdio transport ([04 §8](04-platform.md#8-mcp-server)). Tool definitions are generated from `packages/schemas`. Each tool description is one sentence. The whole `tools/list` payload stays at or under 12 KB, checked in CI. Results are the same TOON text as the CLI, in one text content block. Errors set `isError: true`, with the same `error:` and `help:` lines.

| Tool | Local API method | Scope |
|---|---|---|
| `cc_home` | `home.get` | read |
| `cc_search` | `search.query` (full text over items, decisions, issues and meetings) | read |
| `cc_list` | `<type>.list` for type in items, decisions, issues, meetings, measures, goals, workstreams, requests | read |
| `cc_get` | `<type>.get` by ref or ID (`full` flag) | read |
| `cc_create_action` | `items.create` (always a draft) | items:write |
| `cc_update_action` | `items.update` | items:write |
| `cc_claim` | `items.claim` | items:claim |
| `cc_attach_evidence` | `evidence.add` | items:claim |
| `cc_propose_decision` | `decisions.propose` | decisions:propose |
| `cc_meeting_capture` | `meetings.capture` (drafts) | meetings:capture |
| `cc_record_measure` | `measures.record` | measures:write |
| `cc_connector_actions` | `connectors.actions` | connectors:read |
| `cc_connector_invoke` | `connectors.invoke` | connectors:read for `read` actions, connectors:invoke otherwise |
| `cc_confirmation_status` | `confirmations.get` and `confirmations.wait` | read |

AXI's own benchmark found MCP conditions costlier than the AXI CLI. CC therefore keeps the MCP surface to these 14 tools, and recommends the CLI to agents that have a shell.

## 8. Ambient context: hooks and skill

1. **Setup.** `cc-axi setup hooks` runs only when the user asks (AXI §7, explicit opt-in). It installs or repairs SessionStart hooks for the chosen agents and scope, using the portable command rule (a PATH-verified binary name, otherwise an absolute path). A repeat install is a silent no-op. `cc-axi setup status` reports what is installed.
2. **Hook output.** `cc-axi hook session-start` prints at most 20 lines: the workspace name; today's meetings; counts of overdue, at-risk and awaiting-review items and pending confirmations; and the top 3 items for the workstream mapped to the current directory (`Workstream.repoPaths`, or a git remote match). It ends with one help line. Sensitive workstreams are excluded unless the principal has `sensitiveAccess`.
3. **Skill.** `skills/command-center/SKILL.md` is generated by `pnpm cc:gen` from the home-view help text with live data stripped. CI fails if it is stale (`pnpm cc:gen --check`). Its description is trigger-shaped: "Use when the user asks about their action items, decisions, meetings, scorecards, or Command Center." It can be installed with `npx skills add <org>/cc-foundation --skill command-center`.
4. **Install of the binary.** The app bundles `cc-axi`. Settings → Install command-line tool links it into a user PATH directory. Publishing to npm, so that `npx -y` works for skills, depends on the package name (OQ-07-02).

## 9. Contracts

1. **C-07-01** Every `cc-axi` command follows §4.1. The AXI conformance suite (`pnpm cc:axi-conformance`) runs in CI.
2. **C-07-02** No CLI command or MCP tool performs a human-only operation ([04 §4.3](04-platform.md#43-who-counts-as-the-user)).
3. **C-07-03** CLI, MCP and the AI layer call the same local API handlers ([04 §4](04-platform.md#4-local-api-and-identity)).
4. **C-07-04** CC writes nothing into any firstmate home. Its firstmate integration is the printed handoff brief plus read-only ledger tailing.
5. **C-07-05** The hook output stays at or under 20 lines and contains no data from sensitive workstreams without `sensitiveAccess`.
6. **C-07-06** `SKILL.md` and the MCP tool definitions are generated. Drift fails CI.

## 10. Acceptance criteria

1. **AC-07-01** `pnpm cc:axi-conformance` passes for every command. It checks: TOON parses; unknown flags exit 2 with the valid flags listed; every list has a definitive empty message; lists carry a total count; `--full` hints appear only on truncation; the home view starts with `bin:` and `description:`; `-v`, `-V` and `--version` print the bare version.
2. **AC-07-02** `cc-axi --version` completes within 50 ms of `node -e "console.log(1)"` measured in the same CI job.
3. **AC-07-03** A Claude Code session with the MCP server registered can list today's items and create a draft item. Its attempt to confirm a claim returns `E_HUMAN_REQUIRED` with a deep link.
4. **AC-07-04** With a fixture `fleet-ledger.jsonl` containing duplicate and unknown records, linking A-0144 to the fixture task yields exactly one `pr_ready` evidence and, after the merged record plus a fixture GitHub `get_pull`, a passing merged check.
5. **AC-07-05** `cc-axi setup hooks --agents claude-code,codex,opencode,grok --scope project` run twice leaves one hook per agent. The Grok file matches the documented shape.
6. **AC-07-06** In a directory listed in Quillmarsh's `repoPaths`, the hook output shows Quillmarsh's top items only, and never an item of a sensitive workstream.
7. **AC-07-07** End to end against fixture repositories and a fixture GitHub: an approved Hostinger request leads to a connector PR in the fixture connectors repository, a release with a sha256, an include PR in the fixture engine that changes only `connectors.lock`, an idle pickup, staged activation and the request `active` with the issue closed. A second run with a connector that fails its health probe rolls back to last-known-good and comments on the issue.

## 11. Open questions

1. **OQ-07-01** Grok's hook format and MCP support were taken from firstmate's tracked files, not from Grok's own documentation. Verify before P7 ships the Grok hook writer.
2. **OQ-07-02** npm package name for the CLI (`cc-axi` may be taken), and whether to publish it at all, given it needs the local app.
3. **OQ-07-03** firstmate project mode for the CC repository: `no-mistakes` for product code and `direct-PR` for docs-only changes? This is the captain's decision in firstmate.
4. **OQ-07-04** Should CC be listed in the AXI community catalog? The AXI `VISION.md` requires an independent source review at a pinned revision before admission. *Default: consider after v1.*
5. **OQ-07-05** Should CC offer an optional, user-approved "send to firstmate" action that writes a brief file somewhere firstmate reads, or should firstmate poll for `cc:approved` issues? Either needs firstmate to define such an intake. *Default: no; the captain relays the brief the review screen prints.*
