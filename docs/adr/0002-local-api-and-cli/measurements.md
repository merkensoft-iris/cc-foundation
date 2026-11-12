# 0002 measurements and evidence

Supporting material for [ADR 0002](../0002-local-api-and-cli.md), condensed from the P0-08
spike report (run 2026-11-09, Linux x86_64). `<prototype>` stands for the throwaway prototype
directory, which is not in this repository.

## 1. Commands

All run from the prototype root. Electron runs with the unpacked system libraries on
`LD_LIBRARY_PATH` and `--no-sandbox --ozone-platform=headless --disable-gpu`.

```text
node bench/rpc-bench.mjs electron 500 300   # x3, plus: node bench/rpc-bench.mjs node 500 300
node bench/version-bench.mjs 100            # A..G
node bench/version-bench.mjs 200 A,B,C
node bench/version-bench.mjs 100 A,B,S,U    # with the single executable built
node bench/home-e2e.mjs 100                 # x2 (the second run adds the single executable)
node bench/concurrency.mjs 200
node bench/pathlen.mjs                      # Node 22
CC_CORE_MODULE=$PWD/bench/pathlen.mjs $ELECTRON <flags> app/main.mjs   # utilityProcess, Node 24
node tests/fallback.mjs                     # 39 checks, real Electron
node tests/options.mjs; ELECTRON_RUN_AS_NODE=1 $ELECTRON tests/options.mjs
node harness/try-home.mjs; node harness/bin-header.mjs
```

## 2. JSON-RPC round trip over the UNIX socket

The client is a separate Node 22.23.2 process; times in milliseconds from `performance.now()`.
"Persistent": one connection, after `auth.hello` and 50 warm-up calls. "Fresh": connect,
`auth.hello`, `home.get`, close per call, after 20 warm-up calls. The `home.get` response is
the 07 §4.3 fixture, 978 bytes on the wire.

| Server                                       | Call                            | n               | p50                   | p95                   | p99                   | max                   |
| -------------------------------------------- | ------------------------------- | --------------- | --------------------- | --------------------- | --------------------- | --------------------- |
| Electron `utilityProcess`, run 1             | `sys.ping`, persistent          | 500             | 0.039                 | 0.076                 | 0.166                 | 0.634                 |
|                                              | `home.get`, persistent          | 500             | 0.035                 | 0.053                 | 0.129                 | 0.288                 |
|                                              | fresh connection                | 300             | 0.126                 | 0.277                 | 0.507                 | 1.275                 |
| Electron `utilityProcess`, run 2             | `sys.ping` / `home.get` / fresh | 500 / 500 / 300 | 0.044 / 0.051 / 0.121 | 0.069 / 0.071 / 0.245 | 0.194 / 0.183 / 0.450 | 0.899 / 0.255 / 0.507 |
| Electron `utilityProcess`, run 3             | `sys.ping` / `home.get` / fresh | 500 / 500 / 300 | 0.040 / 0.034 / 0.169 | 0.079 / 0.056 / 0.301 | 0.260 / 0.144 / 0.477 | 0.725 / 0.343 / 0.631 |
| Plain Node 22.23.2 (headless)                | `sys.ping` / `home.get` / fresh | 500 / 500 / 300 | 0.054 / 0.061 / 0.128 | 0.086 / 0.104 / 0.318 | 0.309 / 0.227 / 0.451 | 0.898 / 0.316 / 0.618 |
| main to core MessagePort (UI path), runs 1–3 | ping                            | 480 each        | 0.044 / 0.046 / 0.041 | 0.100 / 0.074 / 0.063 | 0.200 / 0.214 / 0.145 | 1.12 / 0.78 / 0.80    |

- `utilityProcess.fork` to the core listening, record written: 45.8, 51.8 and 37.1 ms.
  Inside the core, planning to listening takes 2.4 ms.
- The MessagePort run overlapped the socket run, so both include some contention.
- 200 concurrent clients (connect, `auth.hello`, `home.get`, close, all at once): 200 of 200
  succeeded in 40.9 ms wall clock; per-client p50 20.0 ms, p95 37.7 ms, max 37.8 ms.
- A call before `auth.hello` returns `E_FORBIDDEN` ("call auth.hello first"); a wrong token
  returns `E_FORBIDDEN` ("bad token").

