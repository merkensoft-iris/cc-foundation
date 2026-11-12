# 0003. Engine extension API

- **Status:** accepted
- **Date:** 2026-11-10
- **Task:** P0-10
- **Closes:** none
- **Spec:** 08 §4.3, 08 §4.2 (rule D3), 08 §6, 04 §3, 04 §10 (rules 2 and 5), 02 §9.6; proves AC-08-10 as a prototype

## Question

How does an engine repository keep building across one foundation major, and how is that
shown for the customisation surface of 08 §4.3 in a renderer with no Node and no network
(rule D3)? Four sub-questions:

1. How is "API N" expressed, and how does a foundation keep N−1 building?
2. How are config and tokens validated, and what does a bad config look like?
3. What does a codemod look like, and does it stay safe when it cannot handle something?
4. Do theme tokens and UI slots work in a renderer with no Node and no network, and how is
   that enforced and proven?

Scope: P0-10 only. Framework and pack files (01 §9) and `connectors.lock` (05 §15.6) are
extension points too but were not prototyped. Their validators belong to their own build
steps, and the versioning scheme below applies to them unchanged.

## Method

A throwaway prototype, outside this repository (see Evidence): a mini foundation
(`@cc/schemas`, `@cc/ui-sdk`, `@cc/build`, `@cc/desktop`; 693 lines), an API 1 fixture
engine, an edge-case fixture and a hostile-widget fixture. Linux 7.0.0-38 x86_64, Node
22.23.3, pnpm 12.18.0, warm pnpm store, TypeScript 7.0.2, ts-morph 28, zod 4, esbuild,
Electron 45 (Node 24.22.2). Wall times are measured around `pnpm -s <script>` and include
about 0.3 s of pnpm start-up; in-process times are printed by the tools.

Options compared, by question:

**Expressing the API version**

| Option                                                                                                | Result                                                                                            |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| A. Explicit `extensionApi: <int>` in `cc.config.ts`; the foundation exports `EXTENSION_API_SUPPORTED` | Read from the AST without running anything; exact errors for N−2 and N+1. **Chosen**              |
| B. Infer from the pinned `@cc/*` version                                                              | Breaks the N−1 case by definition: after a dependency PR the pin says N and the code is still N−1 |
| C. Per-file markers                                                                                   | Allows mixed engines nobody can reason about                                                      |

**Keeping N−1 building**

| Option                                                                                                   | Result                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A. Versioned entry points (`@cc/ui-sdk/v1`, `/v2`, `@cc/schemas/engine/v1`, `/v2`); N−1 is a shim onto N | The API 1 engine type-checks (0.15 s) and builds against 2.0.0 with deprecation warnings; dropping N−1 is a directory delete. **Chosen** |
| B. One unversioned entry point with deprecated names                                                     | Cannot express a change of meaning under one name (`theme` prop vs `token()` function); type errors mix both generations                 |
| C. Two foundation builds side by side                                                                    | Doubles the shipped renderer; breaks "one lockstep version" (08 §3)                                                                      |

**Codemod tooling**

| Option                                                         | Result                                                                                                                                                                                                      |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ts-morph 28 for `.ts`/`.tsx`, plain JSON transforms for tokens | About 100 lines for the 1→2 codemod; 55 ms on the fixture, 93 ms on the edge fixture; independent of the engine's own `tsc`. **Chosen**                                                                     |
| jscodeshift 17                                                 | Not tried. Better formatting preservation but no type information. Revisit if ts-morph reprinting (it emitted double quotes where the engine uses single) becomes a review burden; a formatter run fixes it |
| Text or regex replacement                                      | Rejected: cannot tell `theme['color-primary']` from a string in JSX text                                                                                                                                    |

**Loading `cc.config.ts`**

| Option                                                                                               | Result                                                                                                         |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| esbuild bundle to a cached `.mjs`, then `import()`; validated value written to `dist/cc.config.json` | 15–29 ms, works on any Node; main at start reads JSON only, so no TypeScript at runtime. **Chosen**            |
| Node native type stripping                                                                           | 90 ms on Node 22.23.3 and works; on by default in Electron 45's Node 24. A fallback if esbuild is ever dropped |

