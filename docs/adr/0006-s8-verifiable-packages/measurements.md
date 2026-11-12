# 0006 measurements and sources

Measurements behind [ADR 0006](../0006-s8-verifiable-packages.md). Run on Linux x86_64 (Debian
12 container) on 2026-11-10, and on GitHub on 2026-11-11 (live probe). Hashes are truncated to
16 hex characters except where the full value matters.

## 1. Determinism matrix (fixture `hello-echo` 1.0.0, commit `c5daba5`)

| Build | Conditions                                                                                       | sha256 (.tgz)      | contentDigest (tar) |
| ----- | ------------------------------------------------------------------------------------------------ | ------------------ | ------------------- |
| B1    | Clone A, umask 022, TZ=UTC, LC_ALL=C, Node 22.23.2                                               | `59ae2ad6dbbc0b84` | `12a2ff5d7fd5395f`  |
| B2    | Clone B at a deeper path, 2 s later (newer mtimes), umask 077, TZ=Asia/Kolkata, LANG=en_US.UTF-8 | `59ae2ad6dbbc0b84` | `12a2ff5d7fd5395f`  |
| B3    | Clone A, files chmod 600 (one 755), mtimes set to 2031                                           | `59ae2ad6dbbc0b84` | `12a2ff5d7fd5395f`  |
| B4    | Clone A, Node 24.22.2 (another zlib build)                                                       | `59ae2ad6dbbc0b84` | `12a2ff5d7fd5395f`  |
| B5    | Clone with `core.autocrlf=true`, template `.gitattributes` (`* -text`)                           | `59ae2ad6dbbc0b84` | `12a2ff5d7fd5395f`  |
| B6    | Clone with `core.autocrlf=true`, no `.gitattributes` (27 CR bytes in `connector.json`)           | `ba0104f514e06937` | `7acfcc8dca3e356f`  |
| B7    | 20 repeated builds of clone A                                                                    | 1 distinct value   |                     |
| B8    | GitHub `ubuntu-24.04` runner, Node 22.23.2 from `.nvmrc` (live probe), packed twice              | `59ae2ad6dbbc0b84` |                     |

Full sha256: `59ae2ad6dbbc0b847fe9828b0108edabe23852454785efe9e0182b9ff51b3e96` (1,152 bytes).
GNU tar lists the entries as `-rw-r--r-- 0/0 … 1985-10-26 08:15 package/{CHANGELOG.md,README.md,connector.json,dist/index.js}`.
The esbuild output's only path comment is `// src/index.ts`, relative to the connector
directory, so the checkout path never reaches it.

## 2. Compression: the same tar, three compressors (x64)

| Input  | Node 22.23.2 `.tgz`              | Node 24.22.2 `.tgz` | GNU `gzip -9n`     |
| ------ | -------------------------------- | ------------------- | ------------------ |
| 1 KiB  | `9c2e7f806f39a451` (591 B)       | `9c2e7f806f39a451`  | `2f0542c300a419d6` |
| 64 KiB | `d2dc158f009eb0f4` (20,731 B)    | `d2dc158f009eb0f4`  | `08c48ab732ea64e2` |
| 2 MiB  | `207ff590dcdbc01b` (652,416 B)   | `207ff590dcdbc01b`  | `97aea19a065bcb14` |
| 16 MiB | `7e0b111568b8edb9` (5,216,263 B) | `7e0b111568b8edb9`  | `5ac17197e58df6e9` |

Node's raw gzip header carries OS byte 3 on Linux. The packer forces 255, because zlib sets this
byte from the platform it was built for (RFC 1952 §2.3.1); that is reasoned for macOS and
Windows, not measured.

## 3. Alternative packers (the same four files)

```text
npm pack     run 1 (mode 644, umask 022): 414a6d041a177c63
npm pack     run 2 (mode 600, umask 077): b3de2efbc2baddf0      entries -rw------- : the mode comes from disk
GNU tar+gzip run 1/2 with --mode=u=rw,go=r: 74dde04df624a8d5 / 74dde04df624a8d5
GNU tar+gzip run 1/2 without --mode:        563b3ee32b1ac6a5 / 9b522efdabc22e2e
```

## 4. Verification suite: 37 of 37 pass (Node 22.23.2 and Node 24.22.2)

The GitHub double imitates the private-repository release API on loopback: 404 without a valid
token; asset metadata with a server-computed `digest`; `Accept: application/octet-stream`
answered with a 302 to a signed URL on a second origin.

