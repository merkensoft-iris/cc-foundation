# 0008. Engine-owned UI

- **Status:** accepted
- **Date:** 2026-11-21
- **Task:** F0 of the UI-to-engine plan (P1-21 to P1-31 in [09](../design/09-build-plan.md))
- **Closes:** none
- **Spec:** 04 §3, §4.3, §7.2, §7.3, §9.1, §10, §11 and §13 to §14; 08 §1, §3, §4, §5.2, §6, §7, §9 to §11; 09 §1.1 and §6.1; 01 §9; 07 §5. Supersedes decisions 5 and 8 and owner decision D-3 of [ADR 0003](0003-engine-extension-api.md). Amends decision A of [ADR 0005](0005-harness-deny-rules.md) and owner decision Q9 of 10 Nov 2026.

## Question

The owner's direction on 21 Nov 2026: "I prefer to keep the backend part of it in the foundation. However the UI has to be in the template engine so that anybody who is using that can build their own template or theme around the basic foundation."

Today the app UI is the renderer in `apps/desktop/src/renderer`, and an engine can change only theme tokens (Q9) and, in two declared slots, read-only widgets (ADR 0003, decisions 5 and D-3). Four questions follow:

1. How does the engine own the UI and still receive every foundation UI change?
2. Who may change the engine's UI code, given that the engine's AI never changes code (C-08-10)?
3. When the UI is the user's own code, what keeps a careless or hostile UI from completing a safety-critical operation as the user?
4. When does this happen, given that nothing is released yet?

## Method

A scout task read the renderer, main, the preload, the core's dispatch and UI port, `@cc/build`, `@cc/ui-sdk`, the design documents and ADRs 0003 to 0005, and the `cc-engine` template. It ran a throwaway probe against a real core on the real UI port, and costed three ways to deliver upgrades. The report is at `/home/drylogics/secondmate/data/cc-ui-to-engine/report.md` in the firstmate home that ran it; the facts this record relies on are restated here, so that the record stands without it.

Findings that matter for the decision:

1. **The seam is clean.** The renderer imports only types from `@cc/schemas` and reaches everything else through `window.cc` (5 functions). It uses 50 of the 68 local API methods. None of this is versioned or published as a contract: `@cc/ui-sdk` is a stub, and main forwards any `<ns>.<verb>` the renderer sends.
2. **The UI port alone completes every human-only operation.** The core refuses a human-only method to an agent caller and accepts it from the UI port with `{id, method, params}` and nothing else (`dispatch.ts`, `ui-port.ts`). The probe created a principal with all four grant-only scopes, widened another principal's scopes and revoked one, each from a bare UI-port message. The existing test `packages/core/test/backups.test.ts` shows the same for `backups.restore`. Every "are you sure" step is renderer state.
3. **ADR 0003 decision 9 was never implemented.** The WebRTC IP handling policy, the no-network renderer session and main's method allowlist are missing; `packages/build/src/builder-config.ts` says they are in `@cc/desktop` main, but nothing implements them. ADR 0003 measured WebRTC getting past both the CSP and `webRequest`. This is a live gap today, and it becomes serious once the renderer runs code, and npm dependencies, that the foundation does not control.
4. **Nothing is released.** There is no tag or release, every `@cc/*` package is `private`, the engine template's build flags are off, and the one private engine copy is an untouched template commit. Moving the UI now costs less than at any later point.

Upgrade options compared: **A**, the foundation publishes the default UI as a versioned package and the engine composes it; **B**, the UI source is copied into every engine and synced by merge PRs; **C**, a separate theme repository. B leaves the upgrade problem unsolved (template copies have unrelated history, so `git merge` cannot carry UI changes, and AI-resolved merge conflicts collide with C-08-10), and costs a second repository per feature with no foundation CI proof of the screen. C is A with a third upstream and a fourth release cycle.

## Result

The owner approved the plan with every recommendation ("go with recommended"), and added the network lock-down fix for the app window (ADR 0003 decision 9) to be done now.

## Decision