**D3 static enforcement (engine `ui/`)**

| Option                                                          | Result                                                                                                                                                                                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dependency-cruiser 18.7.2 (named in 08 §4.2)                    | Silently a no-op at first. Needed three fixes (a TypeScript below 7 visible to it, `enhancedResolveOptions` for package `exports`, no `exclude: node_modules`). Then catches all three forbidden imports in about 120–160 ms |
| esbuild metafile import allowlist                               | Same three violations, 18 ms clean and 54 ms dirty; uses the resolver the real bundle uses, so it cannot drift from what ships. **Chosen**                                                                                   |
| Global-name scan (ts-morph) for `fetch`, `WebSocket`, `eval`, … | Caught 11 uses in the hostile widget; evaded by `globalThis['fe'+'tch']`. **Kept as a lint** for honest mistakes, not a boundary                                                                                             |

**D3 runtime enforcement** was tried in stages against a hostile widget making 25 escape
attempts plus one allowed call. A loopback probe (TCP listener counting every connection,
UDP listener on the same port) observed what reached the network stack. Per mode:
`CC_SPIKE_RTC=<mode> node ../probe.mjs <electron> --no-sandbox --ozone-platform=headless --disable-gpu <main.mjs> --app-dir dist --selftest`.

The acceptance sequence, `./ac-08-10.sh`, was run 5 times, each from a fresh clone of the
API 1 fixture engine in a new `/tmp/cc-ac0810-XXXX`: install, type-check, build, start,
`cc:upgrade`, type-check, build, start, `cc:upgrade` again.

## Result

**AC-08-10 passes, 5 of 5 fresh runs.** An engine written against extension API 1 builds
and runs unchanged on a foundation at API 2. `pnpm cc:upgrade` then moves it to API 2: 22
edits in 5 files in about 55 ms, followed by a 0.1 s type-check, and the result renders the
same (same computed colours and radius per slot). A second run does nothing. The whole
sequence takes about 4 s on a warm store. Medians (wall): type-check API 1 111 ms, build
API 1 711 ms, start and self-test API 1 838 ms, `cc:upgrade` 449 ms, type-check API 2
118 ms, build API 2 716 ms, start API 2 848 ms, second `cc:upgrade` 319 ms (no-op, exit 0).

```text
$ pnpm cc:upgrade --check
cc-upgrade --check: engine on API 1, foundation 2.0.0 is on API 2: 22 edits in 5 files would be made, 0 need a person   (exit 1)
$ pnpm cc:upgrade
cc-upgrade: API 1 -> 2: 22 edits in 5 files (55 ms)
cc-upgrade: type-check passed (104 ms)
$ pnpm cc:upgrade
cc-upgrade: ok  engine already on extension API 2 (foundation 2.0.0); nothing to do
```

What the API 1 engine changes, so the codemod is not trivial: `modules: { enabled: [...] }`
becomes `modules: { id: boolean }` and `calendar` becomes `calendars`; flat `color-primary`
tokens become nested `color.accent`; `dashboard.*` slots become `home.*`; widgets that took
a `{ theme }` prop call `token()`.

Rendering before and after (self-test from the renderer): both show `home.header` colour
`rgb(11,110,79)` and `home.aside` background `rgb(11,110,79)` with radius `12px`; `require`,
`process`, `module` and `Buffer` are undefined and `window.cc` has only `invoke`. API 1
widgets were titled `"ho"` and `"go"` (the shim used `component.name`, and minification
renamed the functions); API 2 requires `title`, and the codemod fills it from the source
identifier.

Build at API 1 prints `cc-build: deprecated: cc.config.ts: extension API 1 is deprecated in
foundation 2.0.0 and removed in 3.0.0; run pnpm cc:upgrade`. Sizes: `app.js` 226,135 B
minified (70,325 B gzip, almost all React 19); packed tarballs 5.5 KB (`@cc/schemas`),
1.8 KB (`@cc/ui-sdk`), 6.8 KB (`@cc/build`), 4.8 KB (`@cc/desktop`); foundation build
(`tsc` 7.0.2, 4 packages) 0.47 s.

