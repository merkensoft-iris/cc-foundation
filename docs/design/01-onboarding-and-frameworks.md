# 01 · Onboarding and choosing a framework

- **Purpose:** Defines the onboarding flow, the framework catalogue (fixed backbone plus configurable parameters), and the deterministic decision tree that turns onboarding answers into one framework instance per workstream.
- **Depends on:** [README.md](README.md) for IDs, time and actor conventions. Uses the record types `Workstream`, `Person`, `Goal` and `Measure` from [03](03-decisions-and-action-items.md).
- **Related files:** [02](02-rhythm-and-calendar.md) turns framework meetings into calendar series. [05](05-connectors.md) covers the tool-inventory step. [04](04-platform.md) covers the AI-provider step and backups (§9.1). [06](06-connector-discovery.md) covers *find with AI* for a missing connector or adapter. [08](08-repository-and-automation.md) covers the engine repository where customisation lives. [09](09-build-plan.md) ships `personal-os`, `4dx` and `eos-lite` in phase P1 and the other templates in P7.

## 1. Summary

1. Onboarding collects answers into one versioned `OnboardingProfile` (§4). Nothing outside Command Center (CC) is changed before the final commit step. Calendar writes and service sign-ins need their own confirmations ([04 §7](04-platform.md#7-policy-engine-and-confirmations)). The answers live in the local store, which is the source of truth and is backed up ([04 §9.1](04-platform.md#91-backups)). The user's engine repository may hold an exported, non-sensitive `profile.json` that the user commits; CC itself never commits to git (§9.1).
2. Each **workstream** gets exactly one **framework instance**. A workstream is a company, a client engagement, a personal goal area, or a goal the user runs for someone else (for example, a job search). A framework instance is a template plus parameters plus packs.
3. A **framework template** has a fixed **backbone**: a goal model, required meetings and machine-checked **invariants**. It also declares bounded **parameters**. Users change parameters, vocabulary and packs, but they cannot break an invariant. A deliberate **fork** creates a `custom:` template, which drops the original framework's name.
4. The recommender is a pure, deterministic function of the answers (§6). AI may turn free-text answers into *suggested* structured answers. The user confirms those suggestions, and the AI never picks the framework itself.
5. v1 ships three templates: `personal-os`, `4dx` and `eos-lite`. The reference scenario uses `eos-lite`; `4dx` and `personal-os` cover one-goal and personal workstreams. `eos`, `okr` and `scaling-up` are specified here as backbones and ship in phase P7.
6. Onboarding works through the UI and, without prompts, through `cc-axi onboarding apply --file profile.json [--dry-run]` ([07](07-agent-friendly-design.md)). From P3 the user may instead upload one or more documents that answer the questions, and approve what CC infers from them (§3.2; owner decision Q10, 10 Nov 2026).
7. When the app built from the user's engine starts for the first time, it opens onboarding, and asks the questions needed to configure the system.

## 2. Scope and non-goals

- In scope: questions, answer types, validation, the recommendation rules, template and pack schemas, the scenario walk-through, re-running onboarding.
- Non-goals: calendar mechanics ([02](02-rhythm-and-calendar.md)), connector sign-in ([05](05-connectors.md)), and multi-user team onboarding. CC is single-user. Other people are `Person` records.

## 3. Onboarding flow

Steps run in this order. Each step can be skipped and resumed. Answers persist after every step (`OnboardingProfile.completedSteps`). The target for the reference scenario is 20 minutes or less of user time.

| # | Step | Asks | Creates (at commit) |
|---|---|---|---|
| S1 | `workspace` | Name, time zone, work week, working hours, **protected blocks** (times nothing may be booked into), weekly time budget for meetings and reviews, quiet hours; **backups**: a passphrase and an off-machine destination (a folder such as the Google Drive desktop synced folder, Google Drive, or S3), skippable ([04 §9.1](04-platform.md#91-backups)) | `Workspace`, `Person(role=self)`, `BackupPolicy` |
| S2 | `workstreams` | "List everything you want to run here": companies, business units, client engagements, personal goal areas, goals the user runs for someone else, such as another person's job search. For each one: kind, name, parent, whose outcome it is, time zone | `Workstream`, plus a `Person` for every non-self principal |
| S3 | `profiles` | Per workstream: headcount, leadership group size, teams under leads, stage, business type, primary goal, goal shape, deadline, target roles (job search), existing framework, weight preference, confidentiality | nothing yet (inputs to S4) |
| S4 | `recommendation` | Shows the `FrameworkRecommendation` per workstream: template, mode, packs, fired rules, rationale, two alternatives, warnings. The user accepts it or picks an alternative | nothing yet |
| S5 | `tailoring` | Follow-up questions per framework instance (§8): meeting day, time and duration; scorecard measures; first goals or WIG; decision method; ownership; review strictness; escalation thresholds; AI data policy | `FrameworkInstance`, `Measure`, `Goal` (draft) |
| S6 | `rhythm` | Shows the composed weekly grid across all workstreams: merged meetings, protected blocks, time-budget check (rule T1). The user adjusts times | `MeetingSeries` (see [02](02-rhythm-and-calendar.md)) |
| S7 | `tools` | "Which third-party tools do you use, for which workstream?" grouped by category, listing what `connectors.lock` and the catalogue offer. Then "Where does your team track tasks? (Jira / Linear / none → Google Sheet)" (category `task_tracker`; owner decision C2, 10 Nov 2026; [05 §16](05-connectors.md#16-onboarding-tool-selection-step-s7-and-the-reference-scenario) item 4). For each tool: pick a connector, *manual*, *find with AI* ([06](06-connector-discovery.md)) or *later*. For calendars: which calendars, and which workstreams sync where ([02 §9.6](02-rhythm-and-calendar.md#96-calendar-mapping-the-engines-choice-no-provider-code)) | `ConnectorBinding` drafts (no sign-in yet); a draft development request per *find with AI* gap |
| S8 | `ai` | AI provider, from the adapters in `connectors.lock`: Claude CLI, Codex CLI (proposed, once its adapter ships), Anthropic API, OpenAI, or none; or *find with AI* for a provider with no adapter. Model; optional per-task routing; daily budget; then a test call | `AiProviderConfig` ([04 §6](04-platform.md#6-ai-layer-providers-and-agent-profiles)); a draft development request for an adapter gap |
| S9 | `commit` | A full preview of every record and every outward action (calendar events, sign-ins), then **Confirm** | All records in one transaction, then the separately confirmed outward actions |

Rules for the flow:

1. S4 never runs before S3 is complete for every workstream it covers.
2. Every free-text field (`notes`) may be parsed by the AI `extractor` profile into suggested structured values. Suggestions are shown with a "suggested" badge and are never committed without the user's acceptance.
3. Re-running any step later (`cc-axi onboarding rerun --step <step>` or the Settings UI) produces a diff and a migration plan. It never edits records silently (contract C-01-06).
4. A workstream can be added later. That runs S2 to S7 for the new workstream only.
5. A **gap** is a missing connector (S7) or a missing AI adapter (S8). Choosing *find with AI* for a gap is the consent moment for discovery's public research only ([06 §3](06-connector-discovery.md#3-triggers-and-preconditions)); discovery still starts only with the user (C-06-01), and nothing path-specific happens before the user picks a path.
6. **All 67 questions stay** (owner decision Q10 (c), 10 Nov 2026). §3.1 lists them. The user need not type them: §3.2 describes answering from documents.

### 3.1 The questions

**Owner decision Q10 (c), 10 Nov 2026:** keep all 67 onboarding questions. This table is the list, and the authority for its numbering. It counts one entry per distinct thing the user answers or chooses; a question asked once per workstream counts once, and conditional questions are included. Rows marked (+) are answers the types hold separately from the question they are asked with. "App only" marks answers that are human-only operations ([04 §4.3](04-platform.md#43-who-counts-as-the-user)), so a `profile.json` cannot carry them.

| # | Step | Question | Answer field |
|---|---|---|---|
| 1 | S1 | Workspace name | `workspace.displayName` |
| 2 | S1 | Time zone | `workspace.timeZone` |
| 3 | S1 | Work week | `workspace.workweek` |
| 4 | S1 | Working hours | `workspace.workingHours` |
| 5 | S1 | Protected blocks: times nothing may be booked into | `workspace.protectedBlocks` |
| 6 | S1 | (+) Is each block hard or soft? | `ProtectedBlock.policy` |
| 7 | S1 | Weekly time budget for meetings and reviews | `workspace.weeklyManagementMinutes` |
| 8 | S1 | Quiet hours | `workspace.quietHours` |
| 9 | S1 | Backup passphrase (skippable; app only) | `workspace.backup.passphraseSet` ([04 §9.1](04-platform.md#91-backups)) |
| 10 | S1 | Off-machine backup destination (skippable; app only) | `workspace.backup.destination` |
| 11 | S2 | "List everything you want to run here" | `workstreams[]` |
| 12 | S2 | Kind | `WorkstreamAnswers.kind` |
| 13 | S2 | Name | `WorkstreamAnswers.name` |
| 14 | S2 | Parent | `WorkstreamAnswers.parentKey` |
| 15 | S2 | Whose outcome is it? | `WorkstreamAnswers.principal` |
| 16 | S2 | (+) Your relationship to that person | `principal.relationship` |
| 17 | S2 | (+) Their consent | `principal.consentNote` (M3) |
| 18 | S2 | Time zone | `WorkstreamAnswers.timeZone`; `principal.timeZone` for another person |
| 19 | S3 | Headcount | `headcount` |
| 20 | S3 | Leadership group size | `leadershipGroupSize` |
| 21 | S3 | Teams under leads? | `hasTeamsUnderLeads` |
| 22 | S3 | Stage | `stage` |
| 23 | S3 | Business type | `businessType` |
| 24 | S3 | Primary goal | `primaryGoal` |
| 25 | S3 | Goal shape | `goalShape` |
| 26 | S3 | Deadline | `deadline` |
| 27 | S3 | Role type (job search only) | `roleType` |
| 28 | S3 | Target roles (job search only) | `targetRoles` |
| 29 | S3 | Existing framework | `existingFramework` |
| 30 | S3 | Keep the existing framework? | `keepExisting` |
| 31 | S3 | Weight preference | `weightPreference` |
| 32 | S3 | Confidentiality | `confidentiality` |
| 33 | S3 | Notes | `notes` |
| 34 | S4 | Accept the recommendation, or pick one of the two alternatives? | `accepted[]` |
| 35 | S5 | Q-T01 Day, time and length of each required meeting | `tailoring[].parameters` |
| 36 | S5 | Q-T02 Merge same-cadence meetings of workstreams you run alone? | `tailoring[].merge` |
| 37 | S5 | Q-T03 Scorecard lines | `tailoring[].measures` |
| 38 | S5 | Q-T04 First priorities, WIG or goals for this quarter | `tailoring[].goals` |
| 39 | S5 | Q-T05 How are decisions made? | `tailoring[].parameters["decision.method"]` |
| 40 | S5 | (+) Q-T05 Memo for one-way doors? | `tailoring[].parameters["decision.memoForOneWayDoors"]` |
| 41 | S5 | Q-T06 Who owns which area? | `tailoring[].owners` |
| 42 | S5 | Q-T07 How strict is review? | `tailoring[].verification` |
| 43 | S5 | Q-T08 When does an unfinished item escalate? | `tailoring[].escalation` |
| 44 | S5 | Q-T09 What may AI see for this workstream? | `tailoring[].aiDataPolicy` |
| 45 | S5 | Q-T10 Which grounding files define the candidate? | `tailoring[].groundingRefs` |
| 46 | S5 | Q-T11 Who is told when items close? | `tailoring[].informRoles` |
| 47 | S6 | Adjust the times in the composed weekly grid | `tailoring[].parameters` (re-validated) |
| 48 | S6 | Keep the daily start and daily shutdown? | `rhythm.dailyStart`, `rhythm.dailyShutdown` |
| 49 | S6 | Confirm a meeting in a soft block or outside working hours | `rhythm.acceptedOverlaps` |
| 50 | S6 | Over the time budget: which fix? (only if T1 fires) | `rhythm.timeBudgetFix` |
| 51 | S6 | A required meeting has no slot: change a time or a block (only if T2 fires) | `tailoring[].parameters` or `workspace.protectedBlocks` |
| 52 | S7 | Which tools do you use, by category? | `tools[].category`, `tools[].toolName` |
| 53 | S7 | Where does your team track tasks? (Jira / Linear / none → Google Sheet) (owner decision C2, 10 Nov 2026) | `tools[]` with category `task_tracker` |
| 54 | S7 | For which workstreams? | `tools[].workstreamKeys` |
| 55 | S7 | Account label (optional) | `tools[].accountLabel` |
| 56 | S7 | For each tool: a connector, *manual*, *find with AI* or *later*? | `tools[].choice` |
| 57 | S7 | Calendars: which calendars? | calendar mapping targets ([02 §9.6](02-rhythm-and-calendar.md#96-calendar-mapping-the-engines-choice-no-provider-code)) |
| 58 | S7 | Which workstreams sync where? | calendar mapping routes |
| 59 | S7 | (+) Is each calendar target the primary or a mirror? | calendar mapping `role` (one primary per series) |
| 60 | S8 | Which AI provider? | `ai.provider` |
| 61 | S8 | (+) A provider with no adapter: its name, for *find with AI* | `ai.discover.providerName` |
| 62 | S8 | Model | `ai.model` |
| 63 | S8 | Per-task routing (optional) | `ai.perTask` |
| 64 | S8 | Daily budget | `ai.dailyBudgetUsd` |
| 65 | S9 | Confirm the full preview of every record and every outward action | the commit itself (`apply` without `--dry-run`) |
| 66 | S9 | Approve the first calendar write batch (app only) | a `calendar_batch` confirmation ([04 §7.3](04-platform.md#73-confirmation-requests)) |
| 67 | S9 | Sign in to each service (app only) | bindings, signed in after commit ([05 §16](05-connectors.md#16-onboarding-tool-selection-step-s7-and-the-reference-scenario) item 3) |

By step: S1 10, S2 8, S3 15, S4 1, S5 12, S6 5, S7 8, S8 5, S9 3.

### 3.2 Answering from documents, and the sample profile

**Owner decision Q10 (c), 10 Nov 2026**, in the owner's words: "Build a sample profile as essay that answers all the 67 questions. Allow upload of that via one or many documents, so that the user does not have to type all of this, instead approve what we infer from the docs. change only when necessary."

1. **Inferring answers from documents needs the AI layer, which arrives in P3.** The user uploads one or more documents (an essay like the sample profile, notes, an existing plan). The `extractor` profile ([04 §6.4](04-platform.md#64-agent-profiles)) infers answers to the §3.1 questions from them. Every inferred answer carries `suggested: true` until the user accepts it, and a profile with an unaccepted suggestion cannot be committed (C-01-08, rule 2). The wizard shows the inferred answers step by step; the user approves them and changes only what is wrong. The recommender still never sees an unaccepted suggestion (C-01-02). This is a P3 task ([09 §8](09-build-plan.md#8-p3-ai-orchestrator), P3-05).
2. **Before P3, onboarding is either manual entry** in the wizard (P1-12), **or the deterministic import of a structured profile:** `cc-axi onboarding apply --file profile.json [--dry-run]` (C-01-07). No AI is involved: the file is a complete `OnboardingProfile` (§4), checked like any other answers. The app-only answers of §3.1 (rows 9, 10, 66 and 67) are given in the app after the import.
3. **The sample profile** is the reference scenario's answers, as two fixtures:
   - `fixtures/onboarding/sample-profile.md`: an essay in the scenario owner's voice that answers all 67 questions, with a map from each §3.1 row to the answering sentence. Facts the design does not state are invented filler, marked **[sample]**. It is the test input of the P3 extractor (AC-01-11).
   - `fixtures/onboarding/sample-profile.json`: the same answers as an `OnboardingProfile`, for `apply --file` in P1 (AC-01-10). It holds the answers a `profile.json` can carry: not the app-only rows, and not the calendar answers (rows 57 to 59), which live in the engine's calendar mapping ([02 §9.6](02-rhythm-and-calendar.md#96-calendar-mapping-the-engines-choice-no-provider-code)). Its tool choices name the connectors of [05 §16](05-connectors.md#16-onboarding-tool-selection-step-s7-and-the-reference-scenario); a tool whose connector is not yet in `connectors.lock` is recorded as *manual*, as at S7 before P2 ([09 §6](09-build-plan.md#6-p1-mvp-register-and-rhythm)). No person other than the user is a workstream principal; the client contact appears only as a role, never by name.
4. The design does not yet say how `suggested: true` is stored on an answer in `OnboardingProfile`; that is settled with P3-05.

### 3.3 The commit, as P1-12 builds it

How the foundation reads the answers at S6 and S9 (09 P1-12). The code is `packages/core/src/onboarding/`; these are the readings it encodes where the sections above leave a choice.

1. **Where the answers live.** The `onboarding` table holds one row per workspace (§9.1 rule 1; 03 §12): the answers, the S7 calendar mapping when the engine has none ([02 §9.6](02-rhythm-and-calendar.md#96-calendar-mapping-the-engines-choice-no-provider-code) rule 2), and `committedAt`. The local API methods are `onboarding.status`, `onboarding.save` (the answers after each step; it writes no other record, C-01-01), `onboarding.recommend`, `onboarding.preview` (`apply --dry-run`; scope `read`), `onboarding.apply` (scope `onboarding:apply`, C-01-07) and `onboarding.export`. Rows 9 and 10 are the human-only `backups.passphrase` and `backups.destination` ([04 §4.3](04-platform.md#43-who-counts-as-the-user)); the passphrase itself stays in the main process's secret store ([04 §9.1](04-platform.md#91-backups) rule 3).
2. **Missing answers.** A workstream with no S4 answer takes the recommendation, as accepting it does; with no S5 answers, the template's defaults for its mode and the §8 defaults. S6 answers default to keeping the daily start and shutdown, with no confirmed overlap.
3. **The composed rhythm (S6).** The meetings start on the Monday after the commit date (README §4). Each instance's required backbone meetings, and the optional ones whose `<key>.enabled` parameter is on, become series: the weekly meeting at `weekly.weekday`, `weekly.time` and `weekly.duration`; the monthly one on the same weekday and time in the first or last week of the month (`monthly.week`), the `eos-lite` monthly review absorbing that week's weekly meeting with 30 minutes ([02 §5.2](02-rhythm-and-calendar.md#52-agendaeos-litemonthly1-90-min-standalone)); the quarterly one in March, June, September and December, in the week `quarterly.weekOfQuarter` counts from the month's end; the yearly one on the second such weekday of December. A quarterly or yearly session starts at the first of these times at which its first session fits in working hours, clear of hard blocks and of the other meetings that day: the weekly meeting's time, the start of each soft block, the start of each working-hours range. A start inside a soft block needs the user's confirmation (row 49). The daily start runs at the start of the first working-hours range and the daily shutdown ten minutes before its end. Merged workstreams (M8, kept by Q-T02) share one series per meeting, timed by the first of them. This reproduces [02 §8.1](02-rhythm-and-calendar.md#81-series-all-times-ist-asiakolkata) from the scenario's answers.
4. **What blocks the commit.** No workstream; a meeting in a hard block, or in a soft block or outside working hours without the user's confirmation; T1 with no fix picked; T2; and a broken backbone invariant about the meetings (E-1, E-8, PO-1, PO-4, X-3). The invariants about content the user fills in as the rhythm runs (scorecard size and targets, priority count and done-means, the WIG's shape) are warnings at the commit, because §3 S5 creates goals as drafts and lets a scorecard line's target be "per plan" (C-01-03 still runs every validator; their results are shown).
5. **A scorecard line with no target** stays in the answers and becomes a `Measure` once it has one: `Measure.target` is required ([03 §5.4](03-decisions-and-action-items.md#54-measure-and-measurevalue)). The preview lists it as `W-DEFERRED`.
6. **T1's fixes** (§6.4) change only what they name: `merge` keeps every M8 group merged, `shorten` sets every meeting to its backbone minimum, `biweekly` makes `personal-os` weekly reviews every other week, `raise_budget` raises the budget to the rounded-up average. The preview shows the result; the commit is no longer blocked once one is picked.
7. **S7 and S8 before P2 and P3.** Connector bindings, the AI provider configuration and the backup policy have no record type yet, so those answers stay in the onboarding record. The preview lists the outward actions they lead to (sign-ins, the first calendar batch, discovery), each confirmed on its own later (C-01-01).
8. **People.** Onboarding does not ask the user's name: the user's `Person` is "Self". A role token other than `self` (an owner or a goal's owner, row 41) becomes a `Person` of its own; a bracketed token such as `[Client contact]` an `external` one.

## 4. Types

```ts
type OnboardingStep =
  | 'workspace' | 'workstreams' | 'profiles' | 'recommendation'
  | 'tailoring' | 'rhythm' | 'tools' | 'ai' | 'commit';

type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

interface OnboardingProfile {
  version: number;                       // incremented on every committed change
  completedSteps: OnboardingStep[];
  workspace: WorkspaceAnswers;
  workstreams: WorkstreamAnswers[];
  tools: ToolAnswer[];
  ai: AiAnswers;
  tailoring?: TailoringAnswers[];              // S5 answers, one per workstream with its own framework instance
  rhythm?: RhythmAnswers;                      // S6 answers
  recommendations?: FrameworkRecommendation[]; // output of S4, kept for audit
  accepted?: AcceptedFramework[];              // output of S4 after user choice
}

interface WorkspaceAnswers {
  displayName: string;                   // e.g. "Main"
  timeZone: IanaTimeZone;                // e.g. "Asia/Kolkata"
  workweek: Weekday[];
  workingHours: { start: string; end: string }[]; // "HH:mm" local
  protectedBlocks: ProtectedBlock[];
  weeklyManagementMinutes: number;       // budget for all meetings and reviews
  quietHours: { start: string; end: string }[];
  backup?: { destination?: BackupDestination; passphraseSet: boolean };   // 04 §9.1; the passphrase itself is never stored
}

/** A time window that rhythm scheduling must respect. Owned by this file; used by 02. */
interface ProtectedBlock {
  id: string;
  label: string;                          // shown in UI; never sent to calendar events
  rrule: string;                          // RFC 5545 RRULE, local to timeZone; the ADR 0001 subset (decision 4)
  timeZone: IanaTimeZone;
  durationMinutes: number;
  policy: 'hard' | 'soft';                // hard: never schedule; soft: warn and require confirmation
}

type WorkstreamKind =
  | 'company' | 'business_unit' | 'client_engagement' | 'project'
  | 'job_search' | 'personal' | 'other';

interface WorkstreamAnswers {
  key: string;                            // slug, unique in profile, e.g. "alderwick"
  kind: WorkstreamKind;
  name: string;
  parentKey?: string;                     // client_engagement/project under a company
  principal:
    | { kind: 'self' }
    | { kind: 'other'; displayName: string; relationship: string;
        timeZone: IanaTimeZone; consentNote: string };
  timeZone?: IanaTimeZone;                // S2; default: principal.timeZone for another person, else the workspace's
  headcount: number;                      // people doing the work, incl. the user; >= 1
  leadershipGroupSize: number;            // people who would attend a weekly leadership meeting; >= 1
  hasTeamsUnderLeads: boolean;
  stage: 'idea' | 'pre_revenue' | 'early_revenue' | 'growth' | 'mature' | 'n_a';
  businessType: 'services' | 'product' | 'ecommerce' | 'mixed_services_product' | 'nonprofit' | 'n_a';
  primaryGoal: 'launch' | 'grow_revenue' | 'profitability' | 'stabilise' | 'land_role' | 'habit' | 'other';
  goalShape: 'one_dominant_outcome' | 'few_priorities' | 'many_streams';
  deadline?: LocalDate | null;            // for one dominant outcome
  roleType?: 'full_time' | 'fractional' | 'contract' | 'any'; // job_search only
  targetRoles?: string[];                 // job_search only
  existingFramework: 'none' | 'eos' | 'okr' | '4dx' | 'scaling_up' | 'other';
  keepExisting?: boolean;
  weightPreference: 'light' | 'standard' | 'full';
  confidentiality: 'normal' | 'sensitive';
  notes?: string;                         // free text; AI may suggest values from it
}

type ToolCategory =
  | 'calendar' | 'email' | 'chat' | 'social' | 'social_scheduler' | 'cms' | 'crm'
  | 'hosting' | 'code' | 'docs' | 'time_tracking' | 'analytics' | 'job_board'
  | 'accounting' | 'task_tracker' | 'other';   // task_tracker: the team's tasks (Jira, Linear, a Google Sheet); owner decision C2, 10 Nov 2026

interface ToolAnswer {
  workstreamKeys: string[];
  category: ToolCategory;
  toolName: string;                       // as the user names it, e.g. "Hostinger"
  accountLabel?: string;                  // e.g. "alderwick mailbox"
  choice:
    | { kind: 'connector'; connectorId: string }   // registry id, see 05
    | { kind: 'manual' }                           // the user does these steps by hand
    | { kind: 'discover' }                         // start 06 for this tool: consent to public research only
    | { kind: 'later' };
}

/** S5 answers (§8). Added with owner decision Q10 (10 Nov 2026), so that a profile.json can carry
 *  every answer that is not app-only (§3.1, §3.2). People appear as role tokens: "self", "[Client contact]". */
interface TailoringAnswers {
  workstreamKey: string;
  parameters: Record<string, unknown>;    // Q-T01, Q-T05: ParameterSpec keys of the accepted template (§5),
                                          // e.g. "weekly.time"; checked against bounds (C-01-04)
  merge?: boolean;                        // Q-T02: keep the merge group of M8; default true
  measures: {                             // Q-T03; the fields of Measure (03 §5.4)
    ref?: string;                         // "K-0001", when the line is already known
    name: string; role: 'lead' | 'lag'; unit: Measure['unit']; currency?: string;
    cadence: Measure['cadence']; target?: Measure['target'];   // no target: "per plan", set later
    ownerRole: string; source: 'manual' | 'derived';            // connector sources are set once a binding exists
    workstreamKeys?: string[];            // a line shared across a merged review, e.g. K-0006
  }[];
  goals: {                                // Q-T04, created as drafts
    title: string; kind: GoalKind; ownerRole: string; doneMeans?: string;
    target?: { from: number; to: number; unit: string; by: LocalDate | null };   // null: "confirm with" the principal
  }[];
  owners: Record<string, string>;         // Q-T06: area → role token; solo: { "*": "self" }
  verification: { policy: 'require_review' | 'auto_close_on_checks';
                  autoCloseOn: ('calendar_event' | 'measure_threshold')[] };     // Q-T07 (03 §9.4)
  escalation: { e2CarryCount: number; e3CarryCount: number; e3OverdueDays: number };   // Q-T08 (02 §7.2)
  aiDataPolicy: 'allow' | 'redact_people' | 'deny';                                     // Q-T09
  groundingRefs?: { kind: 'profile' | 'rubric' | 'writing_style' | 'master_resume'; path: string | null }[]; // Q-T10; null: to be written
  informRoles: string[];                  // Q-T11
}

/** S6 answers. */
interface RhythmAnswers {
  dailyStart: boolean;                    // portfolio series (02 §4.5)
  dailyShutdown: boolean;
  acceptedOverlaps: { workstreamKey: string; meetingKey: string; blockId?: string;
                      reason: 'soft_block' | 'outside_working_hours' }[];
  timeBudgetFix?: 'merge' | 'shorten' | 'biweekly' | 'raise_budget';             // only when T1 fires (§6.4)
}

type AiTaskType = 'draft' | 'extract' | 'plan' | 'review' | 'summarize' | 'discover' | 'tailor';

interface AiAnswers {
  provider: ProviderId | 'none';           // an installed adapter ID (04 §6.2): 'claude_cli', 'anthropic_api', 'openai',
                                          // 'codex_cli' once that adapter ships; 'none' runs no AI steps
  discover?: { providerName: string };     // a provider with no adapter: queue a draft request (06 §3)
  model?: string;                          // see 04 §6 for defaults
  perTask?: Partial<Record<AiTaskType, { provider: AiAnswers['provider']; model?: string; effort?: string }>>;
  dailyBudgetUsd?: number;
}
```

Framework templates and instances:

```ts
type FrameworkId = 'personal-os' | '4dx' | 'eos-lite' | 'eos' | 'okr' | 'scaling-up' | `custom:${string}`;
type GoalModel = 'personal_goals' | 'wig' | 'rocks' | 'okr' | 'priorities';
type Cadence = 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';
type PackId = `pack.${string}`;          // pack.<name>, a lower-case slug; engines add custom packs (08 §4.1)
// The six packs of v1 (§5.5):
//   'pack.marketing' | 'pack.client-services' | 'pack.product'
//   | 'pack.job-search' | 'pack.job-search-fractional' | 'pack.personal'

interface FrameworkTemplate {
  id: FrameworkId;
  version: string;                         // semver; instances pin it
  name: string;
  summary: string;
  appliesTo: WorkstreamKind[];
  sources: { label: string; ref: string }[];   // where the backbone comes from
  backbone: {
    goalModel: GoalModel;
    meetings: BackboneMeeting[];
    invariants: Invariant[];
  };
  parameters: ParameterSpec[];
  extensionSlots: string[];                // agenda positions where packs may add sections
  defaultPacks: PackId[];
  vocabulary: Record<'goal' | 'action' | 'issue' | 'measure' | 'meeting', string>;
  forkedFrom?: { templateId: FrameworkId; version: string }; // set for custom:* only (§9 level 5)
}

interface BackboneMeeting {
  key: string;                              // e.g. "weekly"
  cadence: Cadence;
  agendaTemplateId: string;                 // defined in 02 §5
  required: boolean;
  modes: ('solo' | 'team')[];               // modes in which this meeting exists
  durationMinutes: { min: number; default: number; max: number;
                     defaultByMode?: { solo?: number; team?: number } };   // e.g. eos-lite yearly: solo 240
}

interface Invariant {
  id: string;                               // e.g. "E-3"
  text: string;                             // human-readable rule
  validator: string;                        // name of a function in packages/frameworks/validators
  appliesWhen?: { mode?: 'solo' | 'team' };
}

interface ParameterSpec {
  key: string;                              // e.g. "weekly.weekday"
  type: 'int' | 'duration_minutes' | 'weekday' | 'time_of_day' | 'enum' | 'bool' | 'string';
  default: unknown;
  defaultByMode?: { solo?: unknown; team?: unknown };   // e.g. eos-lite conclude.rating: solo false
  min?: number; max?: number; enum?: string[];
  description: string;
}

interface FrameworkInstance {
  id: FrameworkInstanceId;
  workstreamId: WorkstreamId;
  templateId: FrameworkId;
  templateVersion: string;
  mode: 'solo' | 'team';
  goalModel: GoalModel;
  packIds: PackId[];
  parameters: Record<string, unknown>;      // validated against ParameterSpec bounds
  vocabularyOverrides: Partial<FrameworkTemplate['vocabulary']>;
  seriesIds: MeetingSeriesId[];             // 02
  validatedAt: UtcTimestamp;                // last successful invariant check
  forkedFrom?: { templateId: FrameworkId; version: string }; // set for custom:*
}

interface FrameworkRecommendation {
  workstreamKey: string;
  templateId: FrameworkId;
  mode: 'solo' | 'team';
  goalModel: GoalModel;
  packIds: PackId[];
  firedRules: string[];                     // e.g. ["R8", "M2", "M4", "M5", "M6", "M7"]
  rationale: string[];                      // one line per fired rule, generated from rule text
  alternatives: { templateId: FrameworkId; whyNot: string }[]; // exactly 2
  warnings: { code: string; text: string }[];
  parameterDefaults: Record<string, unknown>;
  mergeGroup?: string;                      // see M7 and 02 §4.4
  privacy: 'normal' | 'sensitive';
  aiDataPolicy: 'allow' | 'redact_people' | 'deny';
  recommenderVersion: string;               // semver of the rule tables (C-01-02)
}

interface AcceptedFramework {
  workstreamKey: string;
  templateId: FrameworkId;                  // recommended or an alternative chosen by the user
  acceptedAt: UtcTimestamp;
  overrodeRecommendation: boolean;
}
```

Packs carry domain content. They are never part of the backbone:

```ts
interface Pack {
  id: PackId;
  version: string;
  title: string;
  measureTemplates: { key: string; name: string; unit: Measure['unit']; role: 'lead' | 'lag';
                      cadence: Cadence; defaultTarget?: { op: 'gte' | 'lte' | 'eq'; value: number } }[];
  agendaSections: { slot: string; sectionTemplateId: string }[]; // added into extension slots (02)
  actionTemplates: ActionTemplate[];       // 03 §8.4
  recurringItems: { templateId: string; rrule: string; timeZone?: IanaTimeZone }[];
  connectorSuggestions: { category: ToolCategory; connectorIds: string[] }[];
  rules: string[];                          // e.g. job-search trust rules (02 §5.5); also pipeline stages, which have no field of their own
}
```

Storage: templates and packs are YAML files at `packages/frameworks/templates/<id>/<version>.yaml` and `packages/frameworks/packs/<id>/<version>.yaml`. A `custom:<name>` template lives at `templates/custom/<name>/<version>.yaml`, because a colon is not a valid file name character on Windows. They are validated against JSON Schemas generated from the types above. Validators are named functions in `packages/frameworks/validators/` ([08](08-repository-and-automation.md)).

## 5. Framework catalogue

Every backbone below cites where it comes from. Facts about EOS, OKRs and Scaling Up come from the workie research report `regime/ceo-operating-cadence.md` (§1.3, §5 and §7). That report cites each framework's own pages. `personal-os` is this design's own light template, derived from the routine in `regime/plan.md` (§3, §5).

### 5.1 `personal-os` v1 (light personal version, ships in P1)

For one person running life areas, or any workstream that needs only a weekly loop.

| Backbone | Value |
|---|---|
| Goal model | `personal_goals`, set quarterly |
| Meetings | `weekly` review (required, 30/45/90 min), `daily` plan (optional, 5/10/15), `monthly` review (optional, 30/60/90), `quarterly` reset (required, 60/90/180) |
| Vocabulary | goal = Goal, action = Action, issue = Snag, measure = Measure, meeting = Review |

Invariants:

- **PO-1** Exactly one active weekly review series covers each personal-os workstream. Several workstreams may share one review.
- **PO-2** 1 to `maxGoals` active goals per workstream per quarter (`maxGoals` from 1 to 3, default 3).
- **PO-3** Every goal has a done-means or at least one measure.
- **PO-4** The weekly review agenda order is `check_in` → `scorecard` → `goals_review` → `action_review` → `plan_commitments` (top 3 for next week) → `conclude`.
- **PO-5** Every action item has one owner and a due date (also enforced globally by INV-03-01 and INV-03-04).

Parameters: `weekly.weekday` (default `FR`), `weekly.time` (default 16:00), `weekly.duration`, `daily.enabled`, `daily.time`, `monthly.enabled`, `maxGoals`.

### 5.2 `4dx` v1 (ships in P1)

Source: C. McChesney, S. Covey and J. Huling, *The 4 Disciplines of Execution* (Free Press, 2012), and FranklinCovey's 4DX material. This design uses only these elements of it: the four disciplines (focus on the wildly important; act on lead measures; keep a compelling scoreboard; create a cadence of accountability), the WIG form "from X to Y by when", lead and lag measures, and a short weekly WIG session. Each element was checked against FranklinCovey's own pages on 11 Nov 2026 and holds (OQ-01-04, closed): the four disciplines by name ([The 4 Disciplines](https://www.franklincovey.com/courses/the-4-disciplines/)); lag measures "track the success of your wildly important goal" and lead measures "predict the success of the lag measure and are influenced directly by the team" ([Discipline 2](https://www.franklincovey.com/courses/the-4-disciplines/discipline-2-act/)); a WIG "is defined using the 'From X to Y by When' format" ([team goals](https://www.franklincovey.com/blog/team-goals/)); "you can only focus on one or two Wildly Important Goals at once" ([business objectives](https://www.franklincovey.com/blog/business-objectives/)); and the weekly session in which each person reports whether they "met last week's commitments", looks at the scoreboard, and commits to "the one or two most important things I can do this week" ([Discipline 4](https://www.franklincovey.com/courses/the-4-disciplines/discipline-4-accountability/)).

| Backbone | Value |
|---|---|
| Goal model | `wig`: a Wildly Important Goal stated as from X to Y by a date |
| Meetings | `weekly` WIG session (required, 15/30/45 min). FranklinCovey says the session should "ideally last no more than 20 minutes" (a FranklinCovey blog says "typically 20–30 minutes"); this design keeps 30 as the default, since a solo session also holds a pack section such as `pipeline_review` (owner decision, 11 Nov 2026) |
| Vocabulary | goal = WIG, action = Commitment, issue = Obstacle, measure = Lead/Lag measure, meeting = WIG session |

Invariants:

- **X-1** 1 or 2 active WIGs per workstream. Each WIG has `target.from`, `target.to`, `target.unit` and `target.by`.
- **X-2** Each WIG has 1 to 3 lead measures (role `lead`, weekly cadence, one owner, a target) and exactly one lag measure that tracks the WIG itself.
- **X-3** Exactly one weekly WIG-session series per workstream. Agenda order: `action_review` (account for last week's commitments) → `scorecard` (lead and lag) → `plan_commitments` (new commitments) → `conclude`.
- **X-4** A commitment is an action item with one owner, due before the next session (a 7-day horizon), and linked to the WIG.
- **X-5** Before each session, every lead measure has a value for the period that just ended, or the missing value is flagged in the pre-read.

Parameters: `weekly.weekday` (default `MO`), `weekly.time` (default 13:15), `weekly.duration`, `commitmentsPerOwnerPerWeek` (1 to 5, default 3; FranklinCovey asks each person for "the one or two most important things" a week, and this design keeps a default of 3, owner decision 11 Nov 2026), `leadMeasureCount` (1 to 3, default 2).

### 5.3 `eos-lite` v1 (EOS-style, fewer than 10 people, ships in P1)

Source: the light system in `regime/ceo-operating-cadence.md` §5. That report adapts EOS's Level 10 meeting and Rocks (S6, S7) to a founder-led company. EOS itself is sized for "roughly 10 to 250 employees" (S31), which is why the full `eos` template starts at 10 people.

| Backbone | Value |
|---|---|
| Goal model | `rocks`: quarterly priorities |
| Meetings | `weekly` leadership meeting (required, 45/60/90 min), `monthly` money and operations review (required, 60/90/120), `quarterly` planning (required, 120/240/480), `yearly` review and plan (required, 240/480/480; solo default 240), `daily` check-in (optional, team mode only, 5/10/15). Duration triples are min/default/max. |
| Vocabulary | goal = Priority, action = To-do, issue = Issue, measure = Scorecard line, meeting = Meeting |

Invariants:

- **E-1** Exactly one weekly leadership meeting per workstream, or one block for it inside a merged meeting (02 §4.4). It has a fixed weekday and time. Agenda order: `check_in` → `scorecard` → `goals_review` → `action_review` → `headlines` → `issues` → `conclude`.
- **E-2** The scorecard has 5 to 15 active weekly measures. Each has one owner and a target, and is read every week as *normal* or *not normal*. In solo mode the minimum is 3.
- **E-3** 1 to `priorityCount` quarterly priorities per workstream (bounds 1 to 5, default 3). Each has one owner and a done-means, and is graded done or not done at quarterly planning (never "90% done").
- **E-4** Each to-do has one owner, a due date at most `todoHorizonDays` after creation (7 to 14, default 7) and a done-means. Longer work must link to a priority or be split.
- **E-5** `action_review` records only done or not done. Misses move to `issues`, with no discussion inside `action_review`.
- **E-6** Every issue resolved in `issues` ends as a decision, as one or more action items, or as an explicit drop with a note.
- **E-7** Every decision has exactly one decider (also INV-03-02).
- **E-8** The monthly review includes register health: share of items closed on time, items rolled over twice or more, and the oldest open item.

Parameters: `weekly.weekday` (default `FR`), `weekly.time` (default 15:00), `weekly.duration`, `monthly.week` (`first` or `last`), `quarterly.weekOfQuarter` (-1 or -2), `priorityCount`, `todoHorizonDays`, `conclude.rating` (bool, default true in team mode and false in solo mode), `decision.method` (`single_decider` or `daci`), `decision.memoForOneWayDoors` (bool, default true).

### 5.4 Later templates (backbone only, ship in P7)

| Template | For | Backbone (fixed) | Source |
|---|---|---|---|
| `eos` | Companies with 10 to 250 people | 90-minute weekly Level 10 meeting with a fixed agenda (Segue 5, Scorecard 5, Rock review 5, Headlines 5, To-do list 5, IDS 60, Conclude 5); 3 to 7 Rocks per quarter, one owner each, graded done or not done; scorecard; issues solved by IDS; quarterly and annual sessions | regime report §1.3 and §7.2 (S6, S7, S31) |
| `okr` | Teams that set goals as objectives and key results | Quarterly cycle; each objective has measurable, verifiable key results with one owner; graded at cycle end; committed KRs graded pass or fail, aspirational KRs scored (40 to 70 percent counts as good); weekly check-in | regime report §1.3 (S15, S16) |
| `scaling-up` | Growth companies (about 50 people and up), full weight | Meeting rhythm: daily huddle of 15 minutes or less, weekly, monthly, quarterly, annual; One-Page Strategic Plan; the four decisions People, Strategy, Execution, Cash reviewed quarterly | regime report §1.1 and §7.2 (S19, S32) |

Their parameter sets are defined when they are built, under the same schema.

### 5.5 Packs (v1)

| Pack | Adds | Used by (scenario) |
|---|---|---|
| `pack.marketing` | Content pipeline items (idea → draft → review → schedule → publish → reuse, from `regime/plan.md` §4.3); measures for posts published against plan per channel and blogs shipped on time; a `content_review` section in the weekly meeting | Alderwick, Quillmarsh |
| `pack.client-services` | Measures: client hours logged against plan, client milestones on time, invoices raised, overdue receivables; the money and operations inputs for the monthly review | Alderwick |
| `pack.product` | Measures: shipped against planned (weekly yes/no), active users or pilots; a go/kill/hold item per product bet at quarterly planning | Quillmarsh |
| `pack.job-search` | Pipeline stages (sourced → shortlisted → tailored → applied → screening → interview → offer → closed); lead measures for qualified applications and outreach notes sent; lag measure for interviews; a `pipeline_review` section; job-search trust rules (02 §5.5) | not in the reference scenario |
| `pack.job-search-fractional` | The same as `pack.job-search`, but the lead measures are warm conversations, discovery calls and proposals sent, and the pipeline stages are conversation → discovery → proposal → engagement | not in the reference scenario |
| `pack.personal` | Habit and learning measures | (none in the scenario) |

## 6. Decision tree: inputs, rules, outputs

### 6.1 Inputs

For each workstream `w`: every field of `WorkstreamAnswers`, plus the tool answers (`ToolAnswer`) whose `workstreamKeys` include `w.key`. At workspace level: `weeklyManagementMinutes`, `protectedBlocks`, `workweek`. `today` is the commit date in the workspace time zone. Normalisation runs before the rules:

- `h = max(1, headcount)`. A contractor counts as 1 if they work at least one day a week.
- `l = max(1, leadershipGroupSize)`.
- `deadlineDays = deadline ? days(deadline - today) : null`.

### 6.2 Base rules (evaluate in order; the first match selects the base template)

| Rule | Condition | Base template |
|---|---|---|
| R1 | `keepExisting == true` and `existingFramework` is in {`eos`, `okr`, `4dx`, `scaling_up`} | that framework (if it is not yet built: the closest built one, plus warning `W-NOT-BUILT`) |
| R2 | `kind == 'job_search'` | `4dx` |
| R3 | `goalShape == 'one_dominant_outcome'` and `deadlineDays != null` and `deadlineDays <= 365` | `4dx` |
| R4 | `kind == 'personal'` | `personal-os` |
| R5 | `kind` is `client_engagement` or `project`, and `parentKey` is set | inherit the parent's instance: no own meetings; a block in the parent's weekly meeting (02 §4.4) |
| R6 | `kind` is `company` or `business_unit`, and `h >= 50` | `scaling-up` if `weightPreference == 'full'` or `hasTeamsUnderLeads`, else `eos` |
| R7 | `kind` is `company` or `business_unit`, and `10 <= h < 50` | `eos-lite` if `weightPreference == 'light'`, else `eos` |
| R8 | `kind` is `company` or `business_unit`, and `h < 10` | `eos-lite` |
| R9 | otherwise | `personal-os` |

Availability rule: if any rule selects a template that is not built in the running release (`eos`, `okr` and `scaling-up` before P7), `templateId` is the closest built template (`eos` and `scaling-up` become `eos-lite`; `okr` becomes `4dx`). `firedRules` still names the rule, and warning `W-NOT-BUILT` names the template the rule selected.

### 6.3 Modifiers (apply every match, in order)

| Rule | Condition | Effect |
|---|---|---|
| M1 | base is `eos` or `scaling-up`, `hasTeamsUnderLeads`, and (`businessType == 'product'` or `existingFramework == 'okr'`) | `goalModel = 'okr'` (OKRs per team under the company backbone) |
| M2 | `l <= 1` | `mode = 'solo'`, otherwise `'team'` |
| M3 | `principal.kind == 'other'` or `confidentiality == 'sensitive'` | `privacy = 'sensitive'`; `aiDataPolicy = 'redact_people'`; outward steps on the principal's behalf need a recorded consent (`Person.consents`, 03 §5.1) |
| M4 | base came from R2 | add `pack.job-search-fractional` if `roleType == 'fractional'`, else `pack.job-search` |
| M5 | `kind == 'company'` and `businessType` is `services` or `mixed_services_product` | add `pack.client-services` |
| M6 | `kind == 'company'` and `businessType` is `product` or `mixed_services_product` | add `pack.product` |
| M7 | the workstream has a tool in category `social`, `social_scheduler` or `cms` | add `pack.marketing` |
| M8 | `base == 'eos-lite'`, `mode == 'solo'`, and another workstream with the same steward is also `eos-lite` solo | `mergeGroup = 'weekly-ceo-review'` (one merged weekly meeting, 02 §4.4) |

### 6.4 Workspace post-check

- **T1** If the composed rhythm's average weekly minutes exceed `weeklyManagementMinutes`, emit warning `W-TIME-BUDGET`. The average counts every daily, weekly, biweekly and monthly instance over the 52 weeks from the rhythm's start, with absorption applied (02 §4.3: an absorbed instance counts 0, the absorbing one its longer length), divided by 52; quarterly and yearly sessions are not counted. This is the reading that gives the §7.3 figures, 160 minutes and about 174 with absorption (owner decision, 11 Nov 2026). It offers, in order: merge more meetings, shorten meetings to their backbone minimums, move `personal-os` weekly reviews to biweekly, or raise the budget. The user picks one. CC never applies a fix silently.
- **T2** If any required backbone meeting cannot be placed outside `hard` protected blocks within working hours on any workweek day, emit `W-NO-SLOT` and stop the commit until the user changes a time or a block.

### 6.5 Outputs

One `FrameworkRecommendation` per workstream (type in §4). `alternatives` always holds the two next-best templates from this order: same size band, one band lighter, `personal-os`. Each has a one-line `whyNot`. `rationale` holds one line per fired rule, rendered from the rule table text. No AI is involved.

### 6.6 Properties

1. Pure: `recommend(profile, today)` has no I/O and is deterministic.
2. Total: every valid profile produces exactly one recommendation per workstream.
3. Explainable: `firedRules` and `rationale` reproduce the path through §6.2 and §6.3.
4. Tested: the table-driven tests in `packages/frameworks/test/recommend.test.ts` cover every rule and every modifier at least once, plus the scenario fixture (AC-01-01).

## 7. Reference scenario walk-through

### 7.1 Answers (fixture `fixtures/onboarding/scenario.json`, abbreviated)

```json
{
  "version": 1,
  "workspace": {
    "displayName": "Main",
    "timeZone": "Asia/Kolkata",
    "workweek": ["MO", "TU", "WE", "TH", "FR"],
    "workingHours": [{ "start": "09:00", "end": "17:30" }, { "start": "18:00", "end": "23:00" }],
    "protectedBlocks": [
      { "id": "pb_evening", "label": "Evening block", "rrule": "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=18;BYMINUTE=0", "timeZone": "Asia/Kolkata", "durationMinutes": 300, "policy": "hard" },
      { "id": "pb_break", "label": "Afternoon break", "rrule": "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=14;BYMINUTE=0", "timeZone": "Asia/Kolkata", "durationMinutes": 60, "policy": "hard" },
      { "id": "pb_deep_a", "label": "Deep block A", "rrule": "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=45", "timeZone": "Asia/Kolkata", "durationMinutes": 180, "policy": "soft" }
    ],
    "weeklyManagementMinutes": 240,
    "quietHours": [{ "start": "23:30", "end": "08:00" }]
  },
  "workstreams": [
    { "key": "alderwick", "kind": "company", "name": "Alderwick", "principal": { "kind": "self" },
      "headcount": 1, "leadershipGroupSize": 1, "hasTeamsUnderLeads": false,
      "stage": "early_revenue", "businessType": "mixed_services_product",
      "primaryGoal": "grow_revenue", "goalShape": "few_priorities",
      "existingFramework": "none", "weightPreference": "light", "confidentiality": "normal" },
    { "key": "quillmarsh", "kind": "company", "name": "Quillmarsh", "principal": { "kind": "self" },
      "headcount": 1, "leadershipGroupSize": 1, "hasTeamsUnderLeads": false,
      "stage": "pre_revenue", "businessType": "product",
      "primaryGoal": "launch", "goalShape": "few_priorities",
      "existingFramework": "none", "weightPreference": "light", "confidentiality": "normal" }
  ]
}
```

The headcount of 1 for both companies follows `regime/plan.md` §2 ("You, mostly alone"). `regime/ceo-operating-cadence.md` assumes "a founder-CEO, a few leads" instead. See OQ-01-01. Neither company has a parent, another person as principal, or a sensitive answer, so R5 and M3 do not fire in the scenario. The fixture also holds the S6 answers the listing leaves out: the daily start and shutdown kept, and the confirmed overlaps of the quarterly and annual sessions with the soft "Deep block A" ([02 §8.1](02-rhythm-and-calendar.md#81-series-all-times-ist-asiakolkata)). All names in the scenario are fictional. Job search is not part of the scenario (README §4).

### 7.2 Recommendations

| Workstream | Fired rules | Template, mode | Packs | Notes |
|---|---|---|---|---|
| Alderwick | R8, M2, M5, M6, M7, M8 | `eos-lite`, solo | client-services, product, marketing | `mergeGroup = weekly-ceo-review` |
| Quillmarsh | R8, M2, M6, M7, M8 | `eos-lite`, solo | product, marketing | `mergeGroup = weekly-ceo-review` |

### 7.3 Composed weekly rhythm (S6)

All times are IST. Section 02 §8 has the full series table.

| Meeting | When | Minutes per week |
|---|---|---|
| Daily start (all workstreams) | Mon to Fri 09:00-09:10 | 50 |
| Daily shutdown (all workstreams) | Mon to Fri 17:20-17:30 | 50 |
| Weekly CEO review (Alderwick and Quillmarsh merged, `eos-lite`) | Fri 15:00-16:00 | 60 |
| **Total** | | **160** (budget 240, so T1 passes) |

On the last Friday of each month, the monthly review absorbs the weekly CEO review. That instance runs 90 + 30 = 120 minutes, 15:00-17:00 (02 §4.3), so the average rises to about 174 minutes a week, still within budget. Quarterly planning is a half-day on the second-to-last Friday of each quarter (Fri 2026-12-18 for Q1 2027). The annual review is Fri 2026-12-11.

## 8. Tailoring questions (S5)

| ID | Question | Applies to | Type and bounds | Scenario default |
|---|---|---|---|---|
| Q-T01 | Day, time and length of each required meeting | all | `weekday`, `time_of_day`, duration within `BackboneMeeting.durationMinutes` | §7.3 |
| Q-T02 | Merge same-cadence meetings of workstreams you run alone? | eos-lite solo, personal-os | bool, per merge group | yes (weekly CEO review) |
| Q-T03 | Scorecard lines: pick from pack suggestions or add your own; for each, set owner, unit, target, source (manual or connector) | eos-lite, 4dx, personal-os | 3 to 15 lines (eos-lite solo), 1 to 3 lead measures (4dx) | 02 §8 and 03 §13 |
| Q-T04 | First priorities, WIG or goals for this quarter (drafts allowed) | all | count within template bounds | Alderwick: 3 priorities; Quillmarsh: 2 priorities |
| Q-T05 | How are decisions made? | eos-lite, eos | `single_decider` or `daci`; memo for one-way doors (bool) | `single_decider`, memo yes |
| Q-T06 | Who owns which area? (team mode: area to owner; solo mode: the user owns everything except steps of external people) | all | Person per area | solo: the user |
| Q-T07 | How strict is review? | all | `require_review` or `auto_close_on_checks` (03 §9.4) per item template | `require_review`; auto-close only for calendar and measure checks |
| Q-T08 | When does an unfinished item escalate? | all | E2 at carry count 1 to 3 (default 2); E3 at carry count 3 to 6 (default 4) or overdue 14 to 60 days (default 30) | defaults |
| Q-T09 | What may AI see for this workstream? | all | `allow`, `redact_people` or `deny` | `allow` for both companies |
| Q-T10 | Which grounding files define the candidate? (profile, rubric, writing style) | pack.job-search* | file refs | not asked: no job-search workstream in the scenario |
| Q-T11 | Who is told when items close? | all | Person list per item template | none |

## 9. Customisation and forking

| Level | What changes | Invariants still enforced? |
|---|---|---|
| 1. Parameters | Values within `ParameterSpec` bounds | yes |
| 2. Vocabulary | `vocabularyOverrides` (e.g. "Rock" instead of "Priority") | yes |
| 3. Packs | Add or remove packs; edit pack measures and action templates | yes |
| 4. Extension sections | Pack sections placed in `extensionSlots` (e.g. `content_review` after `headlines`) | yes |
| 5. Fork | `custom:<name>` template copied from the source; invariants become editable | only those kept; the UI labels it "custom (based on eos-lite 1.0.0)" |
| 6. Engine | Files in the user's engine repository ([08 §4.3](08-repository-and-automation.md#43-engine-extension-points)): UI widgets in declared slots only, theme tokens (colours, fonts, radius and density only; the layout is fixed, owner decision Q9, 10 Nov 2026), vocabulary, `custom:` templates and packs, the calendar mapping | yes: the foundation's validators run on every engine file at build and at start (C-01-03) |

Switching a workstream to another template is a **migration**. CC computes a mapping (rocks ↔ objectives ↔ WIG, scorecard ↔ lead measures, agenda sections), shows a dry-run diff and applies it only after confirmation. History is kept: the old instance is archived, and items and decisions keep their IDs.

### 9.1 Where answers live

1. **The local store is the source of truth** for onboarding answers and every record ([04 §9](04-platform.md#9-storage-secrets-and-data-location)), with scheduled, encrypted backups ([04 §9.1](04-platform.md#91-backups)).
2. The user's engine repository holds only non-sensitive configuration: theme, modules, framework and pack files, the calendar mapping, `connectors.lock`, and optionally an exported `profile.json`.
3. `cc-axi onboarding export --out profile.json` writes the answers only: no records, no secrets, no person names (people become role tokens such as `[Client contact]`), and workstreams by key, never by name. The user reviews the file and commits it if they wish. `onboarding apply --file` (C-01-07) rebuilds a workspace from it.
4. CC never commits to any git repository, never pulls, and never writes into the engine checkout (C-01-09). The user pulls merged foundation updates; Rebuild now reads the clean checkout and writes only build output, outside it ([04 §10](04-platform.md#10-packaging-updates-and-os-support) rule 2; owner decisions C1 and Rebuild now, 10 Nov 2026). This keeps "CC writes no commits" and "AI edits no files" simple, and keeps workstream and client names out of git.

## 10. Contracts

1. **C-01-01** Onboarding writes CC records only at S9 commit, in one transaction. Outward actions (calendar event creation, service sign-ins, connector installs) each need their own confirmation ([04 §7](04-platform.md#7-policy-engine-and-confirmations)).
2. **C-01-02** `recommend()` is pure and deterministic, and does not call AI. Changing the rule tables is a versioned change (`recommenderVersion`, stored on each recommendation).
3. **C-01-03** Every change to a `FrameworkInstance` (parameters, packs, series) runs all of the template's validators. A failure returns error `E_INVARIANT` with the invariant ID and the offending values, and nothing is written.
4. **C-01-04** Parameters outside their bounds are rejected with `E_PARAM_BOUNDS`, naming the key, the value and the bounds. Values are never clamped silently.
5. **C-01-05** Each workstream has at most one active `FrameworkInstance`. A `client_engagement` or `project` with a parent has none; it uses its parent's (R5).
6. **C-01-06** Re-running a step yields a `ProfileDiff` and a `MigrationPlan`. Applying it is a confirmed action. Every applied plan is recorded as a domain event.
7. **C-01-07** `cc-axi onboarding apply --file <profile.json> [--dry-run]` accepts a full `OnboardingProfile` and never prompts. A missing required answer returns `E_USAGE` naming the JSON pointer ([07](07-agent-friendly-design.md)).
8. **C-01-08** AI-suggested answers carry `suggested: true` until the user accepts them. A profile that still holds unaccepted suggestions cannot be committed.
9. **C-01-09** CC never commits to git and never writes into the engine checkout, with no exception: the user pulls merged updates, and Rebuild now writes only build output outside the checkout (owner decision C1, 10 Nov 2026; [04 §10](04-platform.md#10-packaging-updates-and-os-support) rule 2). Exports such as `profile.json` and the calendar mapping are files the user chooses to commit.

## 11. Acceptance criteria

1. **AC-01-01** Given `fixtures/onboarding/scenario.json` and `today = 2026-11-04`, `recommend()` returns exactly the templates, modes, packs and fired rules in §7.2: Alderwick `eos-lite` solo with R8, M2, M5, M6, M7, M8; Quillmarsh `eos-lite` solo with R8, M2, M6, M7, M8; both with `privacy = normal` and `aiDataPolicy = allow`.
2. **AC-01-02** Changing Alderwick `headcount` to 12 with `weightPreference = 'standard'` returns `eos` (R7); before P7 it returns `eos-lite` with `W-NOT-BUILT` naming `eos`. With `light`, it returns `eos-lite` (R7) and no `W-NOT-BUILT`.
3. **AC-01-03** Setting `priorityCount = 7` on an `eos-lite` instance fails with `E_PARAM_BOUNDS` (bounds 1 to 5). Deleting the weekly series of an `eos-lite` instance fails with `E_INVARIANT` naming `E-1`.
4. **AC-01-04** With `weeklyManagementMinutes = 160`, the scenario commit is blocked by warning `W-TIME-BUDGET` until the user picks one of the four offered options. (The figure was 180 until P1-12; the scenario averages about 174 minutes a week, §7.3, so 180 never fired T1.)
5. **AC-01-05** No composed series in the scenario overlaps a `hard` protected block in any week from 2026-11-09 to 2027-02-05 (checked by expanding every RRULE).
6. **AC-01-06** `cc-axi onboarding apply --file scenario.json --dry-run` prints the full record preview in TOON, exits 0 and writes nothing. Without `--dry-run`, every record exists after one transaction, and no calendar event exists until the separate confirmation is approved.
7. **AC-01-07** A usability test with the scenario completes S1 to S9 in 20 minutes or less, excluding service sign-ins.
8. **AC-01-08** Forking `eos-lite` to `custom:ald-weekly` and removing invariant E-5 is allowed. The instance UI and CLI show "custom (based on eos-lite 1.0.0)".
9. **AC-01-09** `cc-axi onboarding export --out profile.json` on the seeded scenario produces a file that contains no canary person name, client name or secret. `onboarding apply --file profile.json --dry-run` on a fresh profile previews the same framework instances and series as the scenario.
10. **AC-01-10** `cc-axi onboarding apply --file fixtures/onboarding/sample-profile.json --dry-run` on a fresh profile exits 0, writes nothing, and previews the templates, modes, packs and fired rules of §7.2 and the series of §7.3 (owner decision Q10, 10 Nov 2026).
11. **AC-01-11** Given `fixtures/onboarding/sample-profile.md` and a recorded extractor transcript, document onboarding produces answers that all carry `suggested: true`, cannot be committed until each is accepted (C-01-08), and, once accepted, equal `sample-profile.json` on every answer that is not marked [sample] in the essay (owner decision Q10, 10 Nov 2026).

## 12. Open questions

1. **OQ-01-01** Headcount: `regime/plan.md` says the user works mostly alone, while `regime/ceo-operating-cadence.md` assumes a founder-CEO with a few leads. The scenario uses solo mode. If there are leads, R8 still yields `eos-lite`, but in team mode, with attendees and rating. *Default: solo until the user says otherwise.*
2. **OQ-01-02** Should the daily start and shutdown be workspace-level `personal-os` meetings (as here), or a meeting type of their own outside any framework? *Default: a workspace-level portfolio series owned by no single framework (02 §4.5).*
3. **OQ-01-03** Agreeing a WIG with another person. *Closed (owner decision, 12 Nov 2026): job search left the reference scenario; it will be a separate incubation app outside this repository, which may later connect to CC through an adapter.*
4. **OQ-01-04** (closed, 11 Nov 2026) The 4DX facts used here (§5.2) were not re-verified against FranklinCovey's own material for this design. Verify before P1 ships `4dx`. *Closed: every fact in §5.2 holds on FranklinCovey's own pages, cited there. Two parameters sit outside its guidance (the 30-minute default WIG session, and 3 commitments per person); the owner kept both (owner decision, 11 Nov 2026), and §5.2 notes them beside the parameters.*
5. **OQ-01-05** Should `existingFramework == 'other'` trigger an AI-assisted mapping to the nearest template? *Default: no. Pick `personal-os` and let the user fork.*
6. **OQ-01-06** Public or private outreach defaults for `pack.job-search-fractional`. *Closed (owner decision, 12 Nov 2026): job search left the reference scenario; it will be a separate incubation app outside this repository, which may later connect to CC through an adapter.*
7. **OQ-01-07** Should onboarding insist on an off-machine backup destination before commit, or allow skipping it? *Default: skippable; the backup state stays `not_configured`.* How the user is reminded is settled by owner decision Q8, 10 Nov 2026: a one-time notice, then a standing line in the weekly CEO review until a destination is set, and no permanent banner ([04 §9.1](04-platform.md#91-backups) rule 8). This replaces the earlier default of a daily attention item.
