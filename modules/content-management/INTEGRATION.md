# Content service host contract

The module exports `ContentService`, `validateContent`, `renderPublicContent`
and `createContentHandler` from `engine.mjs` and `http.mjs`. The host owns
identity, tenant selection, session security, UI, networking and deployment.

## Runtime and persistence

- Run Node.js `>=24.19.0 <25` with its built-in `node:sqlite` support.
- Pass an absolute path to a private SQLite file to `new ContentService(path)`.
  A host may use the same file as service operations; each module owns tables
  with its own prefix. Keep the file and backups outside public/static paths.
- Run the owning service on a single database writer or configure SQLite
  locking and backups for the host's deployment model.
- Call `close()` during orderly shutdown.

## Content and workflow

Create content with `createContent(actor, content, idempotencyKey)`. Update it
with `updateContent(actor, id, content, expectedVersion, idempotencyKey)`.
Publish and archive with their corresponding methods and expected version.
Every write is transactional, version checked, and idempotent per actor/key.
Conflicting slugs and stale versions return a `ContentError` with code
`CONFLICT`. Content can be read with `getManaged`/`listManaged`; immutable
snapshots are returned by `listRevisions`.

| Role | Create/edit | Submit for review | Approve/publish/archive | Read management data |
| --- | --- | --- | --- | --- |
| `admin` | Any | Yes | Yes | All |
| `editor` | Own content | Own content | No | Own content and revisions |
| `publisher` | No | No | Yes | All |
| `reader` | No | No | No | No |

An edit to published content keeps its prior published snapshot public until a
publisher approves the new version. Editors/admins must submit the current
version for review; publishers/admins may publish only a pending review or
return it for changes. Updating returned content clears the review request and
requires resubmission. Archiving removes it from public lookup. Editors can
update archived content to restore it as a draft.

Allowed content fields are `type`, `title`, `slug`, `summary`, `blocks`,
`seoTitle` and `seoDescription`. Slugs are lowercase ASCII segments joined by
hyphens. Paragraphs, headings and list items are plain text. Do not put private
customer data, credentials or internal workflow notes into public content.

## HTTP adapter

Create the adapter with the actual service and host-owned controls:

```js
const handleContent = createContentHandler({
  service,
  resolveActor: (request) => authenticatedSessionActor(request),
  verifyCsrf: (request, actor) => hostCsrfCheck(request, actor),
  allowedOrigin: 'https://cms.example.com', // reserved example; set the exact host origin
});
```

Mount it on the host's Node HTTP server and call it before the not-found
handler. It returns `false` for unrelated paths and handles paths under
`/api/content`.

| Method and path | Access | Purpose |
| --- | --- | --- |
| `GET /api/content/public/:slug` | Public | Published item by live slug |
| `GET /api/content/public?limit=&offset=&type=` | Public | Published listing |
| `GET /api/content/items?limit=&offset=&type=&status=` | Authenticated | Managed listing |
| `GET /api/content/items/:id` | Authenticated | Managed item |
| `GET /api/content/items/:id/revisions` | Authenticated | Revision history |
| `POST /api/content/commands/create` | Authenticated, CSRF | Create draft |
| `POST /api/content/commands/update` | Authenticated, CSRF | Edit draft/work version |
| `POST /api/content/commands/submit-review` | Authenticated, CSRF | Submit current version for owner review |
| `POST /api/content/commands/return-for-changes` | Authenticated, CSRF | Return pending review to the author |
| `POST /api/content/commands/publish` | Authenticated, CSRF | Approve and publish a pending version |
| `POST /api/content/commands/archive` | Authenticated, CSRF | Archive item |

Every command requires JSON and an `Idempotency-Key` header. The adapter checks
the exact configured HTTPS origin (localhost HTTP is allowed for development),
requires the same origin on writes, and requires `verifyCsrf` to return the
literal boolean `true`. It accepts a verified actor from `resolveActor`; client
identity headers are ignored. It returns generic error bodies and a request ID.

The adapter's in-memory rate counter applies only to management routes in one
process. The host must also provide shared rate limiting at its gateway for
multi-process or public traffic, tenant authorization, secure session cookies,
CSRF token issuance, logging/monitoring, database backups and production
availability controls. Review the host configuration before exposing routes.

Public consumers should call `getPublished`/`listPublished` and may pass the
returned model to `renderPublicContent`. That model omits author IDs, internal
versions, draft data and revision/audit history. The renderer is an article
fragment, not a complete page or a sanitizer for host-provided HTML; only its
closed text block model is accepted.