**Config validation.** The typed `defineConfig` catches a typo at edit time (TS2561). With
types bypassed (`as any`), `tsc` passes and the build-time zod validator fails with located
messages: unknown keys, an empty `vocabulary.actionItem`, "exactly one primary target per
route (found 2)", "workstream keys, never names", "must be a label, not an account or email
address (02 §9.6 rule 1)", a bad colour pattern (exit 1). `extensionApi: 0` and `3` give
messages that say what to do (0: upgrade one major at a time; 3: set `extensionApi` to 2).
A tampered `dist/cc.config.json` (`modules.shell = true`) is refused by main before a window
opens. Token injection (`red;}body{background:url(…)` and `url(https://…)`) is rejected by
the closed value grammar (exit 1). `z.toJSONSchema` gives a 3,679 B editor schema without
the refinements.

**A site the codemod must not guess.** `Legend.api1.tsx` reads the theme with a computed
key (`theme[k]`). The codemod marks it in place, lists it, and the type-check fails on the
one place a person must touch (exit 1). Two defects showed up: the first version removed
`TokenNameV1` from an import while the file still used it (fixed: a v1 specifier is removed
only when nothing else references it); and it re-registered `Legend` under `defineWidget`
while `Legend` still expected the v1 `theme` prop. Because `cc-build` did not type-check,
the half-migrated engine built green (`cc-build: ok … 4 ui files`) and would have rendered
without a theme.

**D3 static checks** on a widget importing `node:fs`, `@cc/ui-sdk/host` and `@cc/schemas`:

```text
dependency-cruiser, TS 7 only: D3 passed; only esbuild's bundle failed on node:fs; the two @cc imports were never checked
  (dependency-cruiser -i: "x typescript >=2.0.0 <7.0.0 -", .ts/.tsx not scanned)
+ fail-closed count:   dependency-cruiser parsed 0 of 4 ui files; refusing to pass an unchecked tree
+ no exclude (final):  D3-no-node-builtins and D3-only-ui-sdk catch all three; clean engine 117–164 ms
esbuild metafile:      3 violations in 54 ms; clean engine 18 ms
global-name scan:      11 violations; globalThis['fe'+'tch'] not detected (evasion by design)
```

**D3 runtime: the no-network rule does not hold with the hardening listed in 04 §3 and
04 §10 rule 5.** WebRTC is outside both CSP and `webRequest`.

| Hardening                                                                                                                                                                               | Reached the loopback probe                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 04 §3 / §10 rule 5 as written (`contextIsolation`, `sandbox`, strict CSP with `connect-src 'none'`, `app://`, `webRequest` cancel, permission deny, navigation and window-open blocked) | **9 UDP STUN packets + 2 TCP TURN connections**                                                                     |
| + `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')`                                                                                                                                | **2 TCP TURN connections**                                                                                          |
| + renderer session proxy to a dead port (`proxyRules: 'http://127.0.0.1:9'`, `proxyBypassRules: '<-loopback>'`)                                                                         | **nothing**                                                                                                         |
| + preload removes `RTCPeerConnection` from the main world                                                                                                                               | **nothing**, but this layer adds nothing: a fresh `about:blank` iframe still provides a working `RTCPeerConnection` |

