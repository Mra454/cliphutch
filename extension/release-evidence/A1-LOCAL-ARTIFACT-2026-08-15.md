# A1 local artifact evidence: 2026-08-15

This record began as an audit of the ignored local file `extension/dist.zip`.
The August 28 follow-up also downloaded and inspected the package served by the
Chrome Web Store.

## Preserved local artifact

- File: `extension/dist.zip`
- SHA-256: `1a085ad951e81f8564ea146e41bf54aa53464f3a26fb4f5a6a3418117359da84`
- Local file date: 2026-07-22
- Bundled manifest version: `0.1.3`
- Bundled source-offer ref: `cliphutch-v0.1.2-cws-submit-2026-07-03`

The archive therefore contains a confirmed internal version/source-offer
mismatch. It has not been overwritten by the new packaging pipeline.

## Original limitation

The Git commit that first records manifest version `0.1.3` is
`2764dfc3148207517a46e63d64fc1d5cd56d182d`, dated 2026-07-30, after the local
archive date. A matching bundle comparison is not enough to prove that this
commit is the complete corresponding source for the Web Store artifact.

No `0.1.3` exact-source tag was created or named during this work. Release
verification now requires an explicit local tag for the canonical version,
requires that tag to resolve to a clean `HEAD`, and records that commit in the
artifact metadata. Packaging refuses development or unverified builds.

## August 28 live-package follow-up

- Google-served CRX SHA-256:
  `96fe12a93da1626577c7e3630ca983fb8cbaeab36f609b48689d516b4af6c15b`
- CRX size: `10,462,033` bytes
- Public manifest version: `0.1.3`
- Public permissions: `webRequest`, `storage`, `downloads`, `offscreen`, and
  `declarativeNetRequestWithHostAccess`
- Public package has no `sidePanel` permission or side-panel entry point.

The live CRX and preserved `dist.zip` contain the same 31 non-manifest material
files. Their manifests are identical after removing Google's injected
`update_url`; Google also adds `_metadata/verified_contents.json` to the served
CRX. A clean archive of pushed commit
`d5435d54abf7d93e4ee0df76dd98d4b6a0f66d23` rebuilt a `dist/` directory that
was byte-for-byte identical to the preserved `dist.zip` contents.

This establishes material correspondence among the live 0.1.3 package, the
preserved archive, and a clean build of that pushed commit. It does not erase
the historical date inconsistency or repair the source-offer text embedded in
the already-published CRX. The public package still identifies the 0.1.2 tag,
and the source commit's package metadata still says 0.1.1. Treat that as a
documented historical release-identity defect, not as the model for 0.1.4.

## 0.1.4 gate

Before any 0.1.4 release package can pass `npm run verify:source`:

1. Commit and review the complete 0.1.4 source with manifest, package, and lock
   versions all equal.
2. Create and push a version-matching tag that resolves to that clean commit.
3. Run `verify:source`, `package`, and `verify:package` without changing the
   tagged tree.
4. Preserve the exact archive checksum and complete the remaining manual
   browser, accessibility, privacy/site, and Chrome Web Store gates before
   upload.
