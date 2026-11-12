# 0002. S5 Local API and CLI: transport, endpoint discovery and the cc-axi fast path

- **Status:** accepted
- **Date:** 2026-11-11
- **Task:** P0-08
- **Closes:** OQ-08-05
- **Spec:** 04 §3, 04 §4.1, 04 §10, 04 §11, 04 §12, 07 §4 (AC-07-01, AC-07-02), 08 §3, 08 §6,
  08 §8, 08 §12 (C-08-05)

The spike ran on 2026-11-09; the owner recorded the decisions on 2026-11-10. Long material
is in [0002-local-api-and-cli/](0002-local-api-and-cli/):
[measurements.md](0002-local-api-and-cli/measurements.md) (all tables, the home view and the
scenario log) and [prototype.md](0002-local-api-and-cli/prototype.md) (the endpoint module and
the `cc-axi` bin entry, as run).

## Question

Spike S5 (09 §5, P0-08): does the core serve JSON-RPC over a UNIX socket (and a Windows named
pipe) well from an Electron `utilityProcess`; what does the socket path limit actually do in
Node and Electron; does the OQ-08-05 default ("a per-user directory under `/tmp` with mode
0700, with the path recorded in `<userData>/run/endpoint`") work end to end, including stale
sockets and permissions; does the `cc-axi --version` fast path meet AC-07-02 (within 50 ms of
`node -e "console.log(1)"`); and what does the `axi-sdk-js` home view really look like?

## Method

- **Versions.** The design pins none, so the latest of each was used: Electron 45.2.3
  (bundles Node 24.22.2, Chrome 156), `axi-sdk-js` 0.1.14 (one dependency,
  `@toon-format/toon` 2.3.1), system Node 22.23.2 for clients and benchmarks, and `esbuild`
  0.25.10 with `postject` 1.0.0-alpha.6 for the single-executable experiment. P1 pins
  versions deliberately; Electron 45.2.3 was under two weeks old.
- **Host.** Linux x86_64 only: a Debian 12 container, kernel 7.0.0-38, 14 CPUs, load about
  1.0. Electron's missing system libraries were unpacked locally (no system install) and it
  ran with `--no-sandbox --ozone-platform=headless --disable-gpu`; `--no-sandbox` affects only
  the renderer sandbox, not sockets, the `utilityProcess` or IPC. macOS and Windows were
  reasoned from cited sources, not run.
- **Where each part ran.** Real Electron (main plus the core in a `utilityProcess`): the core
  server for all latency runs, the MessagePort comparison, the home view, the OQ-08-05
  scenario suite, the concurrency run and the path-length boundary. The Electron binary as
  Node (`ELECTRON_RUN_AS_NODE=1`): the alternatives test and `--version` variant F. Plain Node
  22: every client, the headless-core comparison, and the single executable.
- **Prototype.** A throwaway project with an endpoint module (plan, prepare, record,
  discover; [prototype.md](0002-local-api-and-cli/prototype.md)), JSON-RPC lines with
  `auth.hello` and a timing-safe token compare, a `utilityProcess` core with a watchdog and
  graceful stop, an Electron main, a 39-check scenario suite and five benchmarks (RPC round
  trip, `--version`, home view end to end, 200 concurrent clients, path length).
- **Measurement rules.** Round trips timed with `performance.now()` in a separate client
  process. `--version` variants timed with `spawnSync`, interleaved round-robin after 5
  warm-up runs, N = 100 or 200, and compared with the floor in the same run: pass when both
  the median difference (d50) and the p95 difference (d95) are at most 50 ms.

Options tried:

| #   | Option                                                                             | Result                                                                                      |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A1  | Core serves the socket from a `utilityProcess` (the design)                        | Works; sub-millisecond round trips; fork to listening 37–52 ms; no TCP listener (AC-04-08)  |
| A2  | The same core under plain Node (headless, 04 §3)                                   | Works with identical code; `home.get` p95 0.104 ms                                          |
| B1  | OQ-08-05 fallback with a fixed name `/tmp/command-center-<uid>/<profile-key>.sock` | Works, but another local user can pre-create the directory and deny service                 |
| B2  | OQ-08-05 fallback with `mkdtemp`: `/tmp/command-center-<uid>-XXXXXX/cc.sock`       | Works; created 0700, cannot be pre-created; 39 of 39 checks pass. Recommended               |
| B3  | Bind a relative `cc.sock` after `chdir` into `<userData>/run`                      | Every client must `chdir` too; the socket file is left behind after `close()`. Rejected     |
| B4  | Linux abstract socket                                                              | No file, so no permissions; absent on macOS. Rejected                                       |
| B5  | Let Node handle long paths                                                         | Unsafe: Node 22 silently truncates and binds outside the private directory. Rejected        |
| C1  | Stale socket: connect first, unlink only on `ECONNREFUSED`, refuse otherwise       | Works: crash recovery, second instance refused, first instance stays reachable              |
| C2  | Prior art: unlink unconditionally, then listen                                     | A second instance orphans a live first one. Rejected                                        |
| D1  | `cc-axi` on system Node: `tryFastPath()` leaf, then a dynamic import of the CLI    | AC-07-02 passes: +3.0 ms median                                                             |
| D2  | D1 through a PATH symlink with a shebang                                           | Passes: +2.0 to +3.3 ms median                                                              |
| D3  | No fast path (`runAxiCli()` answers `--version` after loading everything)          | Passes but uses half the budget: +16.9 ms median, +23.5 ms p95                              |
| D4  | One bundled CommonJS file on system Node                                           | +1.3 ms median, +2.2 ms p95                                                                 |
| D5  | The Electron binary as Node                                                        | +16.6 / +23.5 ms; unavailable once the `RunAsNode` fuse is off (04 §10)                     |
| D6  | Node single executable (SEA) built from D4                                         | At the floor (−0.8 ms median), home view 30 ms; but 120 MB, CommonJS only, "Stability: 1.1" |
| D7  | Electron main answers `--version` and exits before `ready`                         | +30.2 / +38.2 ms; no headroom for Windows. Rejected                                         |
| E1  | Windows named pipe                                                                 | Reasoned only: the fixed name breaks C-08-05 and anyone can squat it                        |

## Result

**Transport.** Over the socket from the `utilityProcess` (three runs), `home.get` on a
persistent connection has p50 0.034–0.051 ms and p95 0.053–0.071 ms; a fresh connection
(connect, `auth.hello`, `home.get`, close: what one `cc-axi` call does) has p95
0.245–0.301 ms. Plain Node 22 is the same order (`home.get` p95 0.104 ms). The 04 §12 budget
for this path is 150 ms. 200 concurrent clients all succeeded in 40.9 ms wall clock (per-client
p95 37.7 ms). A call before `auth.hello`, or with a wrong token, returns `E_FORBIDDEN`.
`lsof` shows no TCP listener for main or core (AC-04-08).

**AC-07-02: passes on Linux.** The fast path (B) measured d50 3.03 / 2.95 / 4.61 ms and d95
6.32 / 2.93 / 3.31 ms over three runs, a margin of about 44 ms. The full home view (discover,
connect, `auth.hello`, `home.get`, render TOON) takes p50 about 47–51 ms on system Node and
30 ms as a single executable.

**Path limit (Linux, measured).** Paths of 100–108 bytes bind and connect in both Node 22 and
Node 24. Above 108 bytes, Node 22 **silently truncates** to 108 bytes for both `listen` and
`connect`, while Node 24 (Electron's) returns `EINVAL`. In the alternatives test, Node 22
given a 123-byte `<userData>/run/cc.sock` created a socket named `Command Cen` next to
`<userData>`, outside the 0700 directory, with mode 755, and reported success. Node documents
the usable limit as `sizeof(sun_path) − 1`: 107 bytes on Linux, 103 on macOS. Computed
defaults are short (46 bytes on Linux and 67 on macOS for a 5-character user name), so the
fallback is rare in production: long `--profile-dir` paths, worktree paths, odd home
directories. A test profile under the macOS `$TMPDIR` with a 40-character name already
exceeds the limit, so 08 §8's short test base paths stay necessary.

**OQ-08-05 holds.** Under real Electron, a 156-byte preferred path fell back to a 39-byte
socket in a `mkdtemp` directory, recorded in `<userData>/run/endpoint`; the client found it
through the record and connected. Graceful stop, crash and restart, a second instance,
deletion by a cleaner (watchdog) and planted unsafe fixtures all behaved: 39 of 39 checks
passed. It is safe only with four conditions, none of which changes the default's shape:

1. The directory name is unguessable (`mkdtemp`), not a fixed per-user name.
2. Both sides verify: every directory is owned by the uid, mode 0700 and not a symlink; the
   socket is a socket; the record is mode 0600. The client verifies before it sends a token.
3. Probe before unlink: never remove a live socket or anything that is not a socket; remove a
   stale previous fallback through the old record.
4. A watchdog binds again after a `/tmp` cleaner deletes the socket or the directory.

**Home view and `axi-sdk-js` 0.1.14 findings.** The real output is in
[measurements.md §4](0002-local-api-and-cli/measurements.md#4-home-view). It differs from the
07 §4.3 and §4.4 examples: `help[n]` renders on one comma-joined line, values containing `:`
or `,` are quoted, and errors print `error:`, `code:` and `help[n]:`. The SDK maps only
`VALIDATION_ERROR` to exit 2, does not export its renderers, rejects any flag before the
command (so `cc-axi --principal x` and `cc-axi --format json` are impossible), and ships a
built-in `update` that queries the npm registry.

**Limits.** Linux only; macOS and Windows are reasoned. The other-uid directory check was
simulated (no root to create another user's directory). The Windows `.cmd` shim's cost
against AC-07-02 is unmeasured. Measured-versus-reasoned per OS is in
[measurements.md §9](0002-local-api-and-cli/measurements.md#9-measured-versus-reasoned).

## Decision

The owner chose option (a) on all three open choices on 2026-11-10. Together with the
spike's proposed decision, this record decides:

1. **Transport stays as designed:** JSON-RPC 2.0 lines over a UNIX socket (a named
   pipe on Windows), served by the core in a `utilityProcess`.
2. **The endpoint record is always written,** on every OS, not only for the
   fallback: `<userData>/run/endpoint`, mode 0600, written to a temporary file and renamed,
   one JSON line `{"v":1,"transport":"unix"|"pipe","path":…,"fallbackDir"?:…,"pid":…,"startedAt":…}`.
   Clients read the record first and compute the default path only when the record is
   missing and the default is short enough.
3. **The limit is `sizeof(sun_path) − 1` in UTF-8 bytes:** 107 on Linux, 103 on
   macOS. Both server and client check the length before any bind or connect, because a
   client on Node 22 truncates silently.
4. **OQ-08-05 is closed with option (a):** when the preferred path is too long,
   `mkdtemp('/tmp/command-center-<uid>-')` creates a per-user 0700 directory and the socket
   goes at `<dir>/cc.sock`, found only through the record, with the four conditions above:
   - verify before trusting (directories, socket and record as in condition 2; the client
     before it sends a token);
   - probe before unlink: `ECONNREFUSED` means stale and is unlinked, a live socket means
     `E_ALREADY_RUNNING`, a non-socket means `E_ENDPOINT_UNSAFE` and is never deleted; a
     stale fallback directory from a crashed run is found through the old record and
     removed; Electron's single-instance lock stays the first defence;
   - umask 077 around `listen()`, then `chmod 0600`, so the socket is never wider;
   - a watchdog every 60 s checks the bound inode, rebinds a deleted socket, and creates a
     new directory and rewrites the record if the directory is gone;
   - graceful stop: `server.close()`, remove the record if its `pid` is ours, remove the
     fallback directory.

   Not chosen: (b) the literal default, a fixed `/tmp/command-center-<uid>`, simpler to
   inspect but squattable by other local users; (c) as (a) but preferring
   `$XDG_RUNTIME_DIR` on Linux, a second code path for a small gain with no macOS
   equivalent.

5. **`cc-axi` runtime for P1 is option (a):** the user's system Node runs one
   bundled `cc-axi` file shipped in the app, through a PATH link or shebang on macOS and
   Linux and a `.cmd` shim on Windows. The bin entry is the `tryFastPath()` leaf plus a
   dynamic import. Accepted risks: the user's Node version can differ (as the truncation
   difference shows), and the Windows shim's latency is unmeasured.

   Not chosen: (b) a Node single executable per OS, fastest and version-pinned with no shim,
   but about 120 MB per platform, a feature in active development, macOS re-signing, and
   arm64-only on macOS in the v24 documentation; (c) turning the `RunAsNode` fuse back on to
   run on Electron's Node, which weakens 04 §10 hardening and measured +16.6 ms anyway.

6. **Local API amendments, option (a), both adopted:**
   - The Windows pipe name gets an unguessable part,
     `\\.\pipe\command-center-<username>-<random>`, recorded in `<userData>\run\endpoint`
     like the UNIX path. This fixes the cross-profile collision (C-08-05) and makes the name
     unpredictable.
   - `auth.hello` becomes mutual-proof: the server first proves it knows the principal's
     token, by an HMAC over a client nonce, before the client sends anything derived from
     the token. This also protects the UNIX fallback.

   Not chosen: (b) only the pipe-name change, which still sends raw tokens to whatever
   answers; (c) keep the design as written and accept the collision and the squatting risk
   as out of scope (04 §4.2 rule 4).

## Consequences

**Gains.** The process model and protocol hold as written for the 04 §12 budgets. One
discovery mechanism, the record, serves the normal path, the fallback and Windows, and
removes the fixed socket and pipe names that C-08-05 forbids. Long paths fail loudly and
safely instead of planting a socket outside the private directory.

**Costs and risks accepted.**

- About 210 lines of endpoint code and its tests go into `@cc/core` (server) and the
  `cc-axi` client; `cc:doctor` reuses the plan function for its warning.
- Two new error codes, `E_ALREADY_RUNNING` and `E_ENDPOINT_UNSAFE` (exit 1), instead of
  hiding the reason behind `E_APP_NOT_RUNNING`.
- A fallback socket in `/tmp` can be aged out by cleaners (systemd-tmpfiles ages `/tmp` at 10
  days); the watchdog repairs it within one interval, and clients get `E_APP_NOT_RUNNING` in
  the gap.
- Windows remains weaker than UNIX: libuv creates the pipe with the default security
  descriptor (Everyone has read access) and without `PIPE_REJECT_REMOTE_CLIENTS`; a stricter
  ACL or a server-owner check needs native code. The token gate and the mutual-proof
  handshake hold.

**Design documents to update (follow-up; not changed in this PR).**

- 04 §4.1 rule 1: the always-written record, the `mkdtemp` fallback, the byte limit, the
  verification rules, and the Windows pipe name with an unguessable part.
- 04 §4.2 rule 1 (`auth.hello`): the mutual-proof handshake.
- 04 §11: a Windows pipe-squatting and default-ACL row.
- 07 §4.4: the codes `E_ALREADY_RUNNING` and `E_ENDPOINT_UNSAFE`.
- 07 §4.3 and §4.4: output examples updated to the SDK's real TOON (measurements.md §4)
  before the AC-07-01 conformance suite is written against them.
- 08 §6 `cc:doctor`: "103 bytes on macOS, 107 on Linux (`sizeof(sun_path)` − 1)" in place
  of 104 and 108.
- 08 §12: OQ-08-05 closed by this record.

**Follow-ups for P1-04, P1-05 and P1-16 (no owner decision needed).**

1. CC's own `formatError` maps `E_USAGE` and `E_UNKNOWN_FLAG` to exit 2; CC depends on
   `@toon-format/toon` directly. The SDK's leading-flag error uses `VALIDATION_ERROR` and
   cannot be overridden, so the AC-07-01 suite accepts that or the SDK gains a hook upstream.
2. Add `cc-axi home`, an alias of the no-argument view that accepts the global flags
   (`--principal`, `--format`); optionally honour `CC_PRINCIPAL`.
3. Register CC's own `update` command to shadow the SDK's npm-based one; settle it together
   with OQ-07-02 (the npm package name, and whether to publish at all).
4. Measure AC-07-02 in CI by interleaving the two commands at least 100 times each after 5
   warm-up runs and comparing median and p95 with the 50 ms budget. Measure the Windows
   `.cmd` shim in the P1-05 Windows CI job; the `netstat` check for AC-04-08 on Windows stays
   in P1-04.

**Open questions.** OQ-08-05 is closed. None opened.

## Evidence

- [measurements.md](0002-local-api-and-cli/measurements.md): round-trip, `--version` and
  home-view tables, the path-length boundary, the alternatives output, computed path
  lengths, the 39-check scenario log, the Windows and macOS reasoning, and the
  measured-versus-reasoned matrix.
- [prototype.md](0002-local-api-and-cli/prototype.md): the endpoint module and the `cc-axi`
  bin entry and exit-code mapping, as run. The full throwaway prototype (benchmarks, the
  scenario suite and raw results) was kept outside the repository with the spike report.
- Sources, fetched 2026-11-09:
  - [N1] Node 22 `net`,
    [Identifying paths for IPC connections](https://nodejs.org/docs/latest-v22.x/api/net.html#identifying-paths-for-ipc-connections):
    truncation to `sizeof(sockaddr_un.sun_path) - 1`, "107 bytes on Linux and 103 bytes on
    macOS"; the flat pipe namespace; pipes removed when the owner exits; `server.close()`
    unlinks the socket.
  - [E1] Electron [utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process);
    [E2] Electron [Fuses: runAsNode](https://www.electronjs.org/docs/latest/tutorial/fuses#runasnode).
  - [W1] Microsoft
    [Named pipe security and access rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights);
    [W2] [GetNamedPipeServerProcessId](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeserverprocessid).
  - [L1] libuv [`src/win/pipe.c`](https://github.com/libuv/libuv/blob/v1.x/src/win/pipe.c)
    (`NULL` security attributes, `FILE_FLAG_FIRST_PIPE_INSTANCE`, no
    `PIPE_REJECT_REMOTE_CLIENTS`); [L2]
    [`src/unix/pipe.c`](https://github.com/libuv/libuv/blob/v1.x/src/unix/pipe.c)
    ("Truncate long paths. Documented behavior.", `UV_PIPE_NO_TRUNCATE`).
  - [U1] [unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html): 108-byte `sun_path`;
    socket permissions ignored on some systems; none for abstract sockets.
  - [S1] [tmpfiles.d(5)](https://www.freedesktop.org/software/systemd/man/latest/tmpfiles.d.html#Age)
    and systemd [`tmp.conf`](https://github.com/systemd/systemd/blob/main/tmpfiles.d/tmp.conf)
    (`q /tmp 1777 root root 10d`).
  - [S2] Node single executable applications,
    [v22](https://nodejs.org/docs/latest-v22.x/api/single-executable-applications.html) and
    [v24](https://nodejs.org/docs/latest-v24.x/api/single-executable-applications.html)
    (CommonJS only; "Stability: 1.1"; v24 lists macOS arm64 only).
- `axi-sdk-js` 0.1.14 code read: `dist/fast-path.js` (`tryFastPath` handles only a single
  `-v`, `-V` or `--version`), `dist/cli.js` (`runAxiCli`, the leading-flag rejection,
  `renderUnknownCommand`, `formatError`, the reserved `update`), `dist/errors.js`
  (`exitCodeForError`).
