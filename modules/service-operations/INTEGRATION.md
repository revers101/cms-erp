# Integratie in de bestaande kern

Dit onderdeel levert een operations-service en een HTTP-handler. Het start geen server en bevat geen eigen gebruikers- of CMS-systeem. De appbouwer sluit het aan op bestaande sessies, routes en UI. De handler wacht op servicecalls, zodat de host zowel directe resultaten als promises kan afhandelen. De meegeleverde `OperationsService` gebruikt nog steeds synchrone Node 24 `node:sqlite`; er is nog geen D1-implementatie. Voer de tests uit met de concrete runtime die je uitrolt.

## Identiteit, rollen en database

`resolveActor(req)` moet de actor uit een werkelijk gevalideerde serversessie ophalen. Gebruik nooit een rol of gebruikers-ID uit een header, verzoekbody of onbeveiligde cookie. Het resultaat heeft `{id, role}` met een positief integer-ID of een begrensde serveridentificatie als tekst en een rol `admin`, `planner`, `technician`, `finance` of `reader`.

De database is bedoeld voor één organisatie. De hostapp kiest een vaste private databasepad/configuratie; geen pad uit een URL of klant-ID gebruiken. Voor meerdere organisaties moet de kern een geverifieerde organisatiebinding met een gescheiden database of uitgebreid objectmodel afdwingen. De module is geen bewezen multi-tenant ERP.

`verifyCsrf(req, actor)` controleert een sessiegebonden token en geeft alleen bij een geldig token de boolean `true` terug. De handler eist daarnaast de exact geconfigureerde Origin op schrijfacties. Configureer de uiteindelijke cookies zelf met passende `HttpOnly`, `Secure`, `SameSite`, sessieverval en logout. Het callback-contract is geen geïmplementeerde login.

## Aansluiten

```js
import {OperationsService} from './modules/service-operations/engine.mjs';
import {createOperationsHandler} from './modules/service-operations/http.mjs';

const operations = new OperationsService(privateDatabasePath);
const handleOperations = createOperationsHandler({
  service: operations,
  allowedOrigin: 'https://cms.example.test',
  resolveActor: existingVerifiedSessionResolver,
  verifyCsrf: existingSessionCsrfVerifier,
  onError: ({requestId, code}) => existingLogger.error({requestId, code})
});

// In de bestaande server, vóór de algemene 404-handler:
if (await handleOperations(req, res)) return;
// Daarna de bestaande CMS/webshop-routes.
```

De handler retourneert `false` voor routes buiten `/api/operations`. Gebruik aan de serverkant ook een request-timeout, header-timeout, maximale headeromvang en een globale limiet vóór sessieresolutie. De ingebouwde actorlimiet is per proces en vervangt geen gedeelde proxy-/app-limiet bij meerdere instanties. Stel de request-bodytimeout van de server in; de adapter begrenst ook JSON tot 256 KiB en vijf seconden.

## Routes

GET `/api/operations/{entity}` en GET `/api/operations/{entity}/{id}` gebruiken de rollencontrole van de service. Entiteiten: resources, customers, products, quotes, workorders, hours, reservations, movements, invoices, payments, credits, outbox, audit. Reserveringen ondersteunen alleen de lijst vanwege hun samengestelde sleutel. GET `/api/operations/bookkeeping` geeft de lokale boekhoudexport. Lijsten en export accepteren alleen `limit` (1–100) en `offset` (0–1.000.000), standaard 100 en 0. Loop pagina's af totdat een pagina minder dan `limit` records bevat. Eén lijstpagina is geen volledige administratie-export.

POST `/api/operations/commands/{command}` eist JSON, een geldige sessie, Origin, CSRF en `Idempotency-Key` met 8–100 ASCII-tekens uit letters, cijfers, `.`, `_`, `:`, `-`. Kies voor elke nieuwe intentie een nieuwe sleutel en hergebruik dezelfde sleutel uitsluitend voor dezelfde herhaling. Een UI mag na een netwerkfout niet automatisch een nieuwe sleutel kiezen.

Commandonamen: create-resource, create-customer, create-product, adjust-stock, create-quote, quote-status, workorder-from-quote, schedule-workorder, workorder-status, record-hours, reserve-inventory, consume-inventory, release-inventory, issue-invoice, record-payment, issue-credit-note.

Statuswijziging: `{id, status, version}`. Werkorder uit offerte: `{quoteId, schedule}`. Herplannen: `{id, schedule, version}`. Overige payloads volgen `README.md` en worden door de service strikt gevalideerd. De API retourneert `{data}` bij succes en `{error, requestId}` bij fouten. Interne SQL-/bestandspaden en foutdetails gaan niet naar de client.

## UI-stromen die de kernbouwer moet aansluiten

1. Klantenlijst en klantformulier → offerteformulier → concept/verstuurd/geaccepteerd.
2. Geaccepteerde offerte → resource/tijdvak → werkorder → geplande/actieve/afgeronde uitvoering.
3. Productvoorraad → reserveren voor werkorder → verbruik; ongeldige aantallen en onvoldoende voorraad tonen als conflict.
4. Toegewezen medewerker → uren; toon status- en toegangsconflicten zonder oude gegevens stilzwijgend te overschrijven.
5. Finance → factuur uit bron → openstaand bedrag → deelbetaling → eventuele creditnota → lokale boekhoudexport/outbox.

Geen van deze UI-stromen is door alleen de module geïmplementeerd. De lokale Node-host heeft inmiddels formulieren voor deze hoofdprocessen, maar is niet aangesloten op de bestaande Site en er is nog geen browseracceptatie op de uiteindelijke app uitgevoerd.

## Boekhouding en externe providers

De outbox is lokale bewijsbare voorbereiding. Ze verzendt geen facturen of klantgegevens. Een provideradapter moet credentials buiten git lezen, externe identifiers veilig opslaan, ontvangst en retries verwerken en idempotentie op beide kanten bewaken. Het toevoegen van een betaalrecord registreert een bevestigde betaling; het incasseert geen geld en bewijst geen PSP-webhookverificatie.

Een lokaal uitgereikte factuur is nog geen gevalideerde wettelijke factuurlayout. Bedrijfsidentiteit, adresgegevens, btw-behandeling en documentlayout moeten door de app worden aangevuld en getest voordat daadwerkelijk klantfacturen worden uitgegeven. Geen hardgecodeerde CAI-persoonlijke configuratie gebruiken in de generieke module.

## Samenwerking en acceptatie

Coördinatie, commits en teststatus staan in `docs/WORK-COORDINATION.md`; de kernbouwer moet de integratie expliciet bevestigen. Module-, app- en deploymentacceptatie blijven afzonderlijke staten.