| ID           | Check                                                                                                                                                                                                                                                                                                    | Result   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| T1a–c        | `cc:include` pins the downloaded sha256. Engine CI `check-lock` passes using the server digest, and passes with `--download`                                                                                                                                                                             | PASS     |
| T1d–g        | The loader verifies and stages the package; files are exactly `.cc-package.json, CHANGELOG.md, README.md, connector.json, dist/index.js`; a second run is a no-op; staging is left empty                                                                                                                 | PASS     |
| T1h          | The redirect to the download origin carried no `Authorization` header (4 of 4 requests)                                                                                                                                                                                                                  | PASS     |
| T2           | AC-05-08: one flipped bit in the served package gives `E_SIGNATURE` (`sha256_mismatch`). Nothing is unpacked, last-known-good `0.9.0` and `lock/last-known-good.json` are untouched, and no `.part` file is left                                                                                         | PASS     |
| T3, T3b, T3c | A pin edited by one hex digit gives `E_SIGNATURE` before unpacking. An upper-case pin, or a `url` outside the pinned repository, gives `E_LOCK_INVALID`                                                                                                                                                  | PASS     |
| T4           | A wrong token gives `E_DOWNLOAD` 404, with the hint "the token needs Contents: read on the connectors repository"                                                                                                                                                                                        | PASS     |
| T6 ×8        | Correct pin, unsafe contents: a symlink, a hard link, `package/../../pwned`, an absolute path, a pax header, a duplicate path, data after end-of-archive, and a gzip bomb (200 MiB of zeros in 203,860 B). Each gives `E_PACKAGE_UNSAFE` in 2.4–3.8 ms (the bomb in 72.7 ms), and user data is untouched | PASS ×16 |
| T7           | The package's manifest belongs to another connector: `E_MANIFEST_MISMATCH`                                                                                                                                                                                                                               | PASS     |
| T8           | The lock's `permissionsDigest` differs from the package: `E_PERMISSIONS_DIGEST`                                                                                                                                                                                                                          | PASS     |
| T9a–c        | `cc:include` refuses a mutable release (`E_RELEASE_MUTABLE`). When forced to include it and the asset is then replaced, engine CI fails (`digest … != pin`) and the loader refuses the asset (`E_SIGNATURE`)                                                                                             | PASS     |
| T10          | The release record claims another sha256: `cc:include` refuses because the claims disagree (download = GitHub digest = `fd9c9f30…`, record = `ffff…`)                                                                                                                                                    | PASS     |
| T11          | An asset over the 50 MiB cap gives `E_DOWNLOAD`                                                                                                                                                                                                                                                          | PASS     |

Timings (median of 5 runs, loopback):

| Measure                                                                                             | Node 22.23.2                                | Node 24.22.2                                |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------- |
| Fixture package (1,152 B), end to end                                                               | 4.22 ms                                     | 1.43 ms                                     |
| 16 MiB `dist` (4,615,471 B `.tgz`): download and hash / compare / unpack and checks / write / total | 13.57 / 0.011 / 47.42 / 4.12 / **68.52 ms** | 14.46 / 0.015 / 52.28 / 4.22 / **71.99 ms** |
| sha256 in memory, 1 / 16 / 64 MiB                                                                   | 0.51 / 9.75 / 41.25 ms (1,551–1,969 MiB/s)  | 0.52 / 8.85 / 38.95 ms                      |

## 5. Rebuild check

```text
rebuild hello-echo@1.0.0 from c5daba5e5e4f        (3 runs)
  pinned : 59ae2ad6dbbc0b847fe9828b0108edabe23852454785efe9e0182b9ff51b3e96
  rebuilt: 59ae2ad6dbbc0b847fe9828b0108edabe23852454785efe9e0182b9ff51b3e96
  result : MATCH        ms: clone 53/21/26, install 306/278/290, pack 61/59/52, total 421/360/369
negative: a pin of bytes NOT built from that commit (the B6 build)
  result : MISMATCH     exit=1
```

## 6. What `cc:include` produced (fixture)