## 3. AC-07-02: `--version` against `node -e "console.log(1)"`

Wall-clock milliseconds of `spawnSync` from Node 22.23.2, variants interleaved round-robin
after 5 warm-up runs each. d50 and d95 are differences from the floor (A) in the same run.
Pass rule: d50 ≤ 50 and d95 ≤ 50.

| Variant                                                     | Run (N) | p50   | p95   | max   | d50   | d95   | AC-07-02                   |
| ----------------------------------------------------------- | ------- | ----- | ----- | ----- | ----- | ----- | -------------------------- |
| A floor `node -e "console.log(1)"`                          | 1 (100) | 25.69 | 33.18 | 43.71 | 0     | 0     |                            |
| **B `node bin/cc-axi.mjs --version` (fast path)**           | 1 (100) | 28.72 | 39.49 | 44.63 | 3.03  | 6.32  | **pass**                   |
| C `cc-axi --version` through a PATH symlink with a shebang  | 1 (100) | 27.73 | 37.15 | 48.57 | 2.04  | 3.97  | pass                       |
| D no fast path (full `runAxiCli` graph)                     | 1 (100) | 42.61 | 56.69 | 61.71 | 16.92 | 23.51 | pass                       |
| E script that imports nothing                               | 1 (100) | 26.25 | 35.60 | 45.89 | 0.56  | 2.42  | pass                       |
| F `ELECTRON_RUN_AS_NODE=1 electron bin/cc-axi.mjs`          | 1 (100) | 42.25 | 56.70 | 62.56 | 16.56 | 23.52 | pass (fuse off in release) |
| G Electron main prints the version and exits before `ready` | 1 (100) | 55.84 | 71.37 | 92.08 | 30.15 | 38.20 | pass, little headroom      |
| A floor                                                     | 2 (200) | 23.84 | 30.39 | 34.75 | 0     | 0     |                            |
| **B fast path**                                             | 2 (200) | 26.79 | 33.32 | 41.60 | 2.95  | 2.93  | **pass**                   |
| C PATH symlink                                              | 2 (200) | 27.17 | 36.56 | 47.51 | 3.34  | 6.17  | pass                       |
| A floor                                                     | 3 (100) | 22.49 | 28.99 | 32.30 | 0     | 0     |                            |
| B fast path                                                 | 3 (100) | 27.10 | 32.30 | 35.95 | 4.61  | 3.31  | pass                       |
| S Node single executable (Node 22.23.2, code cache on)      | 3 (100) | 21.73 | 28.04 | 31.89 | −0.75 | −0.95 | pass                       |
| U one bundled CommonJS file on system Node                  | 3 (100) | 23.74 | 31.16 | 33.36 | 1.26  | 2.17  | pass                       |

The full call, `cc-axi` with no arguments (start, discover the endpoint, connect,
`auth.hello`, `home.get`, render TOON) against the running Electron core, N = 100 each,
interleaved:

| Variant                       | Run | p50   | p95   | max   | d50 vs floor | d95 vs floor |
| ----------------------------- | --- | ----- | ----- | ----- | ------------ | ------------ |
| ESM files on system Node      | 1   | 50.98 | 68.42 | 75.40 | 25.54        | 30.81        |
| ESM with `NODE_COMPILE_CACHE` | 1   | 48.31 | 70.12 | 80.03 | 22.87        | 32.52        |
| ESM files on system Node      | 2   | 47.21 | 51.92 | 59.57 | 24.37        | 21.60        |
| ESM with `NODE_COMPILE_CACHE` | 2   | 43.74 | 51.80 | 64.58 | 20.90        | 21.48        |
| Single executable             | 2   | 30.19 | 35.96 | 41.09 | 7.35         | 5.65         |

## 4. Home view

From the prototype against the real Electron core with `axi-sdk-js` 0.1.14, verbatim except
that local paths are shortened to `<prototype>`. The data is the 07 §4.3 reference fixture.

