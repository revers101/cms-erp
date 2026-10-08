# Transactionele service-ERP-module

GPL-3.0-or-later; Node.js 24 met native `node:sqlite`; geen npm-dependencies of netwerkverkeer. Dit is een aanvullende domeinmodule voor de Node/SQLite-kern. De module vervangt geen CMS, winkel, authenticatiesysteem of boekhoudpakket.

## Gebruik

```js
import { OperationsService, DomainError } from './modules/service-operations/engine.mjs';

// Het hostplatform levert een geauthenticeerde actor; lees diens rol nooit uit een request-body.
const admin = { id: 1, role: 'admin' };
const erp = new OperationsService('/private/path/operations.sqlite', {
  businessTimezone: 'Europe/Amsterdam', // standaard; wordt vastgelegd in deze database
  // now: () => '2026-10-07T12:00:00Z', // uitsluitend een injecteerbare klok voor tests
});
try {
  const customer = erp.createCustomer(admin, { name: 'Demoklant', type: 'b2c' }, 'demo-customer-001');
  let quote = erp.createQuote(admin, {
    customerId: customer.id,
    lines: [{ description: 'Installatie', unitCents: 6000, quantityMilli: 1500, vatBasisPoints: 2100 }],
  }, 'demo-quote-001');
  quote = erp.transitionQuote(admin, quote.id, 'sent', quote.version, 'demo-quote-send-001');
  quote = erp.transitionQuote(admin, quote.id, 'accepted', quote.version, 'demo-quote-accept-001');
  const workorder = erp.createWorkorderFromQuote(admin, quote.id, {}, 'demo-workorder-001');
  console.log({ quoteId: quote.id, workorderId: workorder.id, totalCents: quote.totalCents });
} finally {
  erp.close();
}
```

`DomainError` heeft `code` en `status`: `VALIDATION`/422, `FORBIDDEN`/403, `NOT_FOUND`/404, `CONFLICT`/409. Onverwachte SQLite-/programmeurfouten blijven gewone fouten; de HTTP-adapter verbergt daarvan de interne tekst.

## Exacte API

Alle writes hebben `actor` als eerste en een idempotency-key als laatste argument. Sleutels bestaan uit 8–128 tekens `[A-Za-z0-9._:-]`. Een herhaling met dezelfde actor, rol, operatie en canonieke invoer geeft dezelfde opgeslagen respons, zonder nieuwe audit-, voorraad- of financiële mutaties. Andere invoer met dezelfde actor/key geeft `CONFLICT`. Rechten worden vóór het teruggeven van een gecachte respons gecontroleerd.

| Methode | Invoer naast actor/key | Toegestane rollen |
|---|---|---|
| `createCustomer` | `{name,type:'b2b'|'b2c',email?}` | admin, planner |
| `createResource` | `{name,technicianId}` | admin, planner |
| `createProduct` | `{name,sku,unitCents,vatBasisPoints,stock}` | admin, planner |
| `adjustStock` | `{productId,delta,reason}`; delta is een niet-nul geheel aantal stuks | admin, planner |
| `createQuote` | `{customerId,lines:[{description,unitCents,quantityMilli,vatBasisPoints,productId?}]}` | admin, planner |
| `transitionQuote` | `id,status,version` | admin, planner |
| `createWorkorderFromQuote` | `quoteId,{resourceId?,startAt?,endAt?}` | admin, planner |
| `scheduleWorkorder` | `id,{resourceId,startAt,endAt},version` | admin, planner |
| `transitionWorkorder` | `id,status,version` | admin, planner |
| `recordHours` | `{workorderId,minutes,date,note?}` | admin, planner, toegewezen technician |
| `reserveInventory` | `{workorderId,productId,quantity}` | admin, planner |
| `consumeInventory` | `{workorderId,productId,quantity}` | admin, planner, toegewezen technician |
| `releaseInventory` | `{workorderId,productId,quantity}` | admin, planner |
| `issueInvoice` | `{quoteId,workorderId?,dueDate}` | admin, finance |
| `recordPayment` | `{invoiceId,amountCents,reference}` | admin, finance |
| `issueCreditNote` | `{invoiceId,amountCents,reason}` | admin, finance |

