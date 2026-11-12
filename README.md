# cc-foundation

Command Center foundation: the modular core packages.

Command Center (CC) is a local-first Electron app that runs a company's operating rhythm
(meetings, decisions, action items) and gets every decision and action item carried out and
verified. This repository is its foundation: a pnpm-workspace TypeScript monorepo of focused
`@cc/*` packages, released in lockstep and pinned exactly by each user's engine repository.
The design documents are the specification (see [docs/design](docs/design/README.md)); the
layout follows 08-repository-and-automation.md §4.1.

## Development quick start

Requirements: Node 26 LTS (pinned in `.node-version`) and pnpm 12 (pinned in
`package.json` `packageManager`).

```sh
pnpm install          # frozen lockfile in CI
pnpm cc:doctor        # check the toolchain
pnpm typecheck        # tsc --noEmit across the workspace
pnpm lint             # ESLint, Prettier check, dependency rules D1-D7
pnpm test             # build, then unit, integration and fixture tests (offline)
pnpm e2e              # headless-core scenario tests
pnpm scan:canaries    # canary denylist scan (CI also runs gitleaks)
```

Instructions for AI developers are in [AGENTS.md](AGENTS.md). Architecture decisions are in
[docs/adr](docs/adr/README.md).

## Layout

| Path                                          | What                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/desktop`                                | `@cc/desktop`: Electron shell (main, preload, renderer)                       |
| `apps/cli`                                    | `@cc/cli`: `cc-axi`, the MCP stdio relay and the hook installer               |
| `packages/*`                                  | `@cc/*` packages: schemas, store, domain, frameworks, rhythm, policy, core, … |
| `templates/`                                  | Scaffolds for `cc:*` scripts                                                  |
| `fixtures/`                                   | Synthetic fixtures only                                                       |
| `skills/`                                     | Generated product skill for users' agents                                     |
| `.agents/skills/`                             | Development skills for AI developers                                          |
| `scripts/`                                    | Implementations of the `pnpm` scripts                                         |
| `docs/adr`                                    | Architecture decision records                                                 |
| `docs/runbooks`                               | Release, key rotation, incident response                                      |
| `.dependency-cruiser.cjs`, `eslint.config.js` | Dependency rules D1-D7                                                        |