```text
Include `hello-echo@1.0.0` from `fixture-user/your-connectors` (changes only connectors.lock).
- sha256: `59ae2ad6…3e96` (downloaded and hashed; matches GitHub's asset digest and the release record)
- source commit: `c5daba5e5e4f43d70cec46019cd9320ac5e6cde0`; release immutable: true
- permissionsDigest: `sha256:1fcad037…87af` (new connector)
- permissions: `{"ccData":{"read":[]},"network":{"hosts":["api.echo.example.test"]},"records":{"write":["note.draft@1"]},"secrets":{"custom":false}}`
- actions: `echo` (read), `draft_note` (write_external_draft)
```

```json
{
  "id": "hello-echo",
  "kind": "connector",
  "version": "1.0.0",
  "source": {
    "kind": "repo",
    "repo": "fixture-user/your-connectors",
    "tag": "hello-echo@1.0.0",
    "url": "<api>/repos/fixture-user/your-connectors/releases/assets/1000"
  },
  "sha256": "59ae2ad6dbbc0b847fe9828b0108edabe23852454785efe9e0182b9ff51b3e96",
  "permissionsDigest": "sha256:1fcad0377b88e20c485ea115cc9a9cfaf1c2fda706f48ebba54a0b7a0f0087af",
  "requestId": "req_fixture_0001"
}
```

## 7. Attestation mechanics on a public repository (`cli/cli` v2.103.3, an immutable release)

The two downloaded assets matched their REST `digest` field.

| Command                                                                    | Result                                                                       | Time             |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------- |
| `gh release verify v2.103.3 -R cli/cli`                                    | "✓ Release v2.103.3 verified!", 22 asset digests listed                      | 4,845 ms         |
| `gh release verify-asset v2.103.3 gh_2.103.3_checksums.txt -R cli/cli`     | "✓ Verification succeeded!"                                                  | 3,828 ms         |
| The same with one byte appended                                            | exit 1, "attestation for v2.103.3 does not contain subject sha256:a0cb28f8…" | 2,136 ms         |
| `gh attestation verify gh_2.103.3_linux_amd64.tar.gz --owner cli` (online) | exit 0                                                                       | 6,232 ms         |
| `gh attestation download …` / `gh attestation trusted-root`                | 20,321 B bundle / 2 roots, 34,634 B                                          | 1,664 / 4,134 ms |
| `gh attestation verify … --bundle … --custom-trusted-root …` (offline) ×3  | exit 0                                                                       | 68, 79, 61 ms    |

- **Release attestation:** Sigstore bundle v0.3; certificate issuer `CN=Fulcio Intermediate l1,
O=GitHub, Inc.`, SAN `https://dotcom.releases.github.com`; 0 transparency-log entries and 1
  RFC 3161 timestamp; predicate `https://in-toto.io/attestation/release/v0.2` with 23 subjects
  (the 22 assets plus `pkg:github/cli/cli@v2.103.3` carrying the tag commit). It names no
  workflow.
- **Build provenance (`actions/attest`):** predicate `https://slsa.dev/provenance/v1`, with
  `buildSignerURI`, `sourceRepositoryDigest`, `runnerEnvironment: github-hosted` and
  `sourceRepositoryVisibilityAtSigning: public`; public-good Sigstore instance with one
  transparency-log entry.
- **GitHub's own trusted root** (used for private repositories) lists six `fulcio.githubapp.com`
  CAs, valid from 2023-10-27, 2024-05-13, 2024-10-07, 2025-05-27, 2025-11-13 and 2026-06-12,
  with no transparency log and `timestamp.githubapp.com`. An in-app verifier would have to ship
  this root and refresh it.

## 8. The owner's plan (read-only queries, 2026-11-10)

- The account's own plan is not returned without the `user` scope; personal accounts are Free
  or Pro, both public-only for attestations [G1], and cannot be on Enterprise Cloud.
- The owner's organisation that holds the design workspace reported `plan.name: team`; a second
  organisation reported `plan.name: free`. A third refused a classic token, so its plan was
  unknown until the owner confirmed it is on Free.
- On the Team organisation's private repository, the immutable-releases endpoint answered HTTP
  200 with `enabled: false` (the docs say 404 means not enabled [G12]).
- The attestation read endpoints answer 404 for an unknown digest on every level, so they do not
  reveal plan gating; only a create does (measured in §9).

## 9. Live probe (11 Nov 2026)

