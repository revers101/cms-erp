# WordPress / WooCommerce product import planner

GPL-3.0-or-later. Native Node ES modules, no npm dependencies, network, credentials,
database access or write operations. This is a product snapshot planner, not a
running WordPress connector or a stock synchronization service.

```js
import { planProductImport } from './planner.mjs';
const proposals = planProductImport({
  siteOrigin: 'https://winkel.example.test',
  currency: 'EUR',
  pricesIncludeTax: false,
  taxClasses: { '': 2100, reduced: 900, zero: 0 }
}, productsFromTrustedHost);
// [{ operation: 'createProduct', source: { provider, siteOrigin, productId },
//    input: { name, sku, unitCents, vatBasisPoints, stock } }]
```

The trusted host must confirm the site's currency and that the current `price`
is net of tax. Neither fact is established by this product payload. Class rates
are explicit reviewed configuration, not a guess from the class name. The empty
class string denotes WooCommerce's standard tax class. Only `taxable` products
are supported; an explicit zero class maps to zero basis points. Tax-exempt and
shipping-only statuses require a separate reviewed policy and are rejected here.
Prices use decimal strings with at most two fractional digits, converted through
BigInt without rounding. Values above 100,000,000 cents are rejected to match ERP.

Accepts a batch of 0–100 simple products with `manage_stock: true`,
`backorders: 'no'`, integer `stock_quantity` 0–1,000,000 and a nonempty SKU.
Names/SKUs must be plain text; HTML, entity markup, controls and format controls
are rejected. Name/SKU limits match `OperationsService.createProduct`: 200/80
JavaScript string units. The entire batch rejects on an invalid record, duplicate
source ID or duplicate trimmed SKU. Input objects are never changed. Extra source
fields, including descriptions, customer data and metadata, are never projected.
Treat all resulting strings as data and escape them at the UI output boundary.

## Host contract before execution

1. Fetch/authenticate in the host, never in this pure module. Supply an explicit
   HTTPS origin without a path, query or credentials; the canonical origin and
   Woo product ID form the source identity. Woo IDs are not ERP IDs.
2. Persist a unique `(provider, siteOrigin, productId) → erpProductId` mapping.
   Resolve existing mappings and ERP SKU collisions before accepting proposals.
   A proposal is always a *create* proposal, never an authorized upsert. Repeating
   a batch or seeing a previously mapped source must not create another product.
3. Execute with an authenticated admin/planner actor. Store a stable idempotency
   key and exact approved payload in the host's durable import job; retries must
   reuse both. Same source ID with a changed payload requires a new reviewed job,
   not reuse of a cached create key. Do not use a random key on each retry.
4. Persist mapping and successful operation results with crash recovery. Engine
   idempotency protects a retried create, but this planner supplies no database
   transaction across product creation and external mapping persistence.
5. Initial `stock` is an opening inventory amount. Do not repeatedly overwrite
   ERP inventory from remote snapshots: reservations and movement history must
   remain authoritative. Later stock adjustments require their own audited flow.

Virtual/downloadable flags, descriptions, options, customer/order import,
variable products, shipping tax and multi-rate tax calculation are not represented
in the ERP product schema. Do not interpret these proposals as equivalent shop
products or a complete migration. No secrets belong in source configuration or
error messages; `ImportPlanError.code` contains only a fixed error identifier.

## Verify

From the repository root (Node 24 for the actual ERP compatibility test):

```sh
node --test integrations/wordpress-import/planner.test.mjs
```

Tests cover exact money, source identity, whole-batch rejection, privacy projection,
immutability, unsafe input and a real in-memory SQLite ERP create/idempotent retry.

The supported source fields follow the official WooCommerce REST v3
[Products documentation](https://developer.woocommerce.com/docs/apis/rest-api/v3/products),
reviewed 2026-10-07. These are adapter policy restrictions, not claims that all
WooCommerce products have net prices or that all tax classes imply one fixed rate.