Reads: `get(actor,entity,id)`, `list(actor,entity,{limit=100,offset=0})`, `exportBookkeeping(actor,{limit=100,offset=0})`, `close()`. Entiteiten: `customers`, `resources`, `products`, `quotes`, `workorders`, `hours`, `reservations`, `movements`, `invoices`, `payments`, `credits`, `outbox`, `audit`. Reservaties hebben samengestelde IDs en ondersteunen alleen `list`; `get(workorders,id)` bevat ook `reservations`. `limit` is 1–100; `offset` 0–1.000.000. Loop pagina's af voor een volledige export.

Financial reads/export zijn alleen voor admin/finance. Audit is alleen voor admin. Technician mag producten lezen en uitsluitend de eigen toegewezen werkorders/reservaties en eigen uren. Planner en reader hebben operationele leesrechten. Actor-ID is een positieve veilige integer of een niet-lege string van maximaal 128 tekens; de opgeslagen vorm is een string. Alleen de vijf genoemde rollen worden geaccepteerd. Resources vertegenwoordigen personen: één resource per unieke `technicianId`. Het hostplatform moet controleren dat die identiteit werkelijk bestaat en aan de organisatie is verbonden.

## Invarianten en eenheden

- Alle IDs zijn positieve veilige integers; expliciete `null`, `0`, strings, fracties en niet-bestaande referenties worden afgewezen. Alle objecten gebruiken een strikte veldlijst. Geld is integer eurocent; hoeveelheden op offertes zijn duizendsten (`1500` = 1,5 eenheid). Voorraad, reserveringen en verbruik zijn gehele stuks. Minuten zijn gehele minuten.
- Maximaal 100 offerteregels; prijs 0–100.000.000 cent; regelhoeveelheid 1–1.000.000 duizendsten; btw 0–10.000 basispunten (`2100` = 21%). Nettoregel = `roundHalfUp(unitCents * quantityMilli / 1000)`. Btw per regel = `roundHalfUp(netCents * vatBasisPoints / 10000)`. BigInt-intermediairen voorkomen zwevende-kommafouten. Offertetotaal maximaal 1.000.000.000.000 cent. Het hostplatform kiest de wettelijk toepasselijke btw; deze module bepaalt dat niet.
- Offerte: `draft → sent → accepted|rejected`. Werkorder: `planned → active → done`, of `planned|active → cancelled`. Terminale statussen kunnen niet heropenen. Versies zijn verplicht bij statuswijzigingen en planning; stale versies geven 409. Stockdelta's en financiële toevoegingen zijn ledgeroperaties en controleren hun invariant binnen de database-transactie.
- Eén werkorder per geaccepteerde offerte. Klant-ID wordt uit de offerte afgeleid en kan niet door invoer worden verwisseld. Planning heeft resource, begin en einde gezamenlijk nodig; ISO-tijden moeten een tijdzone bevatten en worden in UTC opgeslagen. Duur is positief en maximaal zeven dagen; halfopen intervallen blokkeren overlap maar laten aansluitende afspraken toe.
- Uren vereisen een actieve, voor een technician toegewezen werkorder. Minuten 1–1440; maximaal 1440 per actor per opgegeven dag, geen toekomstige dag volgens de bedrijfstijdzone. Uren blijven ongewijzigd na herplanning; historie bewaart de oorspronkelijke actor.
- Stock blijft `0 <= reserved <= stock <= 1.000.000`. Reservering/verbruik/vrijgave gebruikt uitsluitend de eigen werkorderreservering. Verbruik verlaagt stock en reserved; vrijgave verlaagt alleen reserved. Annuleren geeft alle resterende reserveringen atomair vrij. Afronden vereist geen resterende reserveringen. Openingsvoorraad en alle delta's leveren append-only voorraadbewegingen op.
- Facturen bewaren klant- en offerteregels als snapshots. Indien de offerte al een werkorder heeft, moet die afgerond zijn, ook wanneer `workorderId` wordt weggelaten. Een expliciete werkorder moet bij dezelfde offerte/klant horen. Eén factuur per offerte. Nummerreeksen `INV-YYYY-000001` en `CRN-YYYY-000001` lopen transactioneel per kalenderjaar volgens de vaste bedrijfstijdzone. `issuedAt` is UTC, `issuedDate` is de lokale kalenderdatum; vervaldatum mag die datum niet voorafgaan.
- Betalingen zijn positief, een referentie is per factuur uniek en totaal betaald + gecrediteerd mag de factuurwaarde nooit overschrijden. Credits verwijzen naar de originele factuur en zijn begrensd door de onbetaalde balans. Terugbetaling van reeds betaald geld heeft een aparte workflow nodig en wordt hier afgewezen. De originele factuurwaarde verandert niet; reads berekenen `paidCents`, `creditedCents` en `balanceCents` uit de ledger.

