# 0006. S8 Verifiable packages from a private connectors repository

- **Status:** accepted
- **Date:** 2026-11-11
- **Task:** P0-12 (spike S8, scout)
- **Closes:** OQ-05-07
- **Spec:** 05 §4, §15.1, §15.6, §18 (C-05-03), §19 (AC-05-02, AC-05-08), §20; 06 §11.2; 08 §5.2,
  §6, §9; 04 §11; 09 §5 (P0-12) and §10 (P5-05, P5-06, gate P5)

## Question

How does a user's connectors repository CI produce packages that CC verifies by sha256 pin
(05 §15.6, C-05-03), and are GitHub artifact attestations available for private repositories
on the owner's plan (OQ-05-07)? The spike also had to say exactly what CC runs to verify a
package, what that proves, and what the design does not yet cover.

## Method

A local prototype (Linux x86_64, Debian 12 container) of the three parts: a connectors
repository with a deterministic packer and release workflow, an engine with `cc:include` and a
lock check, and CC's lock loader. Long material is in
[0006-s8-verifiable-packages/](0006-s8-verifiable-packages/).

- **Toolchain:** Node 22.23.2 (zlib 1.3.1) on the host, cross-checked on Node 24.22.2 (zlib
  1.3.2.1, Electron 45's Node line, checked against `SHASUMS256.txt`); esbuild 0.25.10; gh
  2.101.0; actionlint 1.7.12 (without shellcheck); GNU tar 1.34, gzip 1.12 and npm 10.9.8 for the
  alternative packers. Workflows pin `actions/checkout` v7.0.1, `actions/setup-node` v7.1.0 and
  `actions/attest` v4.2.2 by commit SHA.
- **Fixture:** connector `hello-echo` 1.0.0, tag `hello-echo@1.0.0`, four files
  (`connector.json`, `dist/index.js`, `README.md`, `CHANGELOG.md`; 05 §4).
- **Packaging:** four packers compared (P1 in-house `cc:pack`, P2 `npm pack`, P3 GNU tar piped to
  `gzip -9n`, P4 the template without `.gitattributes`) plus the compressor (P5) across a
  determinism matrix of clones, paths, umask, TZ, locale, file modes, mtimes, Node versions and
  a CRLF checkout.
- **Trust:** five options beside the pin (V1 pin only, V2 build-provenance attestations, V3
  immutable releases and their release attestation, V4 a rebuild check, V5 engine CI comparing
  the pin with GitHub's server-side asset `digest`).
- **Download:** an in-test double of GitHub's private-repository release API on loopback (404
  without a valid token, asset metadata with a `digest`, `Accept: application/octet-stream`
  answered by a 302 to a second origin). A 37-check suite (T1–T11) ran on Node 22 and Node 24.
- **Attestation mechanics:** measured on a public immutable release (`cli/cli` v2.103.3) with
  `gh release verify`, `gh release verify-asset` and `gh attestation verify` online and offline.
- **Plan availability:** read-only GitHub API queries of the owner's organisations, and GitHub's
  docs, pricing page and action READMEs fetched on 2026-11-10.
- **Live probe (11 Nov 2026, owner decision 3):** one throwaway private repository in the
  owner's GitHub Team organisation, release immutability on, the fixture and its release
  workflow pushed unchanged, two of the three allowed workflow runs (run 1 with the attest step
  on, run 2 with it off), then the download path and the prototype tools run against the live
  release. The repository was deleted afterwards and confirmed gone.

## Result

**Packaging.** The in-house packer (P1) is reproducible: the same 1,152-byte package
(`59ae2ad6dbbc0b847fe9828b0108edabe23852454785efe9e0182b9ff51b3e96`) came from two clones at
different paths, umask 022 and 077, TZ UTC and Asia/Kolkata, different locales, scrambled modes
and mtimes, Node 22 and Node 24, a CRLF checkout with `.gitattributes`, and GitHub's
`ubuntu-24.04` runner (twice per run). 20 repeated builds gave one sha256.

- `npm pack` (P2) copies file modes from disk (644 and 600 gave different hashes) and needs a
  `package.json` the package format lacks. Rejected.
- GNU tar plus gzip (P3) is reproducible only with `--mode`, its flags are GNU-only, and GNU
  gzip's bytes differ from zlib's. Rejected.
- Without `.gitattributes` (P4), `core.autocrlf=true` put 27 CR bytes into `connector.json` and
  changed the hash. With `* -text` it is unchanged.
- Node 22's and Node 24's zlib gave identical `.tgz` bytes at 1 KiB to 16 MiB on x64; GNU
  `gzip -9n` differed at every size (P5). Other architectures were not measured.

**Verification (V1).** The pin alone refuses one flipped bit, an edited pin, an asset swapped
after the include PR merged (in engine CI and in the loader) and a release record that lies
about the sha256. 37 of 37 checks pass on both Node versions, including **AC-05-08** (T2, T3):
a mismatched package is refused with `E_SIGNATURE` before anything is unpacked, and the
last-known-good version stays active. With a correct pin, eight unsafe archives (symlink, hard
link, `..` path, absolute path, pax header, duplicate path, trailing data, a gzip bomb) are each
refused with `E_PACKAGE_UNSAFE` and user data is untouched. The loader takes 1.4–4.2 ms for the
fixture and 68.5 ms (Node 22) / 72.0 ms (Node 24) for a 4.6 MB package over loopback; against
the live private release it took 555 ms, 552 ms of it the download.

**Build-provenance attestations (V2) are not available** for private repositories on Free, Pro
or Team. Every GitHub source that states plan availability says private and internal
repositories need GitHub Enterprise Cloud. The design's "pages disagree" is resolved: the other
pages describe _how_ private repositories are signed (GitHub's own Sigstore instance), not _who_
may use it, and the plan box appears only in the rendered page, not in the Docs body API. The
live probe confirmed it on Team: `actions/attest` v4.2.2 signed, but storing the attestation
failed with "Feature not available for the … organization. To enable this feature, please
upgrade the billing plan, or make this repository public.", which fails the release job. The
owner confirmed that their organisations are on Team and Free, so no organisation that could
hold the connectors repository is on Enterprise Cloud.

**Immutable releases (V3) work on a Team private repository** (live probe): the release came out
`immutable: true`, deleting an asset returned HTTP 422 "Cannot delete asset from an immutable
release", and the draft-attach-publish sequence put all three assets under it. Each immutable
release automatically gets a **release attestation**, also on Team: `gh release verify` and
`verify-asset` pass and a one-byte-appended file is refused (exit 1). It is signed by GitHub's
release service (SAN `https://dotcom.releases.github.com`, no transparency log, one RFC 3161
timestamp) and binds asset digests, repository, tag and commit, but **not** the workflow that
built them.

**Rebuild check (V4)** works with no plan feature: MATCH three times out of three in 360–421 ms,
and MISMATCH (exit 1) for a pin of bytes not built from that commit. **Server-side digest
(V5):** GitHub's asset `digest` matched the local sha256 on public assets and on the live
private release, so engine CI can check the pin without downloading; the REST schema allows
`digest` to be `null`, so the check must then download.

**Download path.** On the live private release: no token gives 404; a token with access gives a
302 to a presigned `release-assets.githubusercontent.com` URL, which answers 200 with no
`Authorization` header, so Node `fetch` dropping that header across origins (T1h) is harmless.
`cc:include`, the lock check and the loader all worked against it, and a changed pin gave
`E_SIGNATURE` before unpacking. The probe used a classic token; **a fine-grained token with
Contents: read is documented by GitHub but unmeasured.** The design gives CC no token that can
read the connectors repository (06 §11.2: Issues only, no Contents).

Measured versus reasoned claims, the full tables and the sources are in
[measurements.md](0006-s8-verifiable-packages/measurements.md).

## Decision

The owner chose option (a) on all three open choices (10 Nov 2026).

1. **OQ-05-07 is closed: the user-merged sha256 pin is the only trust anchor, with no artifact
   attestations.** C-05-03 is unchanged. The pin is the sha256 of the exact published `.tgz`
   bytes, 64 lowercase hex characters; anything else is `E_LOCK_INVALID`. Two plan-independent
   rules are added:
   - connector releases are **immutable** (a repository setting); `cc:include` refuses a
     mutable release (`E_RELEASE_MUTABLE`);
   - `cc:include` **rebuilds** the package from the tag's commit on `main` and requires a
     matching `contentDigest` before it writes the pin, which binds the pin to the reviewed
     source.

   The connectors template keeps a build-provenance attest step that is off by default
   (`if: vars.CC_ATTEST == 'true'`), for users whose connectors live in an Enterprise Cloud
   organisation; if used, only engine CI checks it, never the app.

   Not chosen: (b) the pin only, with no immutability or rebuild rule, which leaves the
   package-to-source binding to the release job's main-only tag check and review; (c) as (a)
   plus CC verifying GitHub's release attestation in the app, which would ship Sigstore
   verification code and a GitHub trusted root that must be refreshed (six CA rotations since
   October 2023) and adds little beyond immutability plus the pin.

2. **Connectors read credential:** a second fine-grained token (or GitHub App installation)
   limited to the connectors repository with **Contents: read and Metadata: read only**. CC's
   host holds it as the secret of its own binding (for example `github-connectors-read`); only
   the lock loader uses it and it never reaches an agent. Engine CI gets the same scope as the
   Actions secret `CC_CONNECTORS_READ_TOKEN`. The engine token's "no Contents access" rule is
   unchanged.

   Not chosen: (b) vendor packages into the engine repository (binary files in history, a
   wider path guard and C-08-09 scope, a change to 05 §15.6); (c) borrow the machine's `gh`
   login (an external CLI dependency and a broad token over every private repository).

3. **The live probe** was approved and run (results above); not chosen was relying on the docs
   and settings endpoints alone.

What the decision fixes for P5 (the prototype is in
[prototype.md](0006-s8-verifiable-packages/prototype.md)):

- **`cc:pack` in `@cc/build`.** ustar; paths of at most 100 bytes under `package/`, sorted by
  bytes; regular files only; mode 0644, uid and gid 0, empty user and group names, mtime
  499162500; gzip level 9, memLevel 9, MTIME 0, no file name, OS byte 255; `dist/` built in
  memory. The template pins Node exactly (`.nvmrc`) and esbuild exactly, ships `.gitattributes`
  with `* -text`, and packs twice in CI and compares with `cmp`. Rebuilds elsewhere compare
  `contentDigest`, the sha256 of the uncompressed tar.
- **Release assets:** `<id>-<version>.tgz`, `<id>-<version>.tgz.sha256` (`sha256sum` format) and
  `<id>-<version>.release.json` (`cc.repo-release/1`: `sha256`, `contentDigest`,
  `permissionsDigest`, `sourceCommit`, `builtWith`). The record is a convenience; nothing trusts
  it on its own.
- **Release job:** tag `<id>@<version>`, released from `main` only, in a protected `release`
  environment; it fails unless the tagged commit is an ancestor of `origin/main`, checks the tag
  against the manifest, and publishes draft, attach, publish so immutability covers every asset.
- **`cc:include`** downloads and hashes the package itself, requires its hash, GitHub's asset
  `digest` and the release record to agree, recomputes `permissionsDigest`, refuses a mutable
  release, runs the rebuild check, writes `source.url` as the REST asset URL
  (`https://api.github.com/repos/<repo>/releases/assets/<id>`), and prints an include-PR body
  with the sha256, source commit, immutability and permission digest.
- **Engine CI (`cc:check-lock`)** compares every `repo` entry with its asset's `digest`, URL and
  name without downloading, and downloads and hashes when `digest` is `null`.
- **Lock loader verify step**, in order: validate the entry (pin format, `tag == id@version`,
  `url` under the pinned repository's assets); download with the read token into a `0600`
  `.part` file under `connectors/.staging/`, hashing while streaming, 50 MiB cap; compare in
  constant time and, on mismatch, delete the `.part` file and throw `E_SIGNATURE` (reason
  `sha256_mismatch`) before anything is unpacked; unpack strictly in memory (regular files
  under `package/` only; no `..`, absolute paths, backslashes, duplicates, links, pax headers or
  trailing data; gunzip capped at 100 MiB) or `E_PACKAGE_UNSAFE`; check the manifest's `id`,
  `version` and `connectorApi` (`E_MANIFEST_MISMATCH`) and recompute `permissionsDigest`
  (`E_PERMISSIONS_DIGEST`); write files 0600 into staging and rename atomically to
  `<userData>/connectors/<id>/<version>/`; then the existing static checks, consent and health
  probe. A refusal at any step leaves the last-known-good install untouched.

## Consequences

**Gains.** The design's trust model holds as written with no plan upgrade, and every
verification needs only sha256, an HTTPS download and a strict untar: no new cryptographic
dependency in the app. Reproducible packages make the source-to-package rebuild check possible.
Unsafe archives are refused even when the pin is right.

**Costs and risks accepted.**

1. The pin alone does not prove the package came from the reviewed source; the main-only
   release job, the rebuild check, and the existing static checks, consent and isolation
   mitigate this.
2. A new credential (decision 2) must be provisioned for CC and engine CI.
3. A tag of an immutable release can never be reused, even after deleting the release or the
   repository; a broken release needs a new patch version (already semver practice, 05 §14).
4. Cross-architecture zlib output is unmeasured. Releases are built on `ubuntu-24.04` x64 only,
   so pins are unaffected; rebuilds elsewhere compare `contentDigest`.
5. A fine-grained Contents: read token is documented but not yet measured; P5-05 confirms it.

**Follow-up for P5-05, P5-06 and P7-05.**

- `cc:include` requires `immutable: true` outright, and the template sets
  `CC_REQUIRE_IMMUTABLE=true` by default (the probe showed immutability works on Team). Keep
  `CC_ATTEST` off by default: on Team it fails the release.
- The loader omits the `Authorization` header when it has no token (the prototype sent an empty
  `Bearer`, which gets 401 where no header gets 404); both map to the Contents: read hint.
- A release attestation is available on Team at no cost as an optional engine-CI check with
  `gh release verify-asset`; not needed for v1.
- Error codes for 07 §4.4: `E_SIGNATURE` (reason `sha256_mismatch`, as AC-05-02), and new
  `E_LOCK_INVALID`, `E_DOWNLOAD`, `E_PACKAGE_UNSAFE`, `E_MANIFEST_MISMATCH`,
  `E_PERMISSIONS_DIGEST`, `E_RELEASE_MUTABLE` (exit 1). Consider an acceptance criterion beside
  AC-05-08: a package with a symlink, `..` path or absolute path is refused with
  `E_PACKAGE_UNSAFE` even when its sha256 matches, and nothing is written.
- P5-05 defines `permissionsDigest` exactly. The prototype uses
  `sha256(canonicalJson({v:1, permissions, actions:[{name,risk}] sorted by name}))` with sorted
  keys and no whitespace; whether `confirmation` belongs in the input must be decided before
  any digest is published.

**Design documents to update** (follow-up PR; not changed here):

- 05 §15.1 rule 2: tag format, `cc:pack`, the three assets, immutable releases.
- 05 §15.6: the `url` comment ("REST asset URL"), the rule 1 sentence on attestations, and a new
  rule for the connectors read credential.
- 05 §20: OQ-05-07 closed by this ADR.
- 06 §11.2 and 04 §11: the second, read-only GitHub credential; a 04 §11 row for "release built
  from unreviewed code / asset swapped".
- 08 §6: `cc:pack` (connectors repository) and `cc:check-lock` (engine) rows.
- 08 §9: the _your-connectors_ row (immutable release; attest step off by default, Enterprise
  Cloud only) and the _your-engine_ row (lock check with the read token).
- 09 P5-06: replace "(and attestations, if spike S8 found them available)" with the outcome.
- README: the cross-cutting sources line, since attestation availability is settled.

## Evidence

- [measurements.md](0006-s8-verifiable-packages/measurements.md): determinism matrix,
  compression comparison, alternative packers, the T1–T11 suite and timings, the rebuild check,
  the `cc:include` output, attestation mechanics, the plan queries, the live probe, measured
  versus reasoned claims, and the sources.
- [prototype.md](0006-s8-verifiable-packages/prototype.md): the deterministic writer, the loader's
  verify step and the release workflow, as run.
- The prototype (packer, loader, `cc:include`, lock check, the GitHub API double, tests,
  workflows, raw outputs and fetched GitHub pages) and the live-probe logs are kept in the
  spike's working directory outside this repository; P5-05 and P5-06 port the code into
  `@cc/build`, the loader and the templates.
- Upstream: GitHub Docs on [artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations),
  [immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
  and [release assets](https://docs.github.com/en/rest/releases/assets); the
  [`actions/attest` README](https://github.com/actions/attest).