With the policy and the proxy, none of the 25 escape attempts reached the probe (0 packets,
0 connections). The proxy alone was not run: without the policy, WebRTC sends UDP directly
and ignores the proxy. CSP blocked everything else before the network stack: the renderer
logged 29 CSP violation messages (15 unique) and `webRequest.onBeforeRequest` recorded only
the `window.open` and the navigation. `cc.invoke('fs.readFile')` fails with `E_METHOD
fs.readFile` (main's method allowlist); `cc.invoke('health.get')` succeeds. Electron start
to self-test result is about 680 ms. Theme tokens and slots work in that same hardened
renderer: `--cc-color-accent` resolves to `#0b6e4f` and both widgets render in their
declared slots.

**Limits of this evidence.**

1. Chromium's OS sandbox could not run on the host (Ubuntu `kernel.apparmor_restrict_unprivileged_userns=1`, `chrome-sandbox` not setuid-root), so every Electron run used `--no-sandbox`. That disables only the OS-level process sandbox; Electron's `sandbox: true` renderer model still applied. Re-check on macOS and Windows runners (08 §9). Linux packaging (P7) needs the SUID helper or an AppArmor profile.
2. Fuses (04 §10 rule 5) and ASAR integrity were not exercised; they belong to `@cc/build` packaging (P1-16).
3. Vite (08 §3) was not used; esbuild bundled the renderer. Re-check the metafile approach when P1-16 picks the bundler (Vite 8 exposes its own form).
4. typescript-eslint against TypeScript 7 was not tested.
5. Framework and pack files and `connectors.lock` were not prototyped.

Design defaults checked: N and N−1 (08 §4.3, 04 §10 rule 2) **holds**; `cc:upgrade`
(08 §6) **holds**, plus a non-zero exit when a site is left and `--check` for CI; `cc.config`
checked at build and start **holds**; zod 4 with `z.toJSONSchema()` **holds**, but the
runtime validator is the authority; renderer hardening gives **no Node: yes, no network:
no**; D3 "dependency-cruiser and ESLint, in CI" **not as written**; CI's fixture engine at
N−1 (08 §9) **feasible** (`ac-08-10.sh`, about 4 s warm).

## Decision

1. **Version marker.** `cc.config.ts` carries `extensionApi: <int>`. `@cc/schemas` exports `EXTENSION_API_CURRENT` and `EXTENSION_API_SUPPORTED = [N−1, N]`. A value outside that range fails build and start with a message that says what to do.
2. **Versioned entry points.** Engine code imports `@cc/ui-sdk/v<N>` and `@cc/schemas/engine/v<N>`; there is no unversioned root. The N−1 entry is a shim onto N. Config and tokens are up-cast to N at load, so foundation internals see only N. N−1 is removed at the next API bump. `@cc/ui-sdk/host` is internal to `@cc/desktop` and rejected from engine code.
3. **Config validation.** One zod 4 `strictObject` per API version; semantic rules (02 §9.6 rule 4) in `superRefine`/`refine`; errors printed with `z.prettifyError`. Validation runs in `cc-build` and again in main at start, before any window opens. `z.toJSONSchema` generates the editor schema as a convenience.
4. **Theme tokens.** `theme/tokens.json` in a DTCG-style nested shape with a closed value grammar (colours and lengths only: no `url(`, `;`, `}` or `@import`), compiled to CSS custom properties. Widgets use `token('color.accent')`; `TokenPath` is a literal union, so a typo is a type error.
5. **UI slots.** The foundation declares slot IDs; `defineWidget({ slot, title, component })` registers a widget inside an error boundary. `title` is required.
6. **Codemods.** `pnpm cc:upgrade` runs one module per step (`codemods/<n>-to-<n+1>.mjs`), chained; never guesses (a site that cannot be rewritten is left unchanged, marked `/* cc:upgrade TODO(API n): … */` and listed); shares its rename tables with the runtime up-cast; writes, then runs the engine's `tsc --noEmit`; exits 0 only if the type-check passes and no site was left for a person. `--check` writes nothing and exits 1 when an upgrade is due. In a partial upgrade, an unconvertible widget stays on the N−1 shim (`registerWidget` from `/v1`) rather than being re-registered under N (the prototype does the latter; the Result section shows why that is worse).
7. **`cc-build` type-checks** before bundling (about 0.1 s with TypeScript 7), in addition to the config, token and D3 checks.
8. **D3 static checks for engine `ui/`:** the esbuild-metafile import allowlist (`@cc/ui-sdk/v<N>`, `@cc/schemas/engine/v<N>-tokens`, `react`, `react-dom`; no `@cc/ui-sdk/host`, no built-ins) plus the global-name scan as a lint. Any D3 checker fails closed when it parses fewer files than exist. CI keeps a known-bad widget fixture that must fail, the D3 analogue of AC-08-02. In `cc-foundation` itself dependency-cruiser may stay for D1, D2 and D4 to D7, only with a TypeScript below 7 visible to it, the fail-closed count and the canary.
9. **D3 runtime boundary**, in `@cc/desktop` and `@cc/build`, so every engine build gets it: the 04 §10 rule 5 hardening; app served from `app://cc/` with the CSP `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; media-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'` as header and `<meta>` (no `unsafe-inline` needed); `webRequest` cancelling everything that is not `app://`; **WebRTC IP handling policy `disable_non_proxied_udp` and a no-network proxy on the renderer's session**; a preload that exposes only `window.cc.invoke`, with main checking the sender's origin and a method allowlist. Removing `RTCPeerConnection` in the preload is not adopted: it gives a false sense of safety.
10. **Toolchain notes for P0-01.** TypeScript 6+ defaults `types` to `[]`, so packages that use Node types list `"types": ["node"]`. TypeScript 7 has no stable JS API, so tools that load `typescript` (dependency-cruiser, probably typescript-eslint) need a TypeScript 6 pinned beside it. pnpm 12 builds dependencies only when listed under `allowBuilds:` in `pnpm-workspace.yaml`; Electron's postinstall did not run on the first install, so `cc:doctor` should check that the Electron binary exists.

Options not chosen are in Method, with the reason for each.

### Decisions of the owner, 2026-11-10 (phase-0 choices board)

- **D-1: a.** The dependency PR merges as is; CI runs `cc:upgrade --check` and comments the planned edits; the owner runs `pnpm cc:upgrade` locally when convenient, before the next major. This keeps all five C-08-10 layers intact (the engine's AI must not change code, and CC's token has no Contents access). The owner's note: "b later". An engine CI job that pushes the codemod commit onto the dependency PR (option b) is the intended later step, to be designed with its C-08-10 consequences. Options not chosen: b (a `contents: write` workflow pushing code into the engine) now; c (a local step for every update, even when N−1 would do).
- **D-2: a.** The extension API version is an independent integer, bumped only in a foundation major release and only when an extension point breaks. Most majors then leave the engine untouched, and the N−1 window can span several majors. Options not chosen: b (API version equals the foundation major, which starts an upgrade clock at every major); c (bumps in minor releases, which breaks "an engine keeps building across one foundation major", 08 §4.3).
- **D-3: b.** Engine widgets may run read-only queries through `@cc/ui-sdk`, limited to a declared allowlist of read methods (for example `items.list`, `health.get`) enforced by main as in the prototype; never writes and never human-only operations (04 §4.3). Introduced as an additive API change, so no version bump. Options not chosen: a (presentational only, which leaves widgets without data); c (the full `window.cc.invoke` surface, which lets widget code reach mutating methods).

## Consequences

**Positive.** The owner's engine keeps building for a whole foundation major after a
dependency PR, and the upgrade is one command with a type-checked, reviewable diff. A
breaking change to an extension point now has a mechanical recipe: bump
`EXTENSION_API_CURRENT`, add `v<N>` entry points, turn the old ones into a shim, ship
`codemods/<N−1>-to-<N>.mjs` with a fixture test; dropping N−1 at the next bump is a
directory delete. "No network in the renderer" becomes a property proven by a hostile-fixture
test rather than a claim based on configuration.

**Costs and risks accepted.**

1. Each API bump costs a shim, a codemod and fixture tests, which argues for bumping rarely (D-2).
2. The shim must re-express the N−1 surface exactly, including prop shapes, for the whole N−1 window.
3. The renderer's session can never reach the network. Any future feature that wants it (remote images or avatars in widgets, WebRTC for a meeting runner) needs a new, explicit design decision.
4. Two TypeScript versions in `cc-foundation`: 7 for `tsc`, 6 for tools that load the TypeScript API.

**Design documents that change.** This PR does not edit `docs/design/`. Status of each
change against cc-foundation PR #3 (https://github.com/merkensoft-iris/cc-foundation/pull/3,
merged 2026-11-11, the 10 Nov design-doc update):