1. **Upgrade model: A.** The foundation publishes the default UI as a versioned package, `@cc/ui/v<N>`, built on a real `@cc/ui-sdk/v<N>` contract (the `window.cc` client generated from `@cc/schemas`, route types, the screen contract, `token()`, the theme tokens). The engine's `ui/` is the **composition root**: `ui/app.ts` decides what runs.
   - It may use the default UI as it is, restyle it (tokens and a stylesheet), replace screens one by one, or replace the UI altogether, with the UI library the engine chooses.
   - Screens the engine has not replaced update with no edits, through the normal dependency PR (04 §10 rule 2). The default UI may keep slots as a convenience.
   - A replaced screen is **ejected**: `cc:eject <screen>` copies it into `ui/screens/` and records its upstream version and hash in `ui/.cc-ui.json`. `cc:upgrade --check` lists upstream changes to ejected screens, and `cc:ui-update` does a 3-way merge.
   - The single `extensionApi` integer (ADR 0003 D-2) now covers `@cc/ui-sdk/v<N>` and the composition API of `@cc/ui/v<N>`. Methods the UI uses carry a `ui` stability mark in `@cc/schemas`, and `cc:gen --check` fails when such a method's params or result change incompatibly without an API bump; within an API version a result may only gain optional fields. A change to a default screen that keeps the composition API is not an API bump.
   - `cc-build` bundles `ui/app.ts` with esbuild under the D3 metafile allowlist (ADR 0003 decision 8), which gains `@cc/ui/v<N>` and the engine's chosen UI libraries; the check still fails closed. Main keeps the page shell (HTML, CSP, no inline script, the dirty-tree and rebuild labels) and serves the engine's UI from the packaged app. The default UI is used when the engine has none.
   - **Supersedes** ADR 0003 decision 5 (slots) and decision 8's allowlist, and owner decision D-3 (read-only widgets, a read allowlist in main, and the rejection of "the full `window.cc.invoke` surface"): the engine's UI now needs the full surface, human-only methods included, which is why decision 3 below exists. **Overturns** owner decision Q9 (10 Nov 2026) for the app UI: tokens only and a fixed layout no longer apply. The foundation can no longer promise how a screen looks, or that a user-made screen shows everything a rule requires; safety moves to the shell. Q9 survives for the confirm window.
   - **Amends** C-08-08 and AC-08-11 ("the engine holds no foundation code") to "no foundation _backend_ code"; the UI code is the engine's. D-1, D-2, C1 and Rebuild now are kept.

2. **Engine AI rule: (a).** Command Center's own AI still never changes code (C-08-10, layers 1 and 2 of 08 §5.2 unchanged). Development agents working for the user may change `ui/`, `theme/`, `cc.config.ts`, `frameworks/` and `packs/` through pull requests the user reviews, under a development profile, as the parked "fixing agent" plan already assumes. They never touch `connectors.lock`, `.claude/`, `.codex/`, `.github/`, `AGENTS.md` or `CLAUDE.md`; the engine's path guard (G3) already keeps automated PRs away from those paths and needs no change.
   - **Amends** ADR 0005 decision A (deny `Bash` in the engine repository): the deny rules stay as they are for the in-app AI's session. Re-enabling them as written would mean that only a human edits the engine UI, which the owner did not choose. The development profile, with the re-enable steps of the engine's `docs/lockdown-parked.md`, is designed in the engine PR that installs the rule below, not here.
   - The engine gets one development skill, `cc-engine-ui`, and the foundation gets `cc-change-ui-contract` (08 §7).
   - The agreed text of the engine's `AGENTS.md` rule 1, which replaces rule 1 of the template once the engine change lands (a later `cc-engine` PR, out of scope here):

   ```markdown
   1. Command Center's own AI never changes code: it has no file or shell tools and its GitHub
      token has no Contents access (C-08-10). Development agents working for the user may change
      ui/, theme/, cc.config.ts, frameworks/ and packs/ through pull requests the user reviews.
      They never touch connectors.lock (rule 2), .claude/, .codex/, .github/, AGENTS.md or
      CLAUDE.md, and never write UI code that tries to complete a safety-critical operation
      without the user: those are confirmed by the app shell, not by your screens (04 §4.3).
   ```

