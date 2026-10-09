# CAI Business OS delivery goal

Status: active, updateable delivery scope; implementation and release evidence
are tracked separately. Updated 9 October 2026.

This goal is a living project control document. The Scrum Master updates scope,
sequence, card mapping and remaining acceptance criteria when live board reads,
accepted Product Owner decisions, source verification or release evidence
change the plan. Record each material update with date, reason and evidence;
the Product Owner retains product decisions and final acceptance.

## Product and primary board

Deliver the complete CAI-Techniek.nl website and CAI Business OS as a working,
secure, maintainable, open-source product: frontend, backend and full-stack
journeys; UI, APIs, data and storage, authentication and customer/staff portals,
CMS/ERP, integrations, webhooks, operations, the production scrumboard and a
distributable ChatGPT plugin package. CMS/ERP is one product area, not the whole
website. Every scrum card is a measurable subgoal tied to a sprint milestone,
owner role, dependencies, Definition of Done, source/environment and evidence.

The [website scrum board](https://www.cai-techniek.nl/app/board) is the primary
project record from now on. It tracks local, DEV, TEST/ACC and PROD work. Card
status describes work progress; execution environment, source artifact, release
state and evidence are separate fields. A completed local test must never be
presented as a production deployment.

Weft is only a historical and migration source. Its monthly AI read limit has
been reached; use saved snapshots/exports for crosswalk and recovery, and do not
make delivery depend on another live Weft read or write. Preserve source card
identifiers, reconcile available records against the website board, and finish
the approved backlog there. Missing history remains explicit recovery work.

The latest available board snapshot named five sprint themes: Sprint 1 — veilige
toegang; Sprint 2 — dossiers en uploads; Sprint 3 — klant en CMS; Sprint 4 —
connectorfundament; Sprint 5 — gecontroleerde pilots. These names are historical
until a fresh live board read confirms them. Map every live card to its actual
sprint and a full-stack product outcome; the live board determines the true
sequence, status and dependencies. Keep Weft parity/retirement as a cross-cutting
subgoal of the actual website-board roadmap.

## Delivery streams

1. **Board successor:** deliver projects, boards, backlog, sprints, workflows,
   assignments, priorities, labels, estimates, dates, descriptions, checklists,
   dependencies, comments, search, filters, sorting, views, WIP limits, audit,
   activity, notifications, import/export, archive, permissions and responsive
   use. Provide durable storage, concurrency control, idempotency and secure
   agent/API access. Compare every required capability with Weft in a traceable
   acceptance matrix.
2. **Migration:** preserve source IDs or a deterministic crosswalk; migrate
   projects, sprints, cards, relationships, relevant history and attachment
   references supported by the source interfaces. Keep a recoverable export,
   rehearse import and rollback in ACC with synthetic data, and compare counts,
   fields and relationships. Record every missing field and approved exception.
   Use the website board as the only active write source now; archive Weft through
   a supported route when available. Missing history gets an owned recovery card
   and does not prevent an independently accepted product release.
3. **Website and customer access:** reuse the verified existing routes, identity
   and storage. Complete the approved Google and email login flows and their
   customer workflows; add other providers only within the approved scope.
   Provider configuration, real login, session creation and correct role access
   are separate acceptance checks.
4. **CMS/ERP:** finish the approved backlog as complete user workflows covering
   UI, API, data, authorization, error handling, audit and acceptance tests.
   Preserve existing content, routes and operational records. Resolve ownership,
   tenant, retention and financial-policy decisions with the Product Owner.
5. **Quality and distribution:** validate security, restore, migrations, logs,
   licensing, documentation and reproducible builds. Publish reviewed source
   and release receipts on GitHub. Build and validate an upload-ready plugin;
   package validation, endpoint readiness, OAuth, upload, platform review and
   actual publication remain separately evidenced states.

## Iteration and release contract

Every product increment follows this sequence:

1. Pin the approved card, source commit/artifact, environment and change scope.
   Define the tests, reviewer capabilities and rollback before implementation.
2. Build the complete increment and run the relevant functional, integration,
   authorization and failure-path checks. Record raw commands, counts, exit
   status and any NOT_RUN result. Zero assertions cannot count as a pass.
3. Publish the reviewed source to its development branch and make the exact
   candidate available in DEV. A Git push is source publication, not deployment.
4. Have a separate capable worker independently accept the candidate in TEST/ACC.
   Test the intended user workflow, permissions and persistence against the
   pinned artifact. The builder cannot accept their own change.
5. After successful acceptance and resolution of all release-blocking issues,
   promote the same artifact to PROD under the approved release process. Do not
   rebuild an untraceable candidate or copy ACC-specific origins into PROD.
6. Read back the actual PROD version, commit, configuration revision and
   deployment. Verify the affected live behavior and keep the rollback receipt.
7. Update the primary board with the card result, artifact, test evidence,
   environment and actual release status. Reopen a failed increment and repair
   it through the same sequence.

The Product Owner has authorized routine implementation, tests, source
publication and promotion after these checks. Concrete access or platform
requirements remain real dependencies. Never bypass them or publish credentials,
private records or customer data.

## Team and execution protocol

Use Scrum for sprint goals, planning, backlog, review and Definition of Done;
use Kanban rules for WIP and blocked work inside the sprint. Execute strictly
sequentially: one Ready card and one active execution at a time. The Product
Owner owns product choices. The coordinating chat is Scrum Master and Delivery
Lead. Maintain one operational team/capability roster in
`docs/WEBSITE-BACKEND-TEAM-ROSTER.md`; reuse chats by context and capability
instead of creating a new conversation for each role or card.

- Assign every work package to an actual board card and sprint, or explicitly
  record the unresolved mapping. An internal assignment ID is not a board card.
- Each assignment states priority, outcome, host, source, environment, owner,
  timebox/checkpoint, dependencies, file/record ownership, acceptance criteria,
  appropriate Skills, report route and next action.
- Git publication is part of each card increment: record the intended remote
  branch/PR and starting SHA, commit only the reviewed card scope after relevant
  checks, push, and read back remote SHA/CI. Never let completed work accumulate
  as an unreviewed commit backlog; exclude secrets and private records.
- Local Codex workers own local code, tests, package preparation and CLI work.
  Work/Sites workers own supported Site source, configuration, deployment and
  board actions. Assign work according to demonstrated capability.
- Use verified commits, accessible artifacts or bounded text handoffs between
  local and cloud hosts. A local path does not prove cloud access.
- An independent reviewer needs the actual pinned source and runtime capability
  for the check they accept. Injected test actors do not prove HTTP login; local
  SQLite does not prove Worker/D1/R2; a deployment receipt alone does not prove
  the user flow.
- Use relevant installed Skills and connectors deliberately. Report which
  Skills were loaded and used, or why no applicable Skill is available. A role,
  worker, Skill and connector are different parts of the workflow.
- Respond to every worker report with receipt, evidence boundary, triage and
  one useful next assignment or a precise wait reason. Do not duplicate active
  work or repeatedly wake a worker without new information.
- Prefer supported CLI/API routes. When a step fails, record the redacted
  command, exit code, host and version; distinguish access, path, network,
  configuration, schema and runtime causes. Use help, source and official
  documentation to choose a supported alternative. Retry only with a changed
  hypothesis or condition.
- Keep a durable compact ownership and evidence ledger. The board steward
  writes progress and directly reads each mutation back; workers without write
  capability send receipts through the coordinator.
- The periodic progress and mail automations are deleted. Report to the Product
  Owner at meaningful milestones, completed worker reports, blockers or when a
  decision is needed. A dispatch receipt is not evidence of execution.

## Acceptance gates

**A — Backlog and migration readiness:** all known baseline cards have a unique
disposition, target card, owner, environment, acceptance criteria and evidence
state. All legitimate approved work is delivered; duplicates and obsolete items
have an explicit reason rather than fake Done. Required feature coverage and
ACC import/rollback are independently accepted. Compare actual available
snapshots, not an invented complete export. Missing source fields and historical
records remain visible as owned recovery cards; fresh Weft reads, Weft Done
writes and dual-run synchronization are not product release gates.

**B — Website-board successor:** the production-hosted board supports all
approved project, sprint, card, permission, workflow, audit, search, export and
responsive cases. Multi-project and multi-tenant allow/deny, concurrency, WIP,
backup/restore and agent writes are tested. Migration counts, fields, relations
and exceptions are reconciled; Weft writes have stopped and a recoverable archive
exists for available source records. No known active work remains accessible
only through Weft; unknown historical gaps remain explicit recovery work.

**C — CMS/ERP and production:** the approved workflows are integrated into the
verified website source. Required tests and independent ACC checks pass; no
unresolved critical/high security issue remains. PROD runs the accepted artifact
and live workflows are read back. Restore and smoke evidence exist, and the
board accurately separates local/DEV/ACC work from production delivery.

**D — Open source and distribution:** source, license, documentation, dependency
and secret review, reproducible tests and artifacts are pinned. Public artifacts
contain no credentials, customer data or private information. The plugin ZIP
matches its validated manifest and contents; external upload/review/publication
is reported only when confirmed.

Keep this integrated goal open until all gates are accepted and read back. Plan
the next prioritized sprint on the primary website board after delivery. Changes
to the product scope require an explicit Product Owner decision and traceable
board update.