| Document                  | Change                                                                                                                                | Covered by PR #3?                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 04 §10 rule 2             | D-1: who runs `cc:upgrade` (dependency PR merges as is, CI runs `--check`, owner runs it locally)                                     | **Yes** (PR #3 is merged; D-1 is in 04 §10 rule 2 on `main`). Follow-up only for "b later"                      |
| 08 §4.3                   | D-2: the `extensionApi` field as an independent integer, and the versioned entry points                                               | **No.** PR #3 touches 08 §4.3 only for Q9 (theme tokens only, fixed layout, widgets in slots). Follow-up needed |
| 08 §4.3, 04 §3 or §10     | D-3: widgets may read through `@cc/ui-sdk` with a read-method allowlist enforced by main                                              | **No.** PR #3 lists "the widget read allowlist" under "Not in this PR". Follow-up needed                        |
| 04 §10 rule 5 (and 04 §3) | Add the WebRTC IP policy `disable_non_proxied_udp` and the no-network renderer session; D3's "no network" needs this to hold          | **No.** Follow-up needed                                                                                        |
| 08 §4.2                   | D3 tool choice (esbuild-metafile allowlist for engine `ui/`, fail-closed count, canary); dependency-cruiser only for D1, D2, D4 to D7 | **No.** Follow-up needed                                                                                        |
| 08 §6                     | `cc-build` type-checks; `cc:upgrade` exit codes and `--check`                                                                         | **No.** Follow-up needed                                                                                        |

