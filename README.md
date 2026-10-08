# CMS ERP

This is the reviewed development-source snapshot, not a deployed Site release.
See [snapshot provenance and checks](docs/APPLICATION-SNAPSHOT.md). The internal
[website scrum board](https://www.cai-techniek.nl/app/board) is the primary project
record; execution environment and production release state are separate.

An open-source foundation for a Dutch-language CMS and service ERP. The
repository currently contains portable domain rules, a transactional service
operations module, a reviewed CMS content service and a read-only WooCommerce
product import planner.

## Current components

- [`modules/service-operations/`](modules/service-operations/): Node.js 24 and
  SQLite service operations for customers, quotes, work orders, scheduling,
  inventory, time, invoices, payments, credits, audit and a local bookkeeping
  outbox. See its [API and invariants](modules/service-operations/ENGINE.md) and
  [host integration contract](modules/service-operations/INTEGRATION.md).
- [`modules/content-management/`](modules/content-management/): a Node.js 24 and
  SQLite content service for pages, articles, services, projects and FAQs, with
  draft review, publishing, revisions and a public HTML renderer. See its
  [integration contract](modules/content-management/INTEGRATION.md).
- [`integrations/wordpress-contract/`](integrations/wordpress-contract/): pure
  pricing, status, version and reference rules transferred from the WordPress
  handoff.
- [`integrations/wordpress-import/`](integrations/wordpress-import/): a pure
  WooCommerce product snapshot planner. The host fetches data and reviews the
  plan; this module has no credentials, network access or write operations.

The repository also includes a Node host in `src/` and a browser management
interface in `web/`. It provides first-run admin setup, session login, a CMS
editor with owner review before publication, public content pages, and
operational screens for customers, resources,
products, quotes, work orders, scheduling, hours, stock reservations and
movements, invoices, payments, credit notes and bookkeeping outbox exports.
Resource assignment is limited to active technician accounts. Lists are
paginated and writes use stable idempotency keys for retryable requests.

The host is still single-organization. Optional authenticator-app MFA is
implemented for local accounts. Multi-tenant administration, media uploads,
production deployment automation, a live WordPress connector, provider
delivery, and legally reviewed invoice layouts remain separate work.

An optional ChatGPT MCP endpoint is implemented at `/mcp`. It is disabled when
Auth0 configuration is absent and fails closed on partial configuration. When
enabled, it reuses the same CMS/ERP services and local account roles, advertises
per-tool OAuth scopes, and returns ChatGPT-compatible authorization challenges.
See
[`docs/MCP-AUTH0.md`](docs/MCP-AUTH0.md) for the configuration and current
deployment boundaries. This code is not yet connected to the existing Site or
published as a ChatGPT plugin; no public endpoint or live OAuth acceptance is
claimed.

The existing CAI Business OS Site already has its own `/app/cms` interface,
content collections and owner-review workflow. This host is not wired into that
Site and must not be deployed over its homepage or CMS route. Read
[`docs/EXISTING-SITE-INTEGRATION.md`](docs/EXISTING-SITE-INTEGRATION.md) before
connecting a Site or ACC environment. The Site keeps its current content and
authentication as the integration authority until an explicit adapter has
been built and accepted.

## Run the application

Use Node.js 24.19.0 or later within major version 24. Install the locked
dependencies first with `pnpm install --frozen-lockfile --ignore-scripts`. Set a
unique bootstrap password on the first run. These PowerShell commands keep the password in the
current process environment; do not save real credentials in `.env.example` or
Git:

```powershell
$env:CMS_ERP_ORIGIN = 'http://127.0.0.1:3000'
$env:CMS_ERP_BOOTSTRAP_EMAIL = 'admin@example.test'
$env:CMS_ERP_BOOTSTRAP_PASSWORD = 'replace-with-a-long-unique-password'
node src/server.mjs
```

Open `http://127.0.0.1:3000`. The first run creates the admin account only when
the database has no users. Later restarts do not reset its password. The
SQLite database is stored under the ignored `var/` directory by default; set
`CMS_ERP_DATABASE` to a private absolute path for deployment. Production needs
an exact `CMS_ERP_ORIGIN` using HTTPS, secure cookies, TLS at the public edge,
backups, monitoring and a persistent private data volume.

The first admin can use the content and ERP screens and invite role-based
accounts. Invitation links are single-use, expire after seven days, and let the
recipient set their own password. Admins can revoke an open invitation or
resend it, which rotates the previous link after delivery. Invite delivery
requires Resend configuration in the private runtime. Admins can
change account roles or deactivate accounts; each change is audited,
idempotent, and revokes the affected account's sessions. The last
active admin cannot be removed. Every signed-in user can change their password
after confirming the current password; changing it rotates the current session
and revokes the account's other sessions. Password recovery is available when
both
`RESEND_API_KEY` and `RESEND_FROM_EMAIL` are configured in the private runtime.
Reset links are single-use, expire after 30 minutes, and invalidate existing
sessions. If mail delivery is not configured, the recovery endpoint stays
unavailable internally and still returns a generic confirmation without
issuing a token. Users can optionally enroll authenticator-app MFA from account
settings. Enrollment requires the current password and confirmation of a
time-based code; login then requires a fresh code or one of ten single-use
recovery codes. Recovery codes are shown once. Configure
`CMS_ERP_MFA_ENCRYPTION_KEY` only in the private runtime as 32 random bytes
encoded in 64 hexadecimal characters. Back up that key with the private
database: startup fails closed if MFA-enabled accounts exist and the key is
missing. The authenticator secret is encrypted at rest with AES-256-GCM. The
key is separate from `AUTH0_*`, which configures the optional MCP resource
server. Tenant isolation and production-grade team administration are not
implemented yet.

## Verify the modules

Use Node.js 24.19.0 or later within major version 24. From the repository root:

```sh
node --test test/*.test.mjs integrations/wordpress-contract/*.test.mjs modules/content-management/*.test.mjs modules/service-operations/*.test.mjs integrations/wordpress-import/*.test.mjs
```

The API suite starts the local host with a temporary SQLite database and
synthetic credentials; it does not connect to ACC, production or a live Site.

The optional MCP endpoint uses the official MCP TypeScript server/node packages,
`jose` for Auth0 JWT verification and `zod` for tool input schemas. The host and
modules are GPL-3.0-or-later; each component directory contains its detailed
integration boundaries.