Bounds kept: exactly one throwaway private repository in the Team organisation (visibility
checked `private` before each push); release immutability on; 2 of the 3 allowed workflow runs;
only the fixture pushed (commit `c5daba5` plus its two workflows unchanged as `5928dc8`, tag
`hello-echo@1.0.0`); repository-level changes (Actions toggled for the first push, the `ci`
workflow disabled, variable `CC_ATTEST` set `true` then `false`) were deleted with the
repository. No other repository, organisation setting, secret or token was created or changed.
The repository was deleted and `gh repo view` and the REST API both confirmed it gone. The tag
name stays burned for that repository name [G8].

| Step         | Outcome                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------- |
| Immutability | `PUT …/immutable-releases` → 204; then `enabled: true`                                            |
| Run 1        | `CC_ATTEST=true`: failure at the attest step; the release step was skipped and no release existed |
| Between runs | Tag deleted (no release, so not burned); `CC_ATTEST=false`; tag pushed again                      |
| Run 2        | Success; the log shows `immutable: true`                                                          |

Results:

1. **`actions/attest` v4.2.2 fails on a Team private repository**, verbatim:
   `Error: Failed to persist attestation: Feature not available for the <org> organization. To enable this feature, please upgrade the billing plan, or make this repository public.`
   Signing worked; GitHub refused to store the attestation, and the failing step fails the job.
2. **The release is `immutable: true`** in the workflow's check and in
   `GET /releases/tags/hello-echo@1.0.0`. `DELETE /releases/assets/<id>` returned HTTP 422
   "Cannot delete asset from an immutable release". Draft→attach→publish put all three assets
   under it.
3. **A release attestation exists and verifies on a private repository.** `gh release verify`:
   "✓ Release hello-echo@1.0.0 verified!" with 3 asset digests (4,663 ms). `verify-asset` on the
   `.tgz`: "✓ Verification succeeded!" (3,882 ms), also for the locally packed copy. One byte
   appended: exit 1, "attestation for hello-echo@1.0.0 does not contain subject sha256:b782806a…"
   (2,348 ms). Bundle: Sigstore v0.3, predicate `https://in-toto.io/attestation/release/v0.2`, 4
   subjects (3 assets plus the tag commit `5928dc83…`), issuer `O=GitHub, Inc., CN=Fulcio
Intermediate l1`, SAN `https://dotcom.releases.github.com`, 0 transparency-log entries, 1 RFC
   3161 timestamp: the same shape as the public `cli/cli` release. The release attestation is
   not plan-gated on Team; build provenance is.
4. **The asset digest matches:** `sha256:59ae2ad6dbbc0b847fe9828b0108edabe23852454785efe9e0182b9ff51b3e96`,
   1,152 B, equal to the local `cc:pack` output. The `.release.json` (`0cb5eb53…`) and
   `.tgz.sha256` (`6778467e…`) assets were identical to the local build too.
5. **Download through the 302.** No token → 404. Classic token with `repo` scope → 302 to a
   presigned URL on `release-assets.githubusercontent.com`. Following it with no `Authorization`
   → 200, sha256 `59ae2ad6…`. Node `fetch` (`redirect: 'follow'`) → 200, same sha256. No
   fine-grained token was created, so that case remains documented only [G11].
6. **The prototype end to end against the live release.** `cc-include` wrote the lock entry
   with `source.url` = the REST asset URL, its three claims agreed, and it reported
   `release immutable: true` and source commit `5928dc83…`. `check-lock`: `ok: true` without
   downloading; with one hex digit of the pin changed, `ok: false`, exit 1. The loader with the
   correct pin: `staged`, 4 files, 555 ms total (download 552 ms, compare 0.07 ms, unpack and
   checks 2.1 ms). With a changed pin: `E_SIGNATURE` (`sha256_mismatch`), exit 1, only an empty
   `connectors/.staging/` left (AC-05-08 on real GitHub). With no token: `E_DOWNLOAD`, HTTP 401,
   because the prototype sends an empty `Bearer` header (curl with no header gets 404).

## 10. Measured versus reasoned