```text
$ cc-axi                      # app not running
error: Command Center is not running (no local API at <prototype>/runs/p-home/run/cc.sock)
code: E_APP_NOT_RUNNING
help[1]: "Open Command Center, then retry"
[exit 1]

$ cc-axi                      # app running (electron-utilityProcess, node 24.22.2, electron 45.2.3)
bin: <prototype>/bin/cc-axi.mjs
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
[exit 0]

$ cc-axi --version
0.0.1-s5
[exit 0]

$ cc-axi items list --stat
error: unknown flag --stat for `items list`
code: E_UNKNOWN_FLAG
help[1]: "valid flags for `items list`: --workstream, --owner, --state, --health, --due-before, --fields, --limit, --format, --principal (--help always allowed)"
[exit 2]

$ cc-axi --principal cli-default
error: Flags must come after the command
code: VALIDATION_ERROR
help[2]: "Run `cc-axi.mjs <command> [args] [flags]`",Move `--principal` after the command instead of before it
[exit 2]
```

The `bin:` header shows the PATH symlink when run through one (what 07 §4.3 expects, such as
`~/.local/bin/cc-axi`), and the binary's own path for a single executable.

## 5. Socket path length boundary (Linux, measured)

The benchmark listens on a path of exactly L bytes, then connects with the same full path from
the same runtime.

| L (bytes)     | Node 22.23.2 `listen`       | file created     | client connect              | Node 24.22.2 `utilityProcess` `listen` | client connect |
| ------------- | --------------------------- | ---------------- | --------------------------- | -------------------------------------- | -------------- |
| 100–107       | ok                          | at L bytes       | ok                          | ok                                     | ok             |
| 108           | ok                          | at 108 bytes     | ok                          | ok                                     | ok             |
| 109, 110, 120 | **ok (silently truncated)** | **at 108 bytes** | ok (truncates the same way) | **`EINVAL`**                           | `EINVAL`       |

