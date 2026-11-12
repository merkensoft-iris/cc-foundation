# 0005. Harness deny rules for the Command Center engine repository

- **Status:** accepted
- **Date:** 2026-11-10
- **Task:** P0-13 (spike S9)
- **Closes:** OQ-08-08 — closed for Claude Code; stays open for Codex until spike P0-09 (S3b,
  `codex_cli` provider) reports, since no Codex CLI was available to verify §8 of the evidence
- **Spec:** `08 §5.2` layer 5 (`docs/design/08-repository-and-automation.md:259`)

## Question

Does the engine repository's `.claude/settings.json` confirm an exact, working syntax for layer
5 ("Harness. The engine ships `.claude/settings.json` deny rules for edits and shell, and a
read-only Codex sandbox configuration"), and does denying `Edit`/`Write`/`Bash` actually close off
file writes and command execution for an agent that has read `AGENTS.md` and decided to ignore
rule 1 ("The engine's AI never changes code")?

## Method

A throwaway git repository (`lab/`), outside any worktree, with a swappable
`.claude/settings.json`, the engine's `AGENTS.md` rule text, and a tracked `src/version.ts` and
`notes.ipynb`. A `run.sh` harness copied each candidate settings file in, ran
`claude -p "<prompt>" --output-format stream-json --verbose --no-session-persistence <args>` with
`cwd` = the lab and stdin closed, captured stdout/stderr, recorded `git status` / `git log` /
`git diff` against a `baseline` tag, then `git reset --hard baseline && git clean -fdx` before the
next run. Every claim is read off the structured `tool_use`/`tool_result` records, not the model's
own prose about whether it was blocked.

Probe model: `claude-haiku-4-5-20251001` (`--model haiku`) — the deny decision is made by the CLI
before the model ever sees the tool, so the evidence is the tool's absence from the tool list, not
the model's compliance, and model choice does not affect it.

Verified against Claude Code **2.1.278**, linux-x64, build `809c980662e3`. No remote was ever
configured on the lab repository, so nothing outside the lab could be written or pushed.

Not exercised: `Artifact`, `CronCreate`, `CronDelete`, `RemoteTrigger`, `PushNotification`,
`SendMessage`, `Workflow`, `Projects`, `EnterWorktree` — these publish, schedule, message, spawn or
alter host state, which the spike's own confinement rule forbade running. Their recommended deny
entries rest on their shipped input schemas (`@anthropic-ai/claude-code/sdk-tools.d.ts`), not a run,
and are marked as such.

Codex has no installed CLI on the host the spike ran on (`command -v codex` → nothing), so the
Codex half of the design clause is documentation-only, derived from OpenAI's published Codex docs
and explicitly unverified; it is not in scope for this ADR's decision and stays an open question
for Codex (see Closes, above).

Full method, every run's prompt/args/settings/stream/stderr/exit/repo-effect, and the 30-plus run
index are preserved verbatim in the companion evidence (see Evidence).

## Result

1. **Exact syntax confirmed.** `permissions.deny` in `<repo>/.claude/settings.json` takes an array
   of rule strings: `Tool` denies a whole tool; `Tool(specifier)` denies a slice of it —
   `Bash(git push:*)` for a command prefix, `Write(./src/**)` for a path glob,
   `mcp__server__tool` or `mcp__server` for MCP. All four forms ran and worked. `disallowedTools`
   is not a settings-file key and is silently ignored.
2. **Real effect differs by form.** A whole-tool deny removes the tool from the session's tool
   list entirely — `ToolSearch` cannot find it either, and the model gets `Error: No such tool
available: <Tool>. <Tool> is disabled for this session, in subagents as well as here.` A scoped
   deny leaves the tool present and refuses the individual call with a readable message, e.g.
   `Permission to use Bash with command git push has been denied.` Nothing prompts; nothing fails
   silently from the model's point of view.
3. **Enforceable against the model in the session; advisory with respect to whoever launches the
   CLI.** No prompt, flag or settings file _inside_ the session got past a deny rule — not
   `--permission-mode bypassPermissions`, not `--dangerously-skip-permissions`, not
   `--allowedTools`, not `.claude/settings.local.json`. But the project settings file is one of
   several sources, and the invoker picks the sources: `--setting-sources user` ignored
   `.claude/settings.json` outright and every denied action then succeeded, including a commit.
4. **Two load-bearing gaps the design's wording does not cover, found by running it:**
   - **Denying `Bash` does not deny command execution.** `Monitor` takes a `command` parameter;
     with `Bash` denied it ran `echo MONITOR_RAN > monitorproof.txt` and the file appeared in the
     repository. `Monitor` must be in the deny list.
   - **Denying `Edit` and `Write` does not deny file writes.** `NotebookEdit` rewrote the markdown
     cell of a tracked notebook with `Bash`, `Write` and `Edit` all denied. `NotebookEdit` must be
     in the deny list.
     A literal `["Edit","Write","Bash"]` deny list therefore leaves two live write paths open; the
     list must enumerate tools by name, not by category.
5. **Other findings (F3–F6):**
   - **F3** — a malformed settings file (one trailing comma) is silently ignored in print mode:
     `stderr` empty, all probe steps succeeded. `claude doctor` does report it (`Invalid settings`,
     naming the file). CI must run `claude doctor` and fail on that line.
   - **F4** — `permissions.allow` is ignored in an untrusted (freshly cloned) workspace;
     `permissions.deny` is not. This is why the engine must express layer 5 as a deny-list, not an
     allow-list.
   - **F5** — the settings file is only consulted if the invoker consults it: `--setting-sources
user` bypasses it entirely. This is the honest limit on layer 5 and the reason it is layer
     _five_, not the only layer.
   - **F6** — unknown names in the deny list are tolerated silently (no warning, no effect for the
     typo) — a misspelled tool name denies nothing and says nothing. CI must assert the deny
     list's _effect_, not just its syntax.
   - (F7, named for completeness: `disallowedTools` is not a settings key — the CLI flag is
     `--disallowed-tools`; easy to confuse, no feedback when you do.)

Full per-run tables (baseline control, whole-tool deny, scoped `Bash` prefixes, scoped path globs,
MCP tool/server deny, bypass-mode refusal, precedence runs) are in the companion evidence.

## Decision

**The captain decided, 10 Nov 2026, from the phase-0 choices board: "(A) deny `Bash` outright in
the engine repository; its agents reach Command Center over the `command-center` MCP server."**

This was the one open question the spike's evidence could not settle on its own — a cost
trade-off, not a fact question, between three options the spike laid out:

- **A — deny `Bash` outright**, the strongest form the harness offers (tool removal, holds in a
  freshly cloned untrustworthy repository per F4). Cost: overrides `07 §4` ("CC recommends the
  CLI to agents that have a shell") for the engine repository, and the engine's agents lose the
  shell for everything else too.
- **B — keep `Bash`, deny the writers by prefix** (`Bash(git commit:*)`, `Bash(git push:*)`,
  `Bash(rm:*)`, …). Keeps `cc-axi` at CLI cost, but the control becomes a string match on the
  command the model itself proposed — materially weaker than removal, and still a denylist that
  permits anything not enumerated.
- **C — deny `Bash` in the shipped file, document a local opt-out** (`--setting-sources user`,
  per F5) for a human developer who needs a shell there. Keeps A's strength for unattended agents,
  but a documented bypass is a bypass people reach for by habit.

The captain chose **A**. Two consequences follow:

1. **This overrides `07 §4`'s CLI-over-MCP preference for the engine repository only.** That
   preference remains the right default everywhere else; in the engine repository it is
   deliberately traded away, because layer 5 exists for the case where `AGENTS.md` has already
   been ignored, and a removed tool is a stronger control than a string match on a proposed
   command. The engine's agents reach Command Center over the `command-center` MCP server, at
   MCP's token cost, by design rather than oversight.
2. **Agents in the engine repository have no shell at all** — no `pnpm`, no `git`, no `gh-axi`.
   Anything those were needed for is now either a Command Center request (`cc-axi requests
propose`, per `08:244`) or a human's job. A developer who genuinely needs a shell there uses the
   invoker-side route in F5, which is outside what layer 5 claims to stop.

The recommended file (variant A, byte-for-byte what the final verification runs used) denies, as a
whole tool: `Bash`, `Write`, `Edit`, `NotebookEdit`, `Monitor`, `Agent`, `Workflow`,
`EnterWorktree`, `ExitWorktree`, `CronCreate`, `CronDelete`, `RemoteTrigger`, `PushNotification`,
`SendMessage`, `TaskCreate`, `TaskUpdate`, `Artifact`, `Projects`, `DesignSync`, plus the
write-scoped `command-center` MCP tools (`cc_create_action`, `cc_update_action`, `cc_claim`,
`cc_attach_evidence`, `cc_connector_invoke`) once the MCP server name is fixed — and sets
`permissions.disableBypassPermissionsMode: "disable"` so anything not on the deny list still has
to ask a human rather than running unattended. `Read`, `Glob`, `Grep`, `ToolSearch`, `TodoWrite`,
`ReportFindings`, `AskUserQuestion`, `WebFetch` and `WebSearch` are deliberately left available —
the read-and-report surface `08:244` grants. The full file is in the companion evidence
(`recommended-settings.json`, sha256 `639c83457a372726310e04d82f0a6221ab7f2cde8dec2ef3e5260203f3178e68`).

## Consequences

- OQ-08-08 closes for Claude Code: the syntax is confirmed against 2.1.278, quoted from files that
  were actually run. It stays open for Codex until spike P0-09 reports.
- `08:259` under-specifies the control and should be reworded: "deny rules for edits and shell"
  should become "an explicit `permissions.deny` list naming every write- and command-capable tool,
  plus `disableBypassPermissionsMode`", because the `Monitor`/`NotebookEdit` gaps are live write
  paths the literal reading leaves open.
- The tool list is version-specific. It needs re-checking whenever Claude Code is upgraded in the
  engine: a new tool with a `command` or path parameter is a new hole, and F6 means nothing will
  warn if one is missed.
- Layer 5 must be documented as what it is: it constrains a model inside a session that loaded the
  file. It does not constrain the person or wrapper choosing whether to load it (F5), and it
  disappears silently if the file is malformed (F3). Layers 1–4 remain the ones that hold against
  a determined human actor.
- A new P0-gate obligation follows from F3/F6: the engine repository's CI needs (1) a `claude
doctor` check failing the build on an `Invalid settings` line, (2) an effect-based probe (attempt
  a write with the shipped file; fail unless the tool was unavailable and no file appeared), and
  (3) a path-guard keeping `.claude/settings.json` out of any automated PR. Without these, layer 5
  is unobservable, and an unobservable control is one the design should not count.
- A version floor belongs in the engine's docs: the syntax here is confirmed on Claude Code
  2.1.278; the tool inventory is that version's and is not assumed stable across upgrades.

## Evidence

The full spike report — every verified claim, the complete run tables, the §8 Codex
documentation-only appendix, and the run index — is preserved verbatim, unmodified, in
`docs/adr/0005-harness-deny-rules/report.md`, copied faithfully from the spike's own record
(`/home/agent/secondmate/data/cc-s9-harness-deny/report.md` in the firstmate home that ran S9,
which predates this repository and is not itself part of it). The recommended settings file is at
`docs/adr/0005-harness-deny-rules/recommended-settings.json` (sha256
`639c83457a372726310e04d82f0a6221ab7f2cde8dec2ef3e5260203f3178e68`), byte-for-byte the file the
final verification runs (`Z-final-*`) used.
