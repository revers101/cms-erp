# Git publication protocol

Applies to reviewed source and documentation increments of CAI Business OS.
The [delivery goal](DELIVERY-GOAL.md) defines the product and release gates.

## Ownership and staging

The Git Publication Steward owns the index, commits, normal pushes and pull
request receipts during an assigned publication window. Builders retain source
ownership. The coordinator resolves overlap and sends stable-snapshot ACKs.

1. Read the current repository, branch, HEAD, upstream, remotes, status and
   applicable repository instructions. Re-read immediately before committing.
2. Inventory each candidate by exact file, owner, stable snapshot/hash, card,
   change meaning, tests and public-output/licensing checks. Mark unknown
   ownership or missing card mapping explicitly.
3. Review the complete proposed diff, added files, binary artifacts and every
   previously unpublished commit that the push would expose. Check history as
   well as the final tree for secrets and private information. A pattern scan
   supplements manual review; it does not prove absence of every secret.
4. Never stage credential files, private configuration, production/customer
   data, mailbox state or unreviewed screenshots/bundles. Do not read private
   credential files just to decide they should be excluded. Example values must
   be clearly synthetic and incapable of representing active credentials.
5. Stage exact reviewed paths. Do not use blanket staging in a shared worktree.
   Inspect the staged diff, confirm the staged path set and compare source hashes
   with the stable snapshot before committing. A changed file returns to its
   owner for review. Do not reset, clean, stash, rebase or force-push another
   worker's changes.

## Publication and access

- Inspect ordinary authenticated repository metadata for write permission
  without printing tokens, authentication files or credential values.
- A repository can be public and readable while the connected account cannot
  write. Record the exact repository, identity, required permission and error.
  Do not repeat an unchanged denied push or create a substitute account.
- Use a normal non-force push to the intended branch after access and the full
  publication scope are verified. Retain the commit locally and provide a
  reviewable artifact if publication is blocked.
- If upstream is read-only, a normal permitted public fork and PR can publish
  the reviewed increment. Verify fork policy, its parent and the existing
  account's write rights; preserve the upstream remote. A small process-only
  publication branch can start from public upstream main without exposing
  unreviewed local application history. Record its distinct SHA and provenance.
- Create or update a suitable draft PR. Check the existing PR's base, head and
  scope first; do not reuse an unrelated contract PR. Write the exact multiline
  body through a body file or structured API argument.
- Newly created PRs are attached to the coordinating task. Read back the remote
  branch SHA, PR head/base/status and relevant CI results. A successful command
  or message receipt alone is insufficient.
- Keep a draft development change visibly incomplete when tests or integration
  gates remain open. Do not weaken failing assertions or call it a release.

## Publication inventory for the first process increment

This group contains two Git-steward-owned documents. An isolated public
process-only branch also includes the unchanged, already-established repository
license from the reviewed local license commit:

| File | Meaning | Source / card relation | Checks |
| --- | --- | --- | --- |
| `docs/DELIVERY-GOAL.md` | Public product scope, primary website board, iteration/release and completion gates | Product Owner's delivery direction; board-card mapping to be recorded by the board steward | Full text review, private-output/secret pattern review, staged diff and whitespace check |
| `docs/GIT-PUBLICATION-PROTOCOL.md` | Safe shared-index ownership and commit/push/PR/readback rules | Git publication work package; board-card mapping to be recorded by the board steward | Full text review, staged path/hash check and whitespace check |
| `LICENSE` | Existing GNU GPL version 3 license, copied unchanged where absent on the public base | Established local license commit `5538d29`; no new license choice | Exact blob comparison with the existing license commit and full artifact scope review |

This documentation increment does not alter runtime source, dependencies or
configuration and does not require a runtime test suite. It establishes no DEV,
ACC or PROD deployment and claims no complete software acceptance.

Other existing changes remain separate candidate groups until their owners
confirm a stable snapshot and their evidence is reviewed:

| Candidate group | Required evidence / owner ACK |
| --- | --- |
| Node Secret Manager source and tests | Builder/reviewer ACK; actual full diff; focused tests; distinguish fake provider checks from live IAM/Resend |
| Backup/restore and CI | Assigned owner; script/workflow review and actual restore/CI results; no production data |
| Payload POC, generated types and migrations | POC builder and test-owner ACKs; dependency/license review; explicit local versus Worker/D1/R2 evidence and remaining failing cases |
| Draft plugin package and ZIP | Package owner's stable snapshot, exact ZIP contents/hash, manifest/schema/license checks and readiness gates |
| Coordination, login/mail setup and screenshots | Coordinator/owner ACK; complete private-output review; mark historic observations as dated; inspect every image before inclusion |
| Already-unpublished application history | Full history/source review, license review and latest applicable tests before the branch is exposed |

## Receipt for the coordinator and primary board

Return the exact files and card mappings; local commits and branch/upstream;
commands and raw results; remote branch and PR head readback; CI state; remaining
access/test/release gates; owner and next action. The board steward records those
receipts with execution environment and release state separately.

Git publication is one step in the iteration contract. It is never evidence of
a Sites deployment, real provider login, independent ACC acceptance or PROD
workflow behavior.