3. **Confirmations: (a), a foundation-owned confirm window drawn by main and enforced by the core, not by the screen.**
   - **Two tiers of human-only operations** (04 §4.3 rule 4). A catalogue property, `confirm: 'shell'`, marks **Tier H**: `principals.create` and `principals.update` when the result adds a grant-only scope, turns on `sensitiveAccess` or widens the workstream filter; `principals.revoke`; `backups.restore`; `confirmations.approve` for `write_external` and above; `approvals.grant`; `connectors.install`, `.update`, `.uninstall`, `.activate` and `.rollback`; `sessions.create` and `.delete`; `discovery.start` and `.choose`; `requests.approve`. **Tier R** is the rest of the human-only catalogue (claims, drafts, drop, decisions, read-back, goals, `backups.run`, `backups.test`): the UI calls it directly as the user, because a dialog on every review-queue click would break the meeting runner. Tier R keeps its domain invariants in the core. A hostile UI can do Tier R operations as the user; this is accepted and recorded (`via: ui`, the build's engine commit, and the clean-tree start's label for uncommitted UI code).
   - **Intent instead of execution.** A Tier H call from the UI port returns `status: needs_confirmation` with `{id, preview, expiresAt}` and stores `{method, canonicalParams, payloadHash}`. `preview` is text the core writes from the canonical payload. An intent is single-use, expires (default 5 minutes) and executes only with exactly that payload. Approval arrives only on the main↔core channel (`approve-intent {id, payloadHash}`); the UI port has no method that approves. This is 04 §7.3 rule 2 applied to human-only operations.
   - **The surface.** A separate `BrowserWindow` on its own origin (`cc-confirm://`) with a foundation page and a two-function preload (`approve(id)`, `deny(id)`), styled by tokens only. A look-alike inside the engine's page cannot approve, because only the confirm window's preload can. Playwright drives it like any window, so the end-to-end flows need no test hook (AGENTS rule 4 forbids any hook that bypasses a confirmation). `commandcenter://confirmations/<id>` opens it for a Tier H intent. Options not chosen: (b) OS-native `dialog.showMessageBox`, which is plain, not testable without stubbing, and too small for connector permission diffs and full email text; (c) confirmations in the screens, which nothing enforces.
   - **Secrets and paths.** The backup passphrase (and later keys and secrets) is entered in a prompt main owns and never passes through the engine's UI; folders are chosen with main's picker.
   - **`window.cc` hardening and ADR 0003 decision 9, now.** A method allowlist in main generated from the schemas (methods marked `ui`; agent-only methods such as `auth.*` and `confirmations.wait` refused); `apiVersion` from `shell()`; `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')` and a no-network proxy (`http://127.0.0.1:9` with `<-loopback>`) on the renderer's session; and the hostile-renderer probe ADR 0003 proposed. The CSP stays as it is, whatever UI library the engine uses.
   - **Conformance.** Foundation CI proves, independently of any UI, that through the UI port alone no Tier H operation changes state (C-04-12, AC-04-15), and that a hostile renderer has no network and no method beyond the allowlist (C-04-13, AC-04-16).
   - **Amends** owner decision Q3, 04 §7.2 rule 6 and 04 §4.3 rule 1: the UI may show a request inline, but the approving click for a Tier H operation is in the confirm window. PR #12's confirmation panels become "explain, then the shell confirms".

4. **PR #12: (a), merged and moved with the rest.** It is on `main` (`18b7881`). Its three confirmations are UX, not enforcement; its text in 07 §5 rule 3 and 09 P1-11 is reworded by this PR, and its `HIGH_RISK` list (a copy of the core's grant-only scopes) and its 468 lines of CSS in a TypeScript string in main are fixed when the UI contract is generated (P1-24) and the UI moves (P1-26).

5. **Timing: (a), the safety work now and the move before the first release.** Safety (P1-21 to P1-23) does not depend on the move and starts as soon as this record is merged; P1-23 fixes a gap that exists today. The contract and the move (P1-24 to P1-31) land before the first `cc:release` and before any engine copy is customised, because after that every copy needs a codemod or a hand port of its UI. Each is its own PR; the owner merges.

