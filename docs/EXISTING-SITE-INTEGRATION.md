# Existing website integration contract

This document is public architecture guidance for connecting the standalone
Node/SQLite application to an existing website. It is not a Site source audit,
a runtime configuration record or deployment/acceptance evidence.

## Host boundary

The existing website remains the owner of its homepage, customer login, CMS
routes and data. Do not replace its origin, authentication or published content
with the standalone host. The Node host is a separate application and needs an
explicit integration architecture before website use.

The standalone services use synchronous `node:sqlite` and SQLite transactions.
A Worker/D1 deployment requires an implementation that preserves the domain,
transaction, audit and idempotency guarantees on its own asynchronous storage
interface, or a separately hosted Node service with an authenticated bridge.
The Node modules cannot be imported as a drop-in Worker persistence layer.

## Adapter contract

- Reuse the website's verified server-side session identity. Never take actor,
  tenant or role authority from request JSON, an email or a caller-supplied header.
- Preserve the existing `/app/cms`, `/api/os` and `/api/editorial` contracts where
  those routes are used. Add an explicitly versioned adapter instead of silently
  changing an existing route's behavior.
- Apply least-privilege role and record/tenant checks for each operation. OAuth
  scope is an additional condition and does not replace local authorization.
- Require exact configured origin and session-bound CSRF on browser mutations.
  Use bounded streaming input validation and generic errors without credentials.
- Make source-to-target IDs explicit. Use supplied optimistic versions, durable
  actor-scoped idempotency keys and payload fingerprints. Preserve atomic
  mutation/audit/replay or document and test the chosen storage guarantees.
- Map content schemas explicitly. Only published public projections may enter
  the public renderer; keep drafts, personal records and internal audit data out.
- Preserve the review/publisher approval stage and current published snapshot.
  An edit is not authorization to publish.
- Keep runtime credentials, configuration and actual user data outside public
  source. Example values do not constitute provider setup or live acceptance.

## Acceptance and operation

Pin source/artifact and environment before building the adapter. Test synthetic
main workflows, allow/deny, retries, concurrent versions, persistence and rollback
in DEV and independently in TEST/ACC. Promote the accepted artifact to PROD,
then read back the actual version and affected behavior. Record project progress
on the primary website board with environment and release state separately.

Host deployment must separately validate trusted proxy identity and shared
rate-limiting behavior, secure cookies, monitoring, restore and availability.
This guide supplies no proxy-header policy or live hosting acceptance.
