# Draagbaar WordPress/Node-domeincontract

Deze map bevat uitsluitend overdraagbare domeinlogica en synthetische tests. Geen WordPress-distributie, database, klanten, runtime-instellingen of geheimen. De hostapplicatie moet zelf opslag, autorisatie, migraties en publicatie leveren.

## Referentiekandidaat

Bevroren ZIP: cai-cms-erp-wordpress-handoff-2026-10-07.zip. SHA-256: 5e100ef21b7b04d557e7288d27f757dfc4259a498b694b5d76678cadece2f748.
Dit is herkomstcontext van een referentiepakket; het is geen acceptatiebewijs voor de Node-applicatie, een webshopcheckout, echte betaling of live website-integratie.

## Overdraagbare functies

- CMS: pagina/artikel/dienst/project/FAQ, concepten, rollen, revisies, SEO en contentimport/export. WordPress implementatie blijft referentie; Node moet eigen opslag en autorisatie leveren.
- ERP-records: customer(B2B/B2C), quote, workorder, time, ledger.
- B2B vereist company; offertes verwijzen naar een klant; werkbonnen mogen alleen een accepted offerte van dezelfde klant refereren.
- quote: draft -> sent -> accepted/rejected. workorder: planned -> active/cancelled; active -> done/cancelled.
- Prijsregels: description, unit_cents, quantity_milli. Regelafronding half-up, som van afgeronde regels. EUR exclusief btw; geen fiscaal rekenmodel.
- time:workorder_id,minutes1..1440,date,description. ledger:workorder_id,amount_cents,date,description,type income/expense. Beide immutable; correcties vereisen expliciet auditbaar ontwerp in Node.
- WooCommerce-orderverwijzing alleen lezen/koppelen. Geen tweede betaling, orderengine of voorraadmutatie.

## Referentie-API en rechten

WP capability manage_cai_erp; administrator en cai_planner. Geen record-/tenantafbakening in de referentie: niet blind kopiëren.
Basis /wp-json/cai-erp/v1:
GET/POST /records/{customer|quote|workorder|time|ledger}; GET/PATCH /records/{kind}/{id}; GET /export?page=N.
POST optionele Idempotency-Key,8..100 alfanumeriek/_/-, uniek per kind; andere inhoud zelfde sleutel409. PATCH vereist version; stale409. Gasten401, onbevoegde gebruikers403. Lijst100/pagina; registerexport1000/pagina in JSON csv-veld. POST/PATCH maximaal262144 bytes.

## Dit pakket

domain.mjs: pure money/status/version/reference helpers; BigInt intermediate, safe Number outputs. Geen authenticatie, HTML-sanitizer, SQL, HTTP of volledige recordvalidator.
domain.test.mjs:15 Node-tests met uitsluitend synthetische data. Uitvoeren vanuit repo-root:
node --test integrations/wordpress-contract/domain.test.mjs

Explicit null/zero optional references worden hier streng geweigerd: een HARDENING ten opzichte van de bevroren PHP-kandidaat, geen claim dat die kandidaat al gefixt is. PHP sanitize_text_field is niet nagebouwd; tekst die later in HTML wordt geplaatst moet door de app correct worden escaped/gesanitiseerd. Geldfunctie staat lege materialen toe; offertevalidatie moet minimaal één regel afdwingen.

## Hostintegratievereisten

1. Genormaliseerde tabellen met foreign keys, transaksiemutatie plus audit samen, optimistic UPDATE WHERE version, DB-unieke idempotentiesleutel en canonieke payloadhash.
2. Autorisatie per record/klant/tenant, geen publieke klant/exportroutes; secrets alleen server-side. Gegevens niet automatisch tussen WP en Node synchroniseren.
3. Woo-order bestaat is onvoldoende: controleer klantbinding, ordertype en gewenste unieke werkbon/orderrelatie.
4. Register is geen wettelijke boekhouding of Moneybird-import. sent/accepted statussen bewijzen geen mailbezorging/klantondertekening.
5. Sites adapter alleen publieke published content; returned HTML is niet gesanitiseerd, DNS-rebinding niet volledig afgevangen.
6. Valideer de uiteindelijke hostingconfiguratie, HTTPS en toegangsgrenzen afzonderlijk. Bied geen ontwikkelomgeving met demologin openbaar aan. Dit pakket wijzigt geen deployment of securityinstellingen.

## Integratiegrens

Neem rekenregels/statuscontracten/tests over via een expliciete adapter en hosttests. Laat één systeem eigenaar zijn van ieder bedrijfsobject. WordPress-hooks/nonces/PHP UI zijn geen Node-functionaliteit. De portable bron declareert GPL-3.0-or-later; behoud SPDX, LICENSE en NOTICE.md. Zie docs/LICENSE-PROVENANCE.md in de repository voor de geverifieerde herkomst en resterende rechtenbeoordeling.
