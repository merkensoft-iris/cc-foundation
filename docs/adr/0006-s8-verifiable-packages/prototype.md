# 0006 prototype code

Condensed prototype code behind [ADR 0006](../0006-s8-verifiable-packages.md), as run in the
spike. It is reference material for P5-05 and P5-06, not code this repository builds.

## A. The deterministic tar writer and gzip settings

```js
export const FIXED_MTIME = 499162500; // 1985-10-26T08:15:00Z, the constant npm uses
function header({ name, size }) {
  const nameBuf = Buffer.from(name, 'utf8');
  if (nameBuf.length > 100) throw new Error(`E_TAR: path longer than 100 bytes: ${name}`);
  const h = Buffer.alloc(512, 0);
  nameBuf.copy(h, 0);
  h.write(octal(0o644, 8), 100, 'ascii'); // mode: never from the file system
  h.write(octal(0, 8), 108, 'ascii'); // uid
  h.write(octal(0, 8), 116, 'ascii'); // gid
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(FIXED_MTIME, 12), 136, 'ascii');
  h.fill(0x20, 148, 156); // checksum placeholder
  h.write('0', 156, 'ascii'); // regular file
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}
export function writeTar(entries) {
  // [{ path, data }] -> package/<path>, byte-sorted, files only
  const sorted = [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
  );
  /* header + data + zero padding per entry, then two zero blocks */
}
export function gzipDeterministic(tar) {
  const gz = gzipSync(tar, { level: 9, memLevel: 9, strategy: Z.Z_DEFAULT_STRATEGY });
  gz[9] = 255; // OS byte: "unknown", not the build platform
  return gz;
}
```

`permissionsDigest` in the prototype:
`sha256(canonicalJson({v:1, permissions, actions:[{name,risk}] sorted by name}))`, with sorted
keys and no whitespace.

## B. The lock loader's verify step (condensed)

```js
export async function verifyAndStage(entry, { userData, token, apiBase }) {
  validateEntry(entry, apiBase); // pin format, tag == id@version, url under the repo's assets
  const part = join(userData, 'connectors/.staging', `${entry.id}@${entry.version}.${nonce}.tgz.part`);
  try {
    const got = await downloadAsset(entry.source.url, token, part); // octet-stream, follow 302, stream-hash, 50 MiB cap, 0600
    if (!sameHex(got.sha256, entry.sha256))
      // timingSafeEqual on 32-byte buffers
      throw new CcError('E_SIGNATURE', 'package sha256 does not match the pin in connectors.lock', {
        reason: 'sha256_mismatch',
      });
    const files = readTgzStrict(readFileSync(part)); // first unpack: in memory, regular files under package/ only
    const manifest = JSON.parse(files.get('connector.json'));
    if (manifest.manifestVersion !== 1 || manifest.id !== entry.id || manifest.version !== entry.version)
      throw new CcError('E_MANIFEST_MISMATCH', …);
    if (manifest.engines?.connectorApi !== '1')
      throw new CcError('E_MANIFEST_MISMATCH', 'unsupported connectorApi');
    if (permissionsDigest(manifest) !== entry.permissionsDigest)
      throw new CcError('E_PERMISSIONS_DIGEST', …);
    /* write files 0600 into connectors/.staging/<id>@<version>.<nonce>/, add .cc-package.json,
       renameSync to connectors/<id>/<version>/ */
  } finally {
    rmSync(part, { force: true });
  }
} // next: static checks (05 §12), consent, health probe (05 §15.4 rule 4)
```

Fix for P5-05 found by the live probe: omit the `Authorization` header when there is no token.

## C. The connectors template's release workflow

Linted with actionlint 1.7.12 (no findings) and run twice on GitHub in the live probe (run 1
failed at the attest step on Team, as expected; run 2 succeeded).

```yaml
name: release
on:
  push:
    tags: ['*@*']
permissions: {}
concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false
jobs:
  release:
    runs-on: ubuntu-24.04
    environment: release # protected environment; the user may add themselves as required reviewer
    permissions:
      contents: write # create the release and upload assets
      id-token: write # only for the optional attestation step
      attestations: write # only for the optional attestation step
    env:
      TAG: ${{ github.ref_name }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
      - name: The tag must point at a commit on main (08 §9 rule 3)
        run: git merge-base --is-ancestor "$GITHUB_SHA" origin/main
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version-file: .nvmrc # exact version: the gzip bytes depend on the bundled zlib
      - run: npm ci --ignore-scripts # pnpm install --frozen-lockfile in the real template
      - name: Parse the tag
        id: tag
        run: |
          if [[ ! "$TAG" =~ ^([a-z0-9-]{2,40})@([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)$ ]]; then
            echo "::error::tag $TAG is not <id>@<semver>"; exit 1
          fi
          echo "id=${BASH_REMATCH[1]}" >> "$GITHUB_OUTPUT"
          echo "version=${BASH_REMATCH[2]}" >> "$GITHUB_OUTPUT"
      - name: Test the connector (05 §13)
        env:
          ID: ${{ steps.tag.outputs.id }}
        run: echo "pnpm cc:test-connector $ID" # placeholder for the real testing contract
      - name: Pack twice; the bytes must match
        env:
          ID: ${{ steps.tag.outputs.id }}
          VERSION: ${{ steps.tag.outputs.version }}
        run: |
          node scripts/cc-pack.mjs --id "$ID" --tag "$TAG" --out out
          node scripts/cc-pack.mjs --id "$ID" --tag "$TAG" --out out-check
          cmp "out/$ID-$VERSION.tgz" "out-check/$ID-$VERSION.tgz"
          cat "out/$ID-$VERSION.release.json"
      - name: Build-provenance attestation (optional; private repositories need GitHub Enterprise Cloud)
        if: vars.CC_ATTEST == 'true'
        uses: actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4.2.2
        with:
          subject-path: out/${{ steps.tag.outputs.id }}-${{ steps.tag.outputs.version }}.tgz
      - name: Publish the release (draft, attach, publish, so immutability covers every asset)
        env:
          GH_TOKEN: ${{ github.token }}
          ID: ${{ steps.tag.outputs.id }}
          VERSION: ${{ steps.tag.outputs.version }}
        run: |
          gh release create "$TAG" --verify-tag --draft --title "$TAG" \
            --notes "Package $ID $VERSION, sha256 $(cut -d' ' -f1 "out/$ID-$VERSION.tgz.sha256")" \
            "out/$ID-$VERSION.tgz" "out/$ID-$VERSION.tgz.sha256" "out/$ID-$VERSION.release.json"
          gh release edit "$TAG" --draft=false
          immutable=$(gh api "repos/$GITHUB_REPOSITORY/releases/tags/$TAG" --jq '.immutable')
          echo "immutable: $immutable"
          if [ "${{ vars.CC_REQUIRE_IMMUTABLE }}" = "true" ] && [ "$immutable" != "true" ]; then
            echo "::error::release immutability is not enabled for this repository"; exit 1
          fi
```

The engine side adds one CI step: `node scripts/check-lock.mjs connectors.lock --api https://api.github.com`,
with `CC_CONNECTORS_READ_TOKEN: ${{ secrets.CC_CONNECTORS_READ_TOKEN }}` (decision 2).