Node 22 documents truncation to `sizeof(sockaddr_un.sun_path) - 1` ("107 bytes on Linux and
103 bytes on macOS"). libuv's `src/unix/pipe.c` truncates by default and returns `UV_EINVAL`
with `UV_PIPE_NO_TRUNCATE`; Node 24 behaves as if that flag is set. Linux accepted 108 non-NUL
bytes in both versions, a case unix(7) covers under BUGS; the decision uses 107.

## 6. Alternatives and the truncation hazard

```text
node 22.23.2
O1 relative bind: absolute path would be 155 B; listen('cc.sock') after chdir -> ok; file exists at absolute path: true
O1 client connect(absolute 155 B) -> ENOENT
O1 client chdir + connect('cc.sock') -> ok
O1 after server.close() with cwd restored: socket file still at absolute path: true
O2 abstract socket listen -> ok; connect -> ok; chmod not applicable (no inode)
O3 listen(<userData>/run/cc.sock, 123 B) -> ok; intended file exists: false; extra entries next to <userData>: "Command Cen" socket=true mode=755
O3 client connect(same long path) -> ok
node 24.22.2 (Electron binary as Node)
O1 … client connect(absolute 155 B) -> EINVAL; chdir + connect -> ok; socket file left after close: true
O3 listen(<userData>/run/cc.sock, 123 B) -> EINVAL; client connect -> EINVAL
```

O3 is why the client checks the length itself: the CLI runs on whatever Node the user has
(≥ 20), and on Node 22 a too-long path silently binds or connects somewhere else.

## 7. Default path lengths (computed)

| Path                                                                                        | Bytes   | Limit                                      |
| ------------------------------------------------------------------------------------------- | ------- | ------------------------------------------ |
| macOS `/Users/<u>/Library/Application Support/Command Center/run/cc.sock`, 5-character user | 67      | 103: fits user names up to 41 bytes        |
| Linux `/home/<u>/.config/Command Center/run/cc.sock`, 5-character user                      | 46      | 107: fits user names up to 66 bytes        |
| Test profile under the macOS `$TMPDIR` (`/var/folders/zz/<28>/T/`), `cc-test-abcdef`        | 75      | a 40-character test name reaches 109: over |
| 08 §8 test profile `/tmp/cc-test-<6>`                                                       | 31      | fine                                       |
| Fallback `/tmp/command-center-1000-XXXXXX/cc.sock` (`/private/tmp/…` on macOS)              | 39 (46) | fine                                       |

## 8. OQ-08-05 scenario suite: real Electron, 39 of 39 pass

The long `<userData>` is `<prototype>/runs/long/a-deeply-nested-profile-directory-to-push-the-socket-path-over-the-limit/Command Center`,
so the preferred socket path is 156 bytes, over the 107-byte limit. The watchdog interval is
500 ms in the suite (60 s in the decision).

```text
S0 short userData (84 B socket path)
  [PASS] core listens on <userData>/run/cc.sock
  [PASS] socket 0600, run dir 0700 -- 600 / 700
  [PASS] endpoint record written even without fallback
  [PASS] cc-axi home view via record -- exit 0, 51.4 ms
S1 long userData: preferred socket path 156 B > max 107 B
  [PASS] core falls back -- /tmp/command-center-1000-RBAhkR/cc.sock (39 B)
  [PASS] fallback dir is under /tmp and per-user
  [PASS] fallback dir mode 0700, owned by this uid, not a symlink -- mode 700 uid 1000
  [PASS] socket mode 0600
  [PASS] path recorded in <userData>/run/endpoint (mode 0600) -- {"v":1,"transport":"unix","path":"/tmp/command-center-1000-RBAhkR/cc.sock","fallbackDir":"/tmp/command-center-1000-RBAhkR","pid":2348923,"startedAt":"2026-11-09T21:17:41.443Z"}
  [PASS] client discovers the fallback through the record
  [PASS] cc-axi home view connects through the fallback -- exit 0, 47.7 ms
  [PASS] AC-04-08: lsof shows no listening TCP socket for main or core -- none
  [PASS] lsof shows the core holding the UNIX socket -- electron 2348923 … /tmp/command-center-1000-RBAhkR/cc.sock type=STREAM (LISTEN)
S2 graceful stop (SIGTERM to main)
  [PASS] socket removed
  [PASS] fallback dir removed
  [PASS] endpoint record removed
  [PASS] cc-axi then reports E_APP_NOT_RUNNING, exit 1 (58.8 ms)
S3 crash (SIGKILL main + core) then restart
  [PASS] after SIGKILL the socket file is left behind (stale)
  [PASS] and the record still points at it
  [PASS] cc-axi against the stale socket: E_APP_NOT_RUNNING (ECONNREFUSED), no hang (37 ms)
  [PASS] restart probes the old socket, finds it stale, removes old dir -- old fallback /tmp/command-center-1000-yFHEUW: unlinked-stale, removed; created /tmp/command-center-1000-qyxJow
  [PASS] old fallback dir gone, new one in use
  [PASS] cc-axi works after restart -- 49.2 ms
S4 second instance, same profile, first alive
  [PASS] second instance refuses with E_ALREADY_RUNNING
  [PASS] first instance still reachable
S6 socket or fallback dir deleted under a live server (watchdog every 500 ms)
  [PASS] socket deleted -> clients get E_APP_NOT_RUNNING
  [PASS] watchdog re-binds the same path; clients reconnect
  [PASS] whole dir deleted -> watchdog makes a new dir and re-records it; clients reconnect
S5 permission checks (planted fixtures under /tmp/cc-s5-fixtures as the tmp root)
  [PASS] fixed name, dir planted 0755 by us: server chmods to 0700 and starts
  [PASS] fixed name, dir is a symlink: server refuses (E_ENDPOINT_UNSAFE)
  [PASS] a regular file at the socket path: server refuses and leaves it
  [PASS] client: live fallback endpoint verifies
  [PASS] client: dir owned by another uid -> refuses before sending a token (simulated uid)
  [PASS] client: fallback dir loosened to 0755 -> refuses
  [PASS] client: endpoint record readable by others (0644) -> refuses
  [PASS] client: record points at a non-socket -> refuses
  [PASS] restored record: cc-axi works again
S7 prior art: unconditional unlink, two instances
  [PASS] second instance unlinks the live socket and binds the same path
  [PASS] after the second stops, the first is still running but unreachable (orphaned)
39/39 checks passed
```

Limits: the other-uid check is simulated (the client is told to expect uid 1001), because a
directory owned by another user cannot be created without root. Planted fixtures used a
private tmp root so they could not collide with anything real in `/tmp`, and every `/tmp`
entry the suite created was removed afterwards. S7 reproduces the prior art of an earlier
local-socket app in the owner's private workie repository, which
creates the directory 0700 and unlinks the socket unconditionally.

## 9. Measured versus reasoned

| Claim                                                   | Linux                                                                             | macOS                                                     | Windows                                        |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------- |
| Core serves JSON-RPC from a `utilityProcess`            | **Measured**                                                                      | Reasoned (same code)                                      | Reasoned                                       |
| Round-trip latency, 200 concurrent clients, auth errors | **Measured**                                                                      | Not measured                                              | Not measured                                   |
| No TCP listener (AC-04-08)                              | **Measured** (`lsof`)                                                             | Reasoned                                                  | Reasoned (`netstat` check stays in P1-04)      |
| AC-07-02 `--version` fast path                          | **Measured: passes** (d50 3–5 ms, d95 3–6 ms)                                     | Reasoned: likely to pass                                  | **Unmeasured risk** (`.cmd` shim)              |
| Home view output                                        | **Measured**                                                                      | Same SDK output                                           | Same SDK output                                |
| Path limit and its behaviour                            | **Measured:** 108 bytes work; above, Node 22 truncates and Node 24 returns EINVAL | Reasoned: 103 usable bytes                                | Not applicable (pipe)                          |
| OQ-08-05 fallback, record, stale cleanup, permissions   | **Measured:** 39 of 39 under real Electron; other-uid simulated                   | Reasoned: same code; `/private/tmp`; socket mode ignored? | Not applicable; pipe amendments reasoned (§10) |
| Relative-bind and abstract-socket alternatives          | **Measured** on Node 22 and 24 (not in a `utilityProcess`)                        | Reasoned (no abstract sockets)                            | Not applicable                                 |
| Single-executable `cc-axi`                              | **Measured** (Node 22.23.2)                                                       | Reasoned: re-signing, arm64 only in v24                   | Reasoned: no shim                              |
| Pipe squatting, default ACL, no remote-client rejection | Not applicable                                                                    | Not applicable                                            | Reasoned                                       |

## 10. Windows named pipe (reasoned, unmeasured)

1. **Server side.** `net.createServer().listen('\\\\.\\pipe\\…')` is the same code path in
   Node and a `utilityProcess`. Windows removes the pipe when the owner exits, so no stale
   cleanup is needed, and no `chmod` or umask applies.
2. **The fixed name breaks C-08-05.** `\\.\pipe\command-center-<username>` is shared by every
   profile of a user, so two worktrees or test runs collide; the second `listen` fails with
   `EADDRINUSE` because libuv creates the first instance with `FILE_FLAG_FIRST_PIPE_INSTANCE`.
3. **Anyone can squat the name.** The pipe namespace is flat and machine-wide. A process that
   creates the name first denies service, and if it does so while CC is not running,
   `cc-axi` connects to it and sends its token in `auth.hello` (the 0700 directory prevents
   this on UNIX). Node cannot check the pipe server's owner; `GetNamedPipeServerProcessId`
   plus a token-user check needs native code. The mitigations within Node are an unguessable
   name recorded in the per-user profile (`%APPDATA%`) and a mutual-proof handshake (adopted,
   ADR decision 6).
4. **Default access.** libuv passes `NULL` security attributes, so the creator owner has full
   control and Everyone and anonymous have read access; a read-only client cannot write
   `auth.hello`. libuv does not set `PIPE_REJECT_REMOTE_CLIENTS`. Low risk on a personal
   laptop with the token gate; a stricter ACL needs native code.
5. **`--version` on Windows.** An npm-style `cc-axi.cmd` runs `cmd.exe` then `node`, and its
   cost counts against AC-07-02's 50 ms. Unmeasured; measure it in the P1-05 Windows CI job. A
   single executable has no shim.

The Microsoft `CreateNamedPipeW` reference page returned 404 during the spike, so the
name-length limit and flag documentation were not retrieved from Microsoft.

## 11. macOS (reasoned, unmeasured)

- The limit is 103 usable bytes; the default path fits user names up to 41 bytes.
- `/tmp` is a symlink to `/private/tmp`; the checks `lstat` only the final component, so this
  is unaffected, and the fallback is 46 bytes resolved.
- BSD-derived systems may ignore socket file permissions; the 0700 directory is the control,
  never the socket mode alone.
- Age-based cleanup of `/tmp` is reported but unverified; the watchdog covers it either way.
- A macOS single executable needs re-signing after `postject` (not verified), and the v24
  documentation restricts it to arm64.