| Claim                                                                                                                             | Status                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `cc:pack` output is byte-identical across clones, paths, umask, TZ, locale, modes, mtimes, Node 22/24, CRLF with `.gitattributes` | Measured (Linux x64, and GitHub's `ubuntu-24.04` runner)                                                                 |
| A CRLF checkout without `.gitattributes` changes the hash                                                                         | Measured (simulated with `core.autocrlf=true` on Linux; Windows not run)                                                 |
| `npm pack` and GNU tar without `--mode` take file modes from disk                                                                 | Measured                                                                                                                 |
| Node 22 and 24 zlib identical up to 16 MiB; GNU gzip differs                                                                      | Measured (x64 only)                                                                                                      |
| zlib output on arm64 and Windows; the OS header byte there                                                                        | Reasoned: the header byte is normalised, and `contentDigest` covers rebuilds elsewhere                                   |
| esbuild output is the same on other OSes                                                                                          | Reasoned (one Go binary per platform at a pinned version); measured only across checkouts on Linux                       |
| Loader order, strict untar, manifest and digest checks, LKG untouched                                                             | Measured against the API double (37 of 37, Node 22 and 24)                                                               |
| Real private-asset download: 404 without a token, 302 to another origin, `digest` field                                           | Measured on a private repository with a classic token; a fine-grained Contents: read token is documented only [G11]      |
| Node `fetch` drops `Authorization` on a cross-origin redirect                                                                     | Measured (two loopback origins); harmless on GitHub because the target URL is presigned                                  |
| Rebuild check matches, and catches bytes not built from the commit                                                                | Measured (local fixture repository)                                                                                      |
| Artifact attestations unavailable for private repositories on Free, Pro and Team                                                  | Measured for Team (live probe); Free and Pro documented ([G1], [G4], [G5], [G6])                                         |
| Immutable releases on Team private repositories                                                                                   | Measured (live probe)                                                                                                    |
| Release attestations generated and verifiable for private repositories                                                            | Measured on Team (live probe)                                                                                            |
| The workflows are valid                                                                                                           | Linted (actionlint 1.7.12); `release.yml` run twice on GitHub; the connectors `ci.yml` and the engine `ci.yml` never run |

## 11. Sources (fetched 2026-11-10)

- **[G1]** GitHub Docs, [Using artifact attestations to establish provenance for builds](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations).
  "Who can use this feature?": "If you are on a GitHub Free, GitHub Pro, or GitHub Team plan,
  artifact attestations are only available for public repositories. To use artifact
  attestations in private or internal repositories, you must be on a GitHub Enterprise Cloud
  plan." The box is only in the rendered page; the Docs article-body API omits it.
- **[G2]** GitHub Docs, [Artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations):
  private repositories use GitHub's Sigstore instance, which has no transparency log. No plan
  statement.
- **[G3]** GitHub Docs, [Verifying attestations offline](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/verify-attestations-offline):
  GitHub's instance "rotates its key material, which typically happens a few times per year".
  No plan box.
- **[G4]** [GitHub Pricing](https://github.com/pricing), row "Artifact attestations": Free
  "Public repositories", Team "Public repositories", Enterprise included.
- **[G5]** [`actions/attest` README](https://github.com/actions/attest) (v4.2.2): private and
  internal repositories need GitHub Enterprise Cloud; not supported on Enterprise Server.
- **[G6]** [`actions/attest-build-provenance` README](https://github.com/actions/attest-build-provenance)
  (v4.2.2): the same note as [G1].
- **[G7]** GitHub Changelog, [Artifact Attestations is generally available](https://github.blog/changelog/2024-06-25-artifact-attestations-is-generally-available/)
  (2024-06-25): "supports both public and private repositories". No plan statement.
- **[G8]** GitHub Docs, [Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases):
  tags cannot be moved and assets cannot be modified or deleted; an immutable release
  automatically generates a release attestation; tags of immutable releases cannot be reused
  even after deleting and recreating the repository; best practice is draft, attach, publish.
  No plan box on it or on the related how-to pages.
- **[G9]** GitHub Docs, [GitHub's plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans):
  does not mention attestations or immutable releases.
- **[G11]** GitHub Docs, REST [Release assets](https://docs.github.com/en/rest/releases/assets):
  `Accept: application/octet-stream` gives a 200 or a 302; fine-grained tokens need "Contents"
  repository permission (read); `digest` is "string or null".
- **[G12]** GitHub Docs, REST [Repositories](https://docs.github.com/en/rest/repos/repos), "Check
  if immutable releases are enabled for a repository": 200 if enabled, 404 if not.

**The disagreement, resolved.** No source contradicts another. Every page that states plan
availability ([G1], [G4], [G5], [G6]) says private and internal repositories need Enterprise
Cloud. The pages that seem to disagree ([G2], [G3], [G7]) describe how private repositories are
signed without saying who may use it.
