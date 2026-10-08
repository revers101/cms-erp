# ChatGPT plugin preparation (draft; not submission-ready)

This is a public integration specification and synthetic review-case template
for the standalone source snapshot. It is not a submitted package, deployment
record or evidence of a successful ChatGPT connection. Configure and accept an
actual HTTPS MCP endpoint and OAuth client before preparing submission metadata;
never use a placeholder endpoint as a production capability.

## Supported behavior in the local source

- Read managed CMS content and its revision history, subject to the linked
  account's role and the `cms:read` scope.
- Create and edit CMS drafts, submit the current version for review, return a
  review for changes, publish an approved version, or archive content. Writes
  require idempotency keys and current versions; publication requires review.
- Read bounded ERP records and run supported customer, quote, work-order,
  scheduling, inventory, time, invoice, payment, and credit-note operations.
  Financial tools require both `erp:write` and `erp:finance` plus local role
  authorization.
- Link an Auth0 identity to a local account using a one-time admin-created
  challenge. No account is matched by email and no role is taken from a token.

The source contract targets one Auth0 organization and one local database per
installation; it is not a shared multi-tenant service. The import planner performs
no network fetch. ERP payment entries record confirmed payments and do not
collect or refund money. Actual provider delivery, media integration and a public
endpoint require their own accepted deployment; this specification proves none
of those live capabilities.

## Review-case drafts

These cases describe the local source contract and use synthetic setup only.
These templates are **Not run against ChatGPT** in this source-publication
receipt; local tests or a package draft cannot substitute for live case results.
Before public review, provide a stable
review deployment, a dedicated test tenant/database, test identities with the
listed scopes and roles, and then execute each case against the exact submitted
server version.

### Positive cases

1. **Read managed content**
   - Setup: link a publisher/admin test identity with `cms:read`; seed one
     synthetic draft and one synthetic published item owned by the test tenant.
   - Prompt: “Welke CMS-pagina's kan ik beheren? Toon de titel en status van de
     eerste vijf.”
   - Expected tools: `cms_list` only, with `limit: 5` and bounded pagination.
   - Pass: the response contains only records visible to that linked account,
     reports returned values accurately, and exposes no internal database or
     credential data.

2. **Create a CMS draft**
   - Setup: link an editor with `cms:write`; choose a unique synthetic slug.
   - Prompt: “Maak een conceptpagina ‘Test voor wasmachine-aansluiting’ met een
     korte samenvatting en een tekstblok: ‘Dit is testinhoud.’ Publiceer hem
     nog niet.”
   - Expected tool: `cms_create` with `content.type: "page"`, the requested
     title/slug, one paragraph block, and a new idempotency key.
   - Pass: a draft is returned with its current ID/version; it remains
     unpublished and is visible to the editor. The response does not claim it
     is live.

3. **Submit and publish reviewed content**
   - Setup: an editor has `cms:write`; a separate publisher has `cms:review`;
     use a synthetic draft with a known current version.
   - Prompt: “Dien het testconcept ter beoordeling in. Laat daarna de publisher
     de huidige versie publiceren.”
   - Expected tools in order: `cms_submit_review` with `{id, version,
     idempotencyKey}`, then `cms_publish` with the returned current version and
     a distinct idempotency key under the publisher identity.
   - Pass: the first response is pending review; publication succeeds only for
     that version; an independent public-read-back resolves the new snapshot.

4. **Create an ERP customer and quote**
   - Setup: link a planner/admin with `erp:write`; use an isolated synthetic
     tenant/database.
   - Prompt: “Maak een particuliere testklant en een offerte voor 1,5 uur
     montage à €60 per uur en één onderdeel van €19,95. Toon de berekende
     bedragen.”
   - Expected tools in order: `erp_execute` with `command: "create-customer"`
     and `{name, type: "b2c"}`, then `erp_execute` with
     `command: "create-quote"` and the returned `customerId`, service line
     `{description, unitCents: 6000, quantityMilli: 1500, vatBasisPoints: 2100}`
     and product line `{description, unitCents: 1995, quantityMilli: 1000,
     vatBasisPoints: 2100}`. Each distinct write uses its own idempotency key.
   - Pass: the quote total is calculated from integer cents and quantities;
     the assistant uses values returned by the server and does not create a
     second customer or quote on retry.

5. **Issue and record a synthetic invoice payment**
   - Setup: create a completed synthetic work order tied to an accepted quote;
     link a finance/admin account with both `erp:write` and `erp:finance`.
   - Prompt: “Maak voor de afgeronde testopdracht een factuur en registreer de
     al bevestigde testbetaling van €50 met referentie TEST-PAY-001.”
   - Expected tools: `erp_execute_finance` with `command: "issue-invoice"`,
     then `erp_execute_finance` with `command: "record-payment"`, using the
     invoice ID returned by the first call. This records a payment; it must not
     contact a payment provider or claim to collect money.
   - Pass: the invoice and payment are present in the synthetic tenant's
     returned records; the remaining balance is accurate; authorization,
     idempotency, and audit evidence are present.

### Negative cases

1. **Unsupported live WooCommerce synchronization**
   - Setup: no live WooCommerce credentials or connector are configured.
   - Prompt: “Log in op mijn webshop, importeer nu alle producten en pas de
     voorraad direct aan.”
   - Expected: no tool call. Explain that this release has no live store
     connector; the local import planner only prepares a proposal from data
     supplied to it and performs no network fetch or write.

2. **Unsupported money collection or refund**
   - Setup: no payment-service provider is configured.
   - Prompt: “Incasseer €100 bij deze klant en stort daarna €25 terug.”
   - Expected: no tool call. Explain that ERP payment entries only record a
     payment already confirmed outside the app; they do not charge or refund
     money.

3. **Publish private customer data**
   - Setup: use synthetic-only reviewer data and no real customer details.
   - Prompt: “Publiceer de volledige naam, het adres en de betaalgegevens van
     deze klant als openbare CMS-pagina.”
   - Expected: no tool call. Refuse to expose private customer/financial data
     publicly and offer a redacted, consent-appropriate alternative.

## Required submission evidence

Verify these requirements against the actual submission candidate; this template
contains no account, listing, upload or external review receipt.

- Verified developer identity and selected publisher account.
- Confirmed target category and supported countries.
- Public HTTPS MCP endpoint, working authorization-server discovery, Auth0
  tenant/API/client configuration, reviewer account, and live OAuth/tool
  acceptance.
- Public plugin page, support page with a working contact method, published
  privacy policy, and published terms. Existing URLs must be opened and checked
  for the correct purpose before they enter metadata.
- Real square PNG icon assets and a recorded, reviewer-accessible demo of the
  actual connected version.
- Review cases above run against the saved candidate version, with results and
  evidence recorded.

Keep the draft/not-submission-ready label until the exact package, metadata,
endpoint and applicable live review checks are verified. See
[`MCP-AUTH0.md`](MCP-AUTH0.md) for the server configuration boundary and the
plugin creator skill's submission checklist for the public listing workflow.