## Opslag en integratie

Alle tabellen/indexen/triggers gebruiken `ops_`; de module maakt geen generieke coretabellen aan. SQLite foreign keys, WAL en een busy-timeout van 5000 ms zijn ingeschakeld. Iedere businesswrite doet één `BEGIN IMMEDIATE`/`COMMIT`; businessrecords, audit, boekhoud-outbox en idempotency-respons worden gezamenlijk geschreven of gezamenlijk teruggedraaid. Audit bevat operatie, actor-/record-ID en tijd; geen klantvelden of vrije notities. SQL-triggers blokkeren update/delete van uren, facturen, betalingen, credits, voorraadbewegingen en audit. Dat beschermt tegen applicatiefouten, niet tegen een databasebeheerder die triggers verwijdert.

Boekhoud-outbox bevat snapshots van `invoice.issued`, `payment.recorded` en `credit.issued`. `exportBookkeeping` geeft `{generatedAt,entries}`; er wordt niets naar Moneybird, mail, banken of andere diensten verstuurd. `exportedAt` blijft null: er is nog geen provider-ACK of exportstatusmutatie. Het hostplatform moet provider-mapping, deduplicatie en ontvangstbewijs implementeren.

Dit is één organisatie per module-database. De module deelt bewust nog geen IDs met bestaande kernklanten/producten: de kernbouwer moet expliciete mapping/import toepassen en geen gelijkheid van toevallige numeric IDs aannemen. `ops_` voorkomt tabelnaamconflicten, maar lost klant-/productintegratie of multi-tenant autorisatie niet op. Open de database in een private directory buiten publieke webroot; gebruik hosttoegangscontrole, backups en restoretests. Bewaar geen productie-DB, WAL, secrets of klantdata in Git.

Grenzen: geen sessies/SSO/CSRF/TLS, geen winkelcheckout of betalingen via PSP, geen personeelsdirectory, geen PDF/mails, geen definitieve fiscale factuurpresentatie met leveranciersidentiteit, geen credit-btwverdeling/refundprovider, geen uren-correctieledger, geen CRUD-bewerken/deleten van klant- of productsnapshots, geen organisatie-migratie of online schémamigraties. De module is geen claim van een volledig productierijp CMS/ERP-platform. De HTTP-adapter moet hostauthenticatie en afgeschermde CORS combineren; nooit een client-aangeleverde actor vertrouwen.

## Verificatie

```sh
node --check modules/service-operations/engine.mjs
node --test modules/service-operations/operations.test.mjs
```

De onafhankelijke acceptatiesuite gebruikt tijdelijke databases en synthetische data. Zij controleert de operationele/financiële keten, herstart, rollen, idempotency, geld/eenheden, planning, technician-ownership, voorraad, betalingen/credits en rollback bij een echte falende audit-trigger. De HTTP-suite is apart; een geslaagde domeinsuite bewijst geen live hostintegratie.
