# Service operations

This directory contains two related but independent layers:

- `domain.mjs` provides portable customer, quote, work order, time and ledger
  validators plus version and idempotency helpers.
- `engine.mjs` provides the transactional Node.js 24 and SQLite operations
  service. It owns its `ops_` tables and implements role checks, durable
  idempotency, audit records, inventory movements and a local bookkeeping
  outbox.

The SQLite engine is the application-facing implementation. The portable
helpers remain available for callers that need the smaller validation contract;
the engine does not depend on them. The HTTP adapter translates requests but
does not start a server or authenticate users.

See [the engine API and invariants](ENGINE.md) and
[the host integration contract](INTEGRATION.md) before connecting this module
to an application. The host must provide verified sessions, CSRF and origin
checks, organization boundaries, a private database path, backups and the CMS
user interface. This module is not a complete CMS or deployed ERP.

Run the repository's module tests from the root with:

```sh
node --test integrations/wordpress-contract/domain.test.mjs modules/service-operations/*.test.mjs integrations/wordpress-import/*.test.mjs
```

The domain module, SQLite engine and HTTP adapter have no npm dependencies or
network behavior. The engine is licensed under GPL-3.0-or-later.
