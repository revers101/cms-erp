# CMS content management

This Node.js 24 module provides a content domain service and an HTTP handler
adapter for a host CMS application. It stores drafts, published snapshots,
revision history and audit events in SQLite. It can share a private SQLite
database with `modules/service-operations/`.

Supported types are `page`, `article`, `service`, `project` and `faq`. Content
uses a closed block model: paragraphs, level 2–4 headings and ordered or
unordered lists. Arbitrary HTML and scriptable blocks are rejected. The public
renderer validates its input and escapes text before producing markup.

Run the module checks with `npm test` from this directory, or from the repo
root with the command in the top-level README. See [INTEGRATION.md](INTEGRATION.md)
for the host contract and [schema.sql](schema.sql) for the storage layout.

This is a backend building block. It does not include a visual editor, media
uploads, localization, scheduling, frontend routing or deployment.