## Consequences

**Documents changed in the PR that carries this record** (F0, docs only):

- **04:** §3 (the renderer row, the confirm window row, rules 3 and 4), §4.2 rule 4, §4.3 rules 1 and 3 and the new rule 4 (the tiers), §7.2 rule 6, §7.3 rule 1, §9.1 rules 3 and 9, §10 rules 1 and 5, §11 (a new row, "Engine UI acts as the user"), C-04-05, new C-04-12 and C-04-13, new AC-04-15 and AC-04-16.
- **08:** §1 items 1 and 3, §3 (the UI row, which wrongly said "React with Vite"), §4.1 trees (`packages/ui`, the engine's `ui/` layout), §4.2 rule D3, §4.3 extension point 3 and its closing paragraph, §5.2 (rule 1 and the layers), §6 (`cc:eject`, `cc:ui-update`, `cc:upgrade --check`), §7 (the engine UI skill, `cc-change-ui-contract`), §8 item 4, §9 (the engine CI runs the UI tests), C-08-08, C-08-10, AC-08-10 and AC-08-11.
- **09:** §1.1 (stage 2 and 3 text), P1-11, P1-18, new P1-21 to P1-31 before P1-19, and the gate P1 criteria and manual checks.
- **01 §9** level 6 and §9.1, and **07 §5** rule 3 and its sentence on the engine's `AGENTS.md`.
- **ADR 0003** and **ADR 0005** carry a status note pointing here; their bodies are not rewritten (ADR README rule 2).

**Doc drift settled in the same files.** 08 §3 said the renderer is React with Vite; it has no React and no bundler (`h` helper, no UI library). The row now says so, and says the engine picks its own library. 04 §10 rule 5 now lists the WebRTC policy, the no-network session and the method allowlist that ADR 0003 decision 9 required, so code and doc agree on what must exist; the code arrives in P1-23. The tree in 08 §4.1 shows the target layout; until P1-26 the default UI still lives in `apps/desktop/src/renderer`.

**Follow-up tasks (separate PRs, not done here):** P1-21 Tier H intents in the core and P1-22 the confirm window, secure prompts and folder picker (both merged before this record, as #15 and #17; their 04 text is the text of C-04-12 and AC-04-15); P1-23 the renderer lock-down; P1-24 `@cc/ui-sdk/v1`; P1-25 `cc-build` bundling the engine's UI; P1-26 moving the default UI to `@cc/ui`; P1-27 eject and UI update tooling; P1-28 the UI skills; P1-29 to P1-31 the `cc-engine` changes (interim contract, composition root, `AGENTS.md` rule 1 and the development profile); and one small PR in the private engine copy to adopt `ui/app.ts`.

**Risks accepted.**

- A free layout: a user-made screen may omit text a rule requires (for example "Needs care"). The shell, not the screen, now carries the safety-critical text.
- Tier R operations are available to a hostile UI as the user. They are recorded, reviewable and bounded by core invariants.
- A larger dependency surface in the renderer, bounded by the D3 allowlist and the fail-closed count.
- One extra window per Tier H action.
- Until P1-21 and P1-22 land, nothing the foundation ships weakens (the renderer is still the foundation's own), but the enforcement this record decides on does not exist yet. The engine's UI must not leave the foundation before they do (decision 5).

## Evidence

- The scout report: `/home/drylogics/secondmate/data/cc-ui-to-engine/report.md` (the owner's decisions are in this record; the report's §1 to §4 name the files and lines).
- The probe, quoted in the report's §3.2 and Appendix A: `principals.create`, `principals.update` and `principals.revoke` succeed from bare UI-port messages; the same call from an agent returns `E_HUMAN_REQUIRED`.
- `packages/core/test/backups.test.ts`: `callAsUser('backups.restore', { id })` succeeds with only the id.
- [ADR 0003](0003-engine-extension-api.md), lines on decision 9 (the WebRTC measurements: 9 UDP STUN packets and 2 TCP TURN connections got past the CSP and `webRequest`).
- PR #12 (merged as `18b7881`).
