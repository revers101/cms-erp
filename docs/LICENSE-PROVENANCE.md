# Integration license and provenance boundary

The standalone application and the portable integration source files declare
GPL-3.0-or-later. The two integration LICENSE files now contain the unchanged
canonical GPL version 3 text from the repository root. This correction does not
relicense source or assert exclusive ownership.

## Verified source trace

- The supplied `cms-erp-integratie-source.zip` has SHA-256
  `cb9c7a7702656866e51e58206ad75c813b2e0f932b33d9c2c5989c19c48dc01c`, matching its
  distribution checksum record.
- The archive's `domain.mjs`, `domain.test.mjs`, `planner.mjs` and
  `planner.test.mjs` match the tracked application snapshot exactly. Their
  individual hashes are in APPLICATION-SNAPSHOT-MANIFEST.json.
- The portable domain contract entered repository history in `7ddc59a6`; the
  import planner entered in `3c4ffd2`. The source headers and the supplied handoff
  declare these portable files GPL-3.0-or-later. They implement domain rules and
  product-field projection, with no WordPress/WooCommerce runtime dependency.
- The source archive also supplied a license file with a WooCommerce-specific
  preamble, identical to the reference WordPress/theme package's license notice.
  The later import directory carried that same preamble. The shared text is not
  proof that WooCommerce contributors wrote the portable Node implementations.

## Notices and limits

The original preamble, including contributor, Jigowatt and WooThemes notices, is
preserved in each integration directory's NOTICE.md with its reference context.
The actual GPL license text remains unchanged in LICENSE. If upstream runtime
code is later copied or distributed, its genuine component-specific copyright,
license and notice files must also be retained and reviewed.

This source trace documents the supplied package and declarations; it is not a
complete chain-of-title or legal ownership determination. It asserts no new
exclusive copyright and does not remove an established third-party notice.
Dependency manifests declare MIT/Apache-2.0 for the resolved dependencies, which
are installed from the lockfile rather than vendored. Deployment/distribution
still needs review of the final dependency and artifact notices.
