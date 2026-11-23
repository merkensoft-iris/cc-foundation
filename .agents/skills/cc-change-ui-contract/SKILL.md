---
name: cc-change-ui-contract
description: Use when changing a method the UI uses (one marked `ui` in packages/schemas/src/api/methods.ts), a route, the screen contract or theme tokens of @cc/ui-sdk, or the composition API of @cc/ui (createApp, AppOverrides, the exported screens and UI kit), or when `pnpm cc:gen` reports "UI CONTRACT" problems.
---

# Change the UI contract

Engines own their UI ([ADR 0008](../../../docs/adr/0008-engine-owned-ui.md)). Their `ui/` code
is built on `@cc/ui-sdk/v<N>` and `@cc/ui/v<N>`, so what those expose is a promise to code the
foundation never sees. Within an extension API version (`EXTENSION_API_CURRENT`, one integer,
ADR 0003 D-2) the promise is: it keeps building and keeps working. This skill keeps it.

## Inputs

- The change wanted, and why a UI needs it.
- Which part it touches (decide first, the answer sets the rest):
  1. a method marked `ui` (params or result);
  2. a route, the `Screen`/`Ui` contract, `token()` or a theme token (`packages/ui-sdk/src`);
  3. the composition API of `@cc/ui` (`packages/ui/src/v1.ts`: `createApp`, `AppOverrides`,
     the exported default screens, the UI kit);
  4. only the inside of a default screen (markup, copy, CSS, state handling).

Case 4 is not an API change: do it, keep the screen tests passing, stop. Everything else below.

## Scripts it calls

`pnpm cc:gen` (never edit generated files: `packages/ui-sdk/src/generated/`,
`packages/ui-sdk/contract/v<N>/`, main's method allowlist), `pnpm test`, `pnpm typecheck`,
`pnpm lint`. For a bump, the codemod interface of `@cc/build` (`packages/build/src/codemod.ts`)
and `pnpm cc:engine-template` for the fixture engine.

## Steps

1. **Make the change compatible if you can.** Within a version:
   - params keep accepting what they accepted: a field may become optional or be added as
     optional; nothing may be removed, become required, or accept less;
   - a result only gains optional fields: nothing removed, nothing that stops being always
     present, no new value, type or field a UI must handle;
   - a `ui` method stays in the contract; a route, screen contract or composition export
     stays too. Add beside, deprecate in the doc comment, do not remove.
   - A new method is compatible: mark it `ui` and let `cc:gen` record it.
2. **Edit the schema, not the output.** Change `packages/schemas/src/api/methods.ts` (the zod
   definition, the `ui` mark, `uiParams` where main fills a param in), then run `pnpm cc:gen`.
   It regenerates the typed client and `contract/v<N>/<method>.json`.
3. **Read what the guard says.** `pnpm cc:gen` and `pnpm cc:gen --check` both fail with
   `UI CONTRACT ...` lines when a `ui` method changed incompatibly, and both **keep the recorded
   contract** so the break stays visible. The rule is in `scripts/ui-contract.ts`. Never
   "fix" the failure by editing, deleting or regenerating `contract/v<N>/` by hand, by
   dropping the `ui` mark, or by loosening the comparison. A mark removed from a method the
   default UI still calls is the same break.
4. **If it cannot be compatible, bump the API.** This is a decision with a cost, so write it
   down in the PR. A bump means:
   - raise `EXTENSION_API_CURRENT` in `packages/schemas/src/extension-api.ts`, and keep the old
     version in `EXTENSION_API_SUPPORTED` (the foundation supports N and N−1, 08 §4.3);
   - `cc:gen` then records `contract/v<N+1>/` beside the old one, which stays for N−1;
   - an N−1 shim, so an engine UI built for N−1 still builds and runs, and a runtime up-cast
     for results (rename tables are shared with the codemod, so they cannot disagree);
   - a codemod `<N−1>-to-<N>` in `packages/build/src/codemods/`, with a test on a fixture
     engine UI at N−1 (AC-08-10). The codemod never guesses: a site it cannot rewrite is left
     for `todo(node, message)` and `cc:upgrade` exits 1 for a person to finish;
   - new `@cc/ui-sdk/v<N+1>` and `@cc/ui/v<N+1>` entry points; the old ones keep working.
5. **Default screens move with the contract.** Update `packages/ui` for the change. Screens an
   engine has not replaced update with no edits; engines with ejected copies learn of it
   from `pnpm cc:upgrade --check`. Do not rely on that to excuse a break.
6. **Prove it.** Tests are named after the criteria they prove (AGENTS rule 2); cite AC-08-10,
   AC-08-11 and the contract IDs. Add a test for the new field or method on the contract side
   (`packages/ui-sdk/test`) and for the screen side (`packages/ui/test`, `compose.test.ts`
   covers `createApp` overrides).

## Never

- Add a UI-reachable path that completes a Tier H operation (04 §4.3 rule 4). Tier H
  methods return `needs_confirmation`; the approving click is in the foundation's confirm
  window. Do not add a flag, a parameter, a test hook or a `ui` mark that avoids that.
- Put secrets, passphrases or filesystem paths through a UI-bound param: main's prompt and
  folder picker own those.
- Import anything but `@cc/ui-sdk`, `@cc/schemas` types and UI libraries into `ui-sdk` or
  `ui` (rule D3).
- Use a real name, client or address in a fixture (AGENTS rule 5).

## Done when

- `pnpm cc:gen --check`, `pnpm typecheck`, `pnpm lint` and `pnpm test` pass.
- Either a result only gained optional fields (and params accept what they did), or the API is
  bumped with the N−1 shim, a codemod and its fixture test, and the old contract is still there.
- The default screens and the fixture engine UI still build (`pnpm cc:engine-template`).
- The design docs say what the code says (AGENTS rule 1): 08 §4.3 and §6 for a bump, and the
  ADR if the change overturns a decision.
- The PR names what changed for an engine's UI, and whether `cc:upgrade` needs a codemod run.