One design-doc follow-up PR, on top of the merged PR #3, can carry all the "No" rows.

**Follow-up tasks and criteria.**

1. New acceptance criteria to consider: a hostile-widget runtime test with zero packets at a loopback probe, UDP included; and a D3 canary (a known-bad widget fails `cc-build`).
2. P1-18 and P1-16 consume decisions 1 to 9. P0-01's toolchain pins take decision 10.
3. D-1 "b later": design an engine CI job that pushes the codemod commit onto the dependency PR, with its C-08-10 consequences.
4. D-3: specify the read allowlist and its additive `@cc/ui-sdk` surface (which methods, how main enforces it) when P1-18 is planned.
5. Re-check the OS sandbox on macOS and Windows runners; plan fuses and ASAR integrity under P1-16.

## Evidence

The prototype is out of repository and not committed here: it is throwaway code. It lives
at `~/secondmate/data/cc-s6-extension-api/prototype/` (see its README), and
the spike report this record is built from is
`~/secondmate/data/cc-s6-extension-api/report.md`. Files named below are
relative to the prototype directory.

- `./ac-08-10.sh`, run 5 times; every run printed `AC-08-10 PASS`. One run's line: `install=0(200ms) tc1=0(111ms) build1=0(696ms) start1=0(831ms) upgrade=0(429ms) tc2=0(118ms) build2=0(716ms) start2=0(849ms) upgrade_again=0(319ms) … AC-08-10 PASS`.
- `evidence/cc-upgrade-1-to-2.diff` (5 files, +35 −18); `fixture-engine-api1/` and `fixture-engine-api2/` (before and after).
- `fixture-edge/Legend.api1.tsx` and `fixture-edge/Legend.after-upgrade.tsx` (the unguessable site).
- `evidence/hostile-full.json` (hostile widget, full hardening, 0 packets) and `fixture-hostile/Hostile.tsx`; `probe.mjs` (loopback TCP and UDP probe).
- `evidence/cc.config.schema.json` (3,679 B JSON Schema).
- Key code: `foundation/packages/build/codemods/1-to-2.mjs`, `foundation/packages/build/bin/cc-upgrade.mjs`, `foundation/packages/build/lib/d3.mjs` (fail-closed count), `d3-esbuild.mjs`, `foundation/packages/schemas/src/tokens.ts` (`TOKEN_RENAMES_1_TO_2`, value grammar), `foundation/apps/desktop/src/main/main.mjs` (WebRTC policy and session proxy).
- Raw probe lines per hardening level:

```text
none          PROBE hits (13 events): 9 × "udp 20B" (STUN binding requests), 2 × ("tcp connection" + "tcp non-HTTP bytes") (TURN)
policy        PROBE hits: 2 × "tcp connection" + "tcp non-HTTP bytes"
policy+proxy  PROBE hits: []
full          PROBE hits: []
```

- The WebRTC fix, as decided, is `webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')` plus a renderer session proxy with `proxyRules: 'http://127.0.0.1:9'` and `proxyBypassRules: '<-loopback>'` (`foundation/apps/desktop/src/main/main.mjs:48`, `:69`).
