# 0004. Clean-tree start and developer mode

- **Status:** accepted
- **Date:** 2026-11-10
- **Task:** P0-11 (spike S7)
- **Closes:** none (no open question covers S7; acceptance for P0-11 is "ADR")
- **Spec:** 04 §10 rules 1-5, 04 §11, 04 §12 rule 1, 08 §4.1, 08 §5.2 layer 4, C-08-10; changes 04 §10 rule 4, 08 §4.1 and 04 §11 (see Consequences)

## Question

Can Command Center detect a dirty engine checkout and lockfile drift at every app start fast
enough for the 3-second cold start (04 §12 rule 1), and what does the labelled developer mode
do? The design states only the behaviour: check at start; dirty goes to developer mode; clean
and matching goes to normal (04 §10 rule 4, 08 §5.2 layer 4, one of the five layers enforcing
C-08-10, "The engine's AI never changes code").

Two facts shape the answer. The packaged app runs from its asar, not from the checkout
(`OnlyLoadAppFromAsar`, 04 §10 rule 5), so an edit in the checkout changes nothing that runs
until the next build; the one file read at run time is `connectors.lock` (04 §10 rule 3, "no
rebuild"). "Dirty at start" therefore asks two things: was the running build made from a clean,
matching tree, and has the checkout changed since? And the check runs on every start, so it must
cost a small share of the budget, cold and warm.

## Method

**Machine.** Intel Core Ultra 5 125U (12 cores), 38 GB RAM, NVMe SSD, ext4, Linux 7.0
(Ubuntu 24.04 userland, in a container), git 2.39.5, Node 22.23.3, pnpm 12.18.0. All runs used
`nice -n 10` on a shared host. **macOS and Windows were not measured, and no Electron process
was measured**: the checks ran under plain Node 22, which has the same V8 and libuv as
Electron's main process.

**Fixtures.** An engine-shaped checkout following the 08 §4.1 `cc-engine` tree: 69 tracked
files in 19 directories, a 166,673-byte `pnpm-lock.yaml`, and `node_modules` with 489 packages
and 15,245 files (268 MB, hardlinked from a pnpm store, installed with `--ignore-scripts`).
The `@cc/*` packages did not exist yet, so `package.json` pinned the 28 third-party packages
they would bring in. A scaled variant added 3,000 generated `.ts` files (3,069 tracked files
in 2,122 directories), about the size of this monorepo. A 10,000-file variant was dropped for
disk space.

**Cold versus warm.** Warm: 3 warm-up rounds, then 21 measured rounds. Data-cold: before every
run, `posix_fadvise(DONTNEED)` on every file of the checkout (including `.git` and
`node_modules`), confirmed with `fincore`; 11 rounds. Every run is a fresh process and methods
are shuffled per round. A reboot-cold run also needs the dentry and inode caches dropped, which
needs root and was impossible; instead the metadata-cold extra cost is bounded as inodes
touched x measured NVMe latency for an uncached 4 KiB random read (median 76 us, p10 60 us,
p90 144 us, n=360). 1,184 timed runs in all.

**Options tried.**

| ID           | What it does                                                                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-status     | `git status --porcelain=v2 -z` with `--untracked-files=all`, `normal` or `no`; with and without `--no-optional-locks`; with `--ignored` variants                                             |
| G-uc / G-fsm | The same with `core.untrackedCache=true`, or git's builtin fsmonitor                                                                                                                         |
| G-plumb      | `git diff-index --quiet HEAD`, `git ls-files -v`, `git rev-parse HEAD`                                                                                                                       |
| H            | Read `.git/HEAD` and the ref file directly and compare with the build stamp (no spawn)                                                                                                       |
| M1           | Git-free manifest written at build time (path, size, mtime, sha256); at start `stat` each file, rehash on mismatch, `readdir` for untracked names filtered through the `ignore` package      |
| M2           | As M1 but always sha256 every tracked file                                                                                                                                                   |
| L1           | Install stamp: at install time write sha256 of `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` to `node_modules/.cc-install-stamp.json`; at start rehash the three files and compare |
| L2           | YAML-parse `pnpm-lock.yaml` and pnpm's installed `node_modules/.pnpm/lock.yaml`, compare importers and snapshot keys                                                                         |
| L3           | `readdir node_modules/.pnpm` against the lockfile's package keys                                                                                                                             |
| L5 / L6      | `stat` (L5) or sha256 (L6) every `node_modules` file against an install-time manifest                                                                                                        |
| P-verify     | `pnpm --config.verify-deps-before-run=error exec true`                                                                                                                                       |
| P-frozen     | `pnpm install --frozen-lockfile --offline` as a no-op check                                                                                                                                  |
| **decide**   | The recommended check (Decision): build stamp, H, hardened G-status, `ls-files -v`, local excludes, in-progress markers, L1                                                                  |
| decide-basic | The same flow without the hardening                                                                                                                                                          |

## Result

All figures are milliseconds. "Wall" is the whole process; "in-proc" is time inside the checker,
which is what matters inside an already-running Electron main process (about 20-30 ms of the
wall time of the Node-based rows is Node start-up that the app does not pay). Spreads are p10
to p90.

**Engine checkout (69 tracked files, 15,245 files in `node_modules`).**

| Method                                    | Warm wall, median | Data-cold wall, median | In-proc warm / cold | Fits the start path?                       |
| ----------------------------------------- | ----------------- | ---------------------- | ------------------- | ------------------------------------------ |
| Floor: `git --version`                    | 2.05              | 2.41                   | n/a                 | n/a                                        |
| Floor: `node -e 0`                        | 19.4              | 23.0                   | n/a                 | not paid in Electron main                  |
| Floor: `pnpm --version`                   | 43.8              | 56.1                   | n/a                 | n/a                                        |
| `git status --porcelain` (v1, `-unormal`) | 3.21              | 8.09                   | n/a                 | yes                                        |
| status v2 `-z -uall --no-optional-locks`  | 3.12              | 8.22                   | n/a                 | **yes (used)**                             |
| status v2 `-uno`                          | 3.13              | 8.32                   | n/a                 | misses untracked files                     |
| status v2 `-uall --ignored=traditional`   | 41.9              | 52.1                   | n/a                 | avoid: lists all 16,632 ignored files      |
| `git diff-index --quiet HEAD`             | 2.76              | 7.61                   | n/a                 | misses untracked files                     |
| `git ls-files -v`                         | 2.32              | 6.85                   | n/a                 | yes (hardening)                            |
| H: read `.git/HEAD` in process            | 27.9              | 41.9                   | 0.17 / 0.81         | yes                                        |
| M1 manifest (mtime and size)              | 35.0              | 44.0                   | 4.90 / 8.11         | yes; misses some cases                     |
| M2 manifest (sha256)                      | 34.3              | 57.5                   | 6.49 / 17.2         | yes at this size; scales badly             |
| **L1 install stamp**                      | 28.2              | 41.7                   | 0.61 / 2.57         | **yes (used)**                             |
| L2 semantic lock compare                  | 206.0             | 237.1                  | 172.6 / 193.2       | affordable but fragile; no                 |
| L3 readdir `.pnpm`                        | 29.4              | 39.6                   | 2.24 / 3.92         | wrong answer: 5 false "missing" packages   |
| L5 stat every `node_modules` file         | 105.6             | 128.3                  | 71.6 / 89.4         | no (metadata-cold bound 1.5-2.9 s)         |
| L6 sha256 every `node_modules` file       | 357.0             | 1,939                  | 322.9 / 1,900       | **no**                                     |
| P-verify `pnpm exec true`                 | 51.3              | 64.0                   | n/a                 | no                                         |
| P-frozen `--frozen-lockfile --offline`    | n/a               | n/a                    | n/a                 | fails offline (`ERR_PNPM_NO_OFFLINE_META`) |
| **decide (recommended, hardened)**        | 34.5              | 45.8                   | **6.88 / 10.5**     | **yes**                                    |
| decide-basic (no hardening)               | 32.8              | 41.3                   | 4.37 / 7.45         | yes, but misses 3 hiding tricks            |

**Scaled checkout (3,069 tracked files, 2,122 directories).** `git status` v2 `-uall
--no-optional-locks`: 14.8 warm, 22.6 data-cold (`-unormal` 9.2 / 14.4; `-uno` 5.4 / 11.3).
M1: 63.9 / 82.0. M2: 99.4 / 410.2 (grows with bytes, not files). The untracked cache gave no
measurable gain (15.7-17.8 warm). `git status` grows roughly linearly and stays far inside the
budget.

**Metadata-cold upper bound** (one uncached 4 KiB read per inode touched, 76-144 us;
pessimistic, since ext4 packs 16 inodes per inode-table block): `decide` on the engine
(about 110 inodes) adds 8-16 ms; `git status` on the 3,069-file checkout (about 5,200 inodes)
adds 0.4-0.75 s as an outer bound; L5 (about 19,800 inodes) adds 1.5-2.9 s; L6 adds that plus
268 MB of reads. The git and node binaries were not evicted; a truly cold first git spawn adds
a few milliseconds.

**Classification matrix.** Each scenario mutated the fixture, ran every check and reset it.
Results for the recommended `decide` check:

| Scenario                                                        | Expected                     | decide                                                               |
| --------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| Clean checkout, build at HEAD                                   | normal                       | normal                                                               |
| Tracked file modified; change staged only; tracked file deleted | developer                    | developer                                                            |
| Untracked file in `ui/`                                         | developer                    | developer                                                            |
| New file in ignored `dist/`; `touch` only (same bytes)          | normal                       | normal                                                               |
| Same-size edit with mtime restored                              | developer                    | developer                                                            |
| Mode change (`chmod +x`)                                        | developer                    | developer (M1 and M2 miss it)                                        |
| `ui/` change committed, not rebuilt                             | developer                    | developer, "build out of date" (plain `git status` says clean)       |
| `connectors.lock`-only commit (include PR)                      | normal                       | normal (M1 and M2 false alarm)                                       |
| Update PR merged (`package.json` and lockfile), not installed   | developer                    | developer, lockfile drift (plain `git status` and P-verify miss it)  |
| File inside `node_modules` edited                               | normal (runs from the asar)  | normal                                                               |
| Merge in progress                                               | developer                    | developer                                                            |
| Untracked file hidden by `.git/info/exclude`                    | developer                    | developer (decide-basic and plain status miss it)                    |
| Edit hidden by `--assume-unchanged` or `--skip-worktree`        | developer                    | developer (decide-basic and plain status miss it)                    |
| `core.fsmonitor` hook in `.git/config`, plus an edit            | developer, hook must not run | developer, hook not run (decide-basic and plain status ran the hook) |
| git not on PATH                                                 | developer                    | developer, "cannot verify tree"                                      |
| Not a git checkout (zip download)                               | developer                    | developer, "not a git checkout"                                      |

Further findings: `git -C <dir>` climbs into an enclosing repository when `<dir>/.git` is
missing, so a check would silently report on the wrong repository (`decide` passes `--git-dir`
and `--work-tree` explicitly). pnpm 12's `pnpm-lock.yaml` is a two-document YAML, and
`node_modules/.pnpm/lock.yaml` is not a byte copy of it (162,069 against 166,673 bytes).

## Decision

1. **Stamp at build time.** `@cc/build` writes a build stamp into the app resources, inside
   the asar so asar integrity covers it: the HEAD commit, the absolute paths of the checkout
   and of git, the sha256 of the three lockfiles, the install-stamp digest, whether the tree
   was clean, and the build time.
2. **Stamp at install time.** A root `postinstall` script in the engine template writes the
   install stamp (L1) after every `pnpm install`.
3. **Check at start (`decide`).** Main runs it asynchronously, in parallel with creating the
   window. Core holds back schedulers and outside effects until the mode is known. The mode is
   **normal** only if all of these hold:
   - HEAD, read from `.git` without spawning git, equals the build commit. Otherwise
     `git diff --name-only <build> HEAD` may name only runtime-read files (`connectors.lock`
     today, per 04 §10 rule 3).
   - `git --git-dir=<repo>/.git --work-tree=<repo> --no-optional-locks -c core.fsmonitor=false -c core.untrackedCache=false -c core.excludesFile=/dev/null status --porcelain=v2 -z --untracked-files=all` reports nothing.
   - `git ls-files -v` shows no assume-unchanged or skip-worktree entries.
   - `.git/info/exclude` has no active patterns.
   - No merge, rebase, cherry-pick or bisect is in progress.
   - The install stamp matches the current lockfiles.

   Anything else starts **developer mode** with the reasons attached, including git missing
   and "not a git checkout".

4. **Build only from git's view of the tree.** `@cc/build` builds from tracked files plus
   untracked files that are not ignored, so an ignored file can never reach a build.
5. **Developer mode scope (owner decision `s7-devmode-scope`, option b, 10 Nov 2026).**
   Developer mode carries the label and allows **no unattended outside effects**: standing
   approvals and pre-approved payloads (04 §7.4) and the scheduled ticket run (06 §11.2) are
   suspended, so every outside effect needs a click in the UI. Reading real data and confirmed
   sends still work.
6. **Stale build (owner decision `s7-stale-build`, option a, 10 Nov 2026).** A clean tree whose
   build is behind HEAD, or whose install is out of date, starts in developer mode with the
   reason "build out of date" and a **"Rebuild now"** action in the app. This arises only when
   the user pulls or merges outside CC; CC's own update flow rebuilds after a merge.
7. **Labelling** (to be built in P1-18 and P1-19): a persistent, non-dismissible banner on
   every window ("Developer mode: <first reason>") linking to the full reasons and the way back
   to normal; a `[developer]` window-title suffix and tray icon variant; a
   `mode: developer (<reason>)` line in the `cc-axi` home view and in MCP results; and
   `mode: developer` stamped on every Run, audit entry and backup record. The mode is decided
   once at start and ends only at a restart that passes the check. The update flow (04 §10
   rule 2) runs the same check before its fast-forward pull and rebuild and refuses while the
   tree is dirty. Only the classification behind the label was tested, not a UI.

Does the design's default hold? Yes. Checking at every start and sending a dirty tree to
developer mode fits the 3-second budget with more than 99% headroom: `decide` costs 6.9 ms warm
and 10.5 ms data-cold in process, plus 8-16 ms in the metadata-cold bound. What does not hold is
any reading of "lockfiles match what is installed" that inspects `node_modules` file by file
(1.9 s data-cold for L6, up to about 3 s metadata-cold for L5).

**Options not chosen, and why.**

- **L5 and L6 (walk `node_modules`).** They use up most of the budget to guard code the asar
  does not run, and S12 (edit in `node_modules`) is normal by design because `node_modules` is
  rebuilt from the lockfile before every build.
- **P-verify.** It starts the pnpm CLI on every start (44-56 ms), needs pnpm on the PATH of a
  GUI-launched app (macOS does not inherit it), **writes**
  `node_modules/.pnpm-workspace-state-v1.json` on every run, and missed the
  merged-but-not-installed case.
- **P-frozen.** pnpm 12 checks the lockfile against supply-chain policy (`minimumReleaseAge`),
  which needs registry metadata: it fails offline and would reach the network on every start
  online.
- **L2.** 173-193 ms in process and tied to pnpm internals. Acceptable as an optional CI or
  build-time check, not on the start path.
- **L3.** It reported 5 false "missing" packages (optional dependencies of Windows-only
  parents that pnpm skips on Linux); correctness would mean re-implementing pnpm's resolution.
- **Untracked cache and fsmonitor.** Git 2.39 on Linux silently ignores `core.fsmonitor=true`;
  the untracked cache gave nothing measurable at 3,069 files; neither helps a cold start; and
  both turn repository config into behaviour a hostile `.git/config` controls.
- **M1 and M2 as the primary method.** They miss mode changes, false-alarm on include PRs
  unless given the same exception, must re-implement `.gitignore` semantics, and M2 costs
  379 ms cold at 3,069 files. Their one advantage is spawning no process, so **M1 stays the
  fallback** if spawn costs on macOS or Windows turn out high.
- **Developer-mode scope (a) label only, and (c) separate throwaway profile.** (a) lets
  unreviewed code act unattended. (c) would make previewing a theme or widget against real data
  impossible, and the owner develops customisations inside their own instance (09 §1.1,
  stage 3).
- **Stale build (b) refuse normal start, and (c) normal mode with an attention item.** (b)
  makes the app unusable until the rebuild ends. (c) would make the label mean "untrusted" in
  some cases and not in others.
- `--no-optional-locks` costs nothing (3.12 ms against 3.21 ms) and stops the check from taking
  `index.lock` or writing the user's index; it is kept.

## Consequences

**Design documents that change.** These edits are not made in this PR; they are a follow-up
PR that links this ADR (the number is filled in when it is opened):

1. **04 §10 rule 4:** reword to "CC starts normally only when the running build was made from a
   clean checkout whose lockfiles matched the install, and the checkout is still clean at that
   commit (runtime-read files such as `connectors.lock` excepted). Otherwise it starts in a
   labelled developer mode." The wording changes from "lockfiles match what is installed" to
   stamp-based. It also gains the two scope rules above (no unattended outside effects; "build
   out of date" with "Rebuild now").
2. **08 §4.1 and §6:** list the build stamp and install stamp among `@cc/build`'s duties and
   state the "build only git's view of the tree" rule.
3. **04 §11, threat row "The engine's AI changes code":** add that the start check ignores
   repository-configured git hooks and fsmonitor, and detects index flags and local excludes.

**Work for later tasks.**

- `@cc/build` owns three new jobs: the build stamp, the install stamp (installing with
  `--ignore-scripts` leaves no stamp, which safely starts developer mode), and building only
  from git's view of the tree.
- The build stamp records the absolute path of git, found at build time in the user's shell.
  A GUI-launched app on macOS has a minimal PATH, and there `/usr/bin/git` is a shim that can
  open the Command Line Tools installer. If git cannot be found or run, the app starts in
  developer mode ("cannot verify tree"), never normal.
- Core must honour developer mode in the approval and scheduling paths (item 5 of the
  Decision) and the UI must offer "Rebuild now" (P1-18, P1-19).
- A normal start now depends on git at run time. The design already assumes git: CC pulls
  fast-forward only (04 §10 rule 2).

**Risks accepted.**

- **pnpm version pin, risk to AC-08-11** ("a fresh private copy ... builds and starts ... and
  opens onboarding on first start"). pnpm can rewrite tracked files on install: here,
  `pnpm 12.18.0 install --lockfile-only` created a new `pnpm-workspace.yaml` (with 29
  `minimumReleaseAgeExclude` entries), which shows as untracked in a clean checkout, and added
  a `packageManagerDependencies` document to the lockfile. On a fresh clone, a pnpm version
  different from the template's pin would leave the tree dirty and the first start would be
  in developer mode. Mitigation for P1-18: pin `packageManager` in the template, use
  `pnpm install --frozen-lockfile` in the README path, and have `cc:doctor` check the pnpm
  version.
- **Not measured**, to be repeated during P1-18 (whose stage-2 exit is "builds and starts on
  macOS and Windows"): macOS on APFS; Windows on NTFS, where process creation is slower and
  Defender scans files; a real Electron main process; and a true reboot-cold run. The
  benchmark harness runs unchanged on macOS and Windows given Node and git, except that the
  Linux-only cache-eviction helper needs replacing. If `decide` exceeds about 100 ms in
  process on Windows, switch the tracked-file part to M1 and add a stat of the file mode.

## Evidence

The prototype (the `decide` reference implementation, the benchmark harness, the scenario
script, the cache-eviction and NVMe-latency probes, the fixture generator, raw timings of the
1,184 runs and the scenario matrix output) is the **spike prototype, not committed** to this
repository. The numbers above are the summary; none of them is a contract. Reproduction, with
the prototype and pnpm 12.18.0:

```
node tools/gen-engine.mjs engine 40            # then git init, add and commit
cd engine && pnpm install --frozen-lockfile --ignore-scripts --store-dir ../pnpm-store
node ../tools/check.mjs install-stamp .
node ../tools/check.mjs stamp . ../state
node ../tools/bench.mjs $PWD $PWD/../state ../results/x-warm.jsonl warm 21 '!untrackedCache'
node ../tools/bench.mjs $PWD $PWD/../state ../results/x-cold.jsonl cold 11 '!untrackedCache'
node ../tools/summarize.mjs ../results/x-*.jsonl
../tools/scenarios.sh
```

Owner decisions `s7-devmode-scope` (b) and `s7-stale-build` (a) were recorded on 10 Nov 2026
and are folded into the Decision above; this ADR has no open decisions.
