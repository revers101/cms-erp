# Website backend team operating model

Public project roles and capability boundaries, updated 9 October 2026. The detailed coordinator roster with private conversation identifiers and live assignment state is maintained locally; this public file contains no account/thread identifiers.

## Scope and accountability

The team delivers the complete CAI-Techniek.nl website: frontend, backend and full-stack workflows, APIs, data, identity, customer/staff portal, CMS/ERP, integrations, webhooks, operations, scrumboard and plugin distribution. CMS/ERP is one subsystem.

The human Product Owner owns product decisions and acceptance. The Scrum Master owns sprint/card orchestration, prioritization, work contracts, report responses, goal/roster updates and evidence quality. Each card is a subgoal of the living project objective, with one accountable execution role, a measurable Definition of Done, dependencies, source/environment and evidence.

## Reusable execution roles

| Role assigned per card | Work owned | Required evidence |
|---|---|---|
| Full-stack implementer | The card's necessary UI, API, data, authorization and tests as one vertical slice. | Source/commit, exact changed scope, commands/results and remaining gaps. |
| Sites/board operator | Sites source/version readback, supported deployment and persistent website-board changes. | Site/environment version and before/after persisted readback. |
| Git publication steward | Review and publish only the card's approved source increment to the intended branch/PR. | Target branch, reviewed diff, secret/private-data scan, remote SHA and CI readback. |
| Independent QA/release reviewer | Verify the exact candidate independently in TEST/ACC; accept or return PASS/FAIL/NOT VERIFIED. | Pinned source/artifact, test cases/results and environment behavior. |
| Identity/security reviewer | Review authentication, authorization, tenant boundaries, API abuse and secret handling when the card requires it. | Findings tied to routes/files and tested allow/deny cases; no secret values. |
| Plugin/distribution specialist | Validate package contents, metadata, licensing, dependencies and readiness. | Artifact/hash, validation output and actual platform state. |

Assign one role owner and one executing chat/agent per work order. Reuse specialist conversations when context fits; do not create a new conversation for every role or ticket. A handoff between builder, Git, Sites and reviewer is a sequential phase of the same card, not parallel execution. Maintain one active implementation card at a time.

## Capability and tool routing

| Capability | Relevant installed Skills | Host/tool boundary |
|---|---|---|
| Site implementation/hosting | `sites:sites-building`, `sites:sites-hosting`; `sites:sites-mcp` for Site-hosted MCP | Sites/Work connector owns remote Site operations; verify write/deploy capability and readback. |
| CMS implementation | `microcms-nederlands:cms-erp-integratie`, `microcms:microcms-nextjs` when the verified architecture matches | Local Codex owns repository code/CLI; local changes do not prove Site behavior. |
| Auth/OAuth/security | `auth0:auth0` only if Auth0 is the selected provider; applicable `duende-skills:*`; `vibe-code-security-reviewer:authentication-and-authorization`, `api-abuse-and-misuse`, `api-leak-and-key-security` | Use the host with access to the pinned source and the actual provider/runtime evidence. Keep build and independent review separate. |
| Database | `supabase:supabase` and `supabase:supabase-postgres-best-practices` only if Supabase is verified as the datastore | Use the supported database CLI/API; prove migrations, tenant policy and restore. |
| Plugin lifecycle | `plugin-creator:create-plugin`, `prepare-plugin-submission`, `update-plugin`; `cai-skill-builder:cai-plugin-lifecycle` when applicable | Package validation, upload, review and publication are distinct states. |
| Work decomposition/Skill routing | `rosetta-stone-control:rosetta-control`; `rosetta-skill-ops` when auditing capability mapping | Procedure only; it does not prove a connector action or runtime enforcement. |
| Board analytics/reconciliation | `data-analytics:analyze-data-quality`, `validate-data`, `build-report` when analyzing an actual board export | Identify export source/time, row counts, filters and reconciliation method. |
| Board card updates | No dedicated board Skill confirmed; use the native board connector and project protocol | Read live card, preserve its ID/other fields, write only supported fields and read back. Use `NO_APPLICABLE_SKILL` when appropriate. |

Each work order names exact Skill IDs and host. The worker reports `Loaded/Used` with version, or `NO_APPLICABLE_SKILL` / `SKILL_UNAVAILABLE`. Plugins are selected for relevance; there is no requirement to invoke unrelated installed tools.

## Roadmap and currentness

The last available snapshot named five sprint themes: veilige toegang; dossiers en uploads; klant en CMS; connectorfundament; gecontroleerde pilots. These are not current sprint facts until a live read confirms them. The production website scrumboard determines sprint membership, priority, dependencies and status. Map every card to a full-stack outcome and milestone; record unmapped work explicitly. Weft is a historical recovery/crosswalk source; its monthly AI read limit does not block website work.

## Per-card delivery and Git sync

1. Read the live card and record priority, owner role, source branch/commit, environment, dependencies, timebox/checkpoint and Definition of Done.
2. Build the bounded full-stack change and run the relevant checks. Review only the approved card scope and exclude credentials, customer data, secret evidence and private records.
3. Commit the reviewed increment, push to the confirmed branch/PR, then read back remote SHA and CI. Never stage the whole shared worktree by default or let completed changes accumulate into a large unpublished stack.
4. Publish the pinned artifact in DEV, obtain independent TEST/ACC acceptance, promote the same accepted artifact to PROD under the established release process, and read back live version/behavior.
5. Update the primary board with the actual environment, artifact, tests, release status and links; read back the persisted card.

Git push, deployment, board write and live verification are separate facts. A dispatch receipt is not completion. Local and cloud files are not shared without a verified commit/artifact transfer.

## Operating cadence

Scrum controls sprint goals, priority, review and DoD; Kanban controls WIP/blockers. Work strictly sequentially, acknowledge every report, validate its evidence, and then issue one useful continuation or state an explicit wait reason. Every order requests a closing report with changes, source/artifact, environment, checks, limitations, next action and a request for the next assignment.

The hourly monitoring and two-hour email automations were deleted on 9 October 2026. Report meaningful milestones or decisions in the coordinator conversation; do not recreate those automations unless the Product Owner asks.
