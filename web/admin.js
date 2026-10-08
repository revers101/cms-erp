// SPDX-License-Identifier: GPL-3.0-or-later
const byId = (id) => document.getElementById(id);
const contentForm = byId('content-form');
const pageSize = 50;
const referenceData = new Map();
const memoryIntentKeys = new Map();
const sensitiveIntentKeys = new Map();
let session;
let entityOffset = 0;
let entityHasNext = false;
let technicianChoices = [];

async function request(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  let payload = {};
  try { payload = await response.json(); } catch { /* show a generic response below */ }
  if (!response.ok) {
    if (response.status === 401) location.assign('/login');
    const error = new Error(payload.error ?? `HTTP_${response.status}`);
    error.status = response.status;
    error.requestId = payload.requestId ?? response.headers.get('x-request-id') ?? '';
    throw error;
  }
  return payload.data;
}

function fields(form) { return Object.fromEntries(new FormData(form)); }
function message(target, text, error = false) {
  target.textContent = text;
  target.classList.toggle('error', error);
}
function idempotencyKey() { return crypto.randomUUID(); }
function postHeaders(key = idempotencyKey()) {
  return {
    'Content-Type': 'application/json',
    'X-CSRF-Token': session.csrfToken,
    'Idempotency-Key': key,
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function postIntent(path, payload, { sensitive = false, scope = '', method = 'POST' } = {}) {
  const canonical = canonicalJson(payload);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const fingerprint = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (sensitive) {
    const storageKey = `cms-erp:sensitive-intent:${session.actor.id}:${scope}`;
    const prior = sensitiveIntentKeys.get(storageKey);
    const key = prior?.fingerprint === fingerprint ? prior.key : idempotencyKey();
    sensitiveIntentKeys.set(storageKey, { fingerprint, key });
    const clear = () => {
      if (sensitiveIntentKeys.get(storageKey)?.key === key) sensitiveIntentKeys.delete(storageKey);
    };
    try {
      const result = await request(path, {
        method, headers: postHeaders(key), body: JSON.stringify(payload),
      });
      clear();
      return result;
    } catch (error) {
      if (error.status >= 400 && error.status < 500) clear();
      throw error;
    }
  }
  const storageKey = `cms-erp:intent:${session.actor.id}:${path}:${fingerprint}`;
  let key;
  try {
    key = localStorage.getItem(storageKey);
    if (!key) { key = idempotencyKey(); localStorage.setItem(storageKey, key); }
  } catch {
    key = memoryIntentKeys.get(storageKey);
    if (!key) { key = idempotencyKey(); memoryIntentKeys.set(storageKey, key); }
  }
  const clear = () => {
    memoryIntentKeys.delete(storageKey);
    try { localStorage.removeItem(storageKey); } catch { /* continue with in-memory state */ }
  };
  try {
    const result = await request(path, {
      method, headers: postHeaders(key), body: JSON.stringify(payload),
    });
    clear();
    return result;
  } catch (error) {
    // Network failures and 5xx responses can have an uncertain outcome. Keep
    // the same key so an exact retry cannot duplicate a committed operation.
    if (error.status >= 400 && error.status < 500) clear();
    throw error;
  }
}

function errorText(prefix, error) {
  const conflict = error.status === 409
    ? ' Gegevens zijn intussen gewijzigd; ververs en controleer de actuele versie voordat je opnieuw handelt.'
    : '';
  const request = error.requestId ? ` (verzoek ${error.requestId})` : '';
  return `${prefix}: ${error.message}.${conflict}${request}`;
}

function setContentForm(item) {
  contentForm.reset();
  contentForm.elements.id.value = item?.id ?? '';
  contentForm.elements.version.value = item?.version ?? '';
  contentForm.elements.type.value = item?.type ?? 'page';
  contentForm.elements.title.value = item?.content?.title ?? '';
  contentForm.elements.slug.value = item?.content?.slug ?? '';
  contentForm.elements.summary.value = item?.content?.summary ?? '';
  contentForm.elements.seoTitle.value = item?.content?.seoTitle ?? '';
  contentForm.elements.seoDescription.value = item?.content?.seoDescription ?? '';
  contentForm.elements.body.value = item?.content?.blocks?.map((block) => block.text ?? block.items?.join('\n') ?? '').join('\n\n') ?? '';
  byId('content-form-title').textContent = item ? `Content bewerken · #${item.id}` : 'Concept maken';
  contentForm.querySelector('button[type="submit"]').textContent = item ? 'Wijzigingen opslaan' : 'Concept opslaan';
}

function contentPayload(data) {
  const title = data.title.trim();
  const summary = data.summary.trim();
  return {
    type: data.type,
    title,
    slug: data.slug.trim(),
    summary,
    blocks: data.body.split(/\n\s*\n/u).map((text) => text.trim()).filter(Boolean).map((text) => ({ type: 'paragraph', text })),
    seoTitle: data.seoTitle.trim() || title,
    seoDescription: data.seoDescription.trim() || summary,
  };
}

function contentRow(item) {
  const row = document.createElement('article');
  row.className = 'record-card';
  const details = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = item.content.title;
  const meta = document.createElement('p');
  const reviewLabels = { none: 'geen open review', pending: 'wacht op eigenaarreview', changes_requested: 'aanpassingen gevraagd' };
  meta.textContent = `${item.type} · /${item.slug} · ${item.status} · ${reviewLabels[item.reviewStatus] ?? 'reviewstatus onbekend'} · v${item.version}`;
  details.append(title, meta);
  const actions = document.createElement('div');
  actions.className = 'record-actions';
  if (['admin', 'editor'].includes(session.actor.role)) {
    const edit = document.createElement('button');
    edit.type = 'button'; edit.className = 'button-secondary'; edit.textContent = 'Bewerken';
    edit.addEventListener('click', () => { setContentForm(item); contentForm.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    actions.append(edit);
  }
  if (['admin', 'editor'].includes(session.actor.role) && item.status !== 'archived' &&
      item.reviewStatus !== 'pending' && (item.status !== 'published' || item.hasUnpublishedChanges)) {
    const submit = document.createElement('button');
    submit.type = 'button'; submit.className = 'button-secondary'; submit.textContent = 'Ter beoordeling aanbieden';
    submit.addEventListener('click', () => contentAction('submit-review', item));
    actions.append(submit);
  }
  if (['admin', 'publisher'].includes(session.actor.role) && item.reviewStatus === 'pending') {
    const publish = document.createElement('button');
    publish.type = 'button'; publish.textContent = 'Goedkeuren en publiceren';
    publish.addEventListener('click', () => contentAction('publish', item));
    const returnButton = document.createElement('button');
    returnButton.type = 'button'; returnButton.className = 'button-danger'; returnButton.textContent = 'Terug voor aanpassing';
    returnButton.addEventListener('click', () => contentAction('return-for-changes', item));
    actions.append(publish, returnButton);
  }
  if (['admin', 'publisher'].includes(session.actor.role) && item.status !== 'archived') {
    const archive = document.createElement('button');
    archive.type = 'button'; archive.className = 'button-danger'; archive.textContent = 'Archiveren';
    archive.addEventListener('click', () => contentAction('archive', item));
    actions.append(archive);
  }
  row.append(details, actions);
  return row;
}

async function loadContent() {
  const list = byId('content-list');
  list.replaceChildren(document.createTextNode('Laden…'));
  const items = await request('/api/content/items?limit=100&offset=0');
  list.replaceChildren();
  if (!items.length) { list.textContent = 'Nog geen content. Maak hierboven een concept.'; return; }
  for (const item of items) list.append(contentRow(item));
}

async function contentAction(action, item) {
  const target = byId('content-message');
  try {
    await postIntent(`/api/content/commands/${action}`, { id: item.id, version: item.version });
    const messages = {
      publish: 'Content goedgekeurd en gepubliceerd.',
      archive: 'Content gearchiveerd.',
      'submit-review': 'Content aangeboden voor eigenaarreview.',
      'return-for-changes': 'Content teruggestuurd voor aanpassing.',
    };
    message(target, messages[action] ?? 'Content bijgewerkt.');
    await loadContent();
  } catch (error) { message(target, errorText('Actie niet uitgevoerd', error), true); }
}

contentForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const target = byId('content-message');
  try {
    const data = fields(contentForm);
    const content = contentPayload(data);
    if (!content.blocks.length) throw new Error('Voeg minimaal één alinea toe.');
    const editing = Boolean(data.id);
    await postIntent(`/api/content/commands/${editing ? 'update' : 'create'}`,
      editing ? { id: Number(data.id), version: Number(data.version), content } : { content });
    setContentForm();
    message(target, editing ? 'Wijzigingen opgeslagen.' : 'Concept opgeslagen.');
    await loadContent();
  } catch (error) { message(target, errorText('Niet opgeslagen', error), true); }
});

byId('new-content').addEventListener('click', () => setContentForm());
byId('refresh-content').addEventListener('click', () => loadContent().catch((error) => message(byId('content-message'), error.message, true)));

async function postCommand(command, payload) {
  return postIntent(`/api/operations/commands/${command}`, payload);
}

function moneyToCents(value, maxCents = 100000000) {
  const normalized = String(value).trim().replace(',', '.');
  if (!/^(0|[1-9]\d*)(?:\.\d{1,2})?$/u.test(normalized)) throw new Error('Gebruik een bedrag zoals 12,50.');
  const [whole, fraction = ''] = normalized.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > BigInt(maxCents)) throw new Error('Bedrag is te hoog.');
  return Number(cents);
}
function percentToBasisPoints(value) {
  const normalized = String(value).trim().replace(',', '.');
  if (!/^(?:100(?:\.0{1,2})?|(?:0|[1-9]\d?)(?:\.\d{1,2})?)$/u.test(normalized)) throw new Error('Gebruik een btw-percentage tussen 0 en 100.');
  const [whole, fraction = ''] = normalized.split('.');
  return Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')));
}
function decimalToMilli(value) {
  const normalized = String(value).trim().replace(',', '.');
  if (!/^(0|[1-9]\d*)(?:\.\d{1,3})?$/u.test(normalized)) throw new Error('Gebruik een aantal zoals 1 of 1,250.');
  const [whole, fraction = ''] = normalized.split('.');
  const amount = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  if (amount < 1n || amount > 1000000n) throw new Error('Aantal valt buiten het toegestane bereik.');
  return Number(amount);
}

function centsToInput(value) {
  const cents = Number(value);
  return Number.isSafeInteger(cents) ? `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}` : '';
}
function localDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function localDateTime(value) {
  if (!value) throw new Error('Vul begin- en eindtijd in.');
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error('De datum/tijd is ongeldig.');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
  return `${value}:00${sign}${hours}:${minutes}`;
}

async function bindCreateForm(form, build, refresh = []) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = form.querySelector('.message');
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await build(fields(form));
      form.reset();
      message(status, 'Opgeslagen.');
      if (refresh.length) await refreshReferences(refresh);
      await loadEntity();
    } catch (error) { message(status, errorText('Niet opgeslagen', error), true); }
    finally { submit.disabled = false; }
  });
}

bindCreateForm(byId('customer-form'), async (data) => {
  const payload = { name: data.name.trim(), type: data.type };
  if (data.email.trim()) payload.email = data.email.trim();
  await postCommand('create-customer', payload);
}, ['customers']);
bindCreateForm(byId('product-form'), async (data) => {
  await postCommand('create-product', {
    name: data.name.trim(), sku: data.sku.trim(), unitCents: moneyToCents(data.price),
    vatBasisPoints: percentToBasisPoints(data.vat), stock: Number(data.stock),
  });
}, ['products']);
bindCreateForm(byId('resource-form'), async (data) => {
  await postCommand('create-resource', { name: data.name.trim(), technicianId: Number(data.technicianId) });
}, ['resources']);
bindCreateForm(byId('quote-form'), async (data) => {
  const line = {
    description: data.description.trim(), unitCents: moneyToCents(data.price),
    quantityMilli: decimalToMilli(data.quantity), vatBasisPoints: percentToBasisPoints(data.vat),
  };
  if (data.productId) line.productId = Number(data.productId);
  await postCommand('create-quote', { customerId: Number(data.customerId), lines: [line] });
}, ['quotes']);
bindCreateForm(byId('workorder-form'), async (data) => {
  await postCommand('workorder-from-quote', { quoteId: Number(data.quoteId), schedule: {} });
}, ['workorders', 'quotes']);
bindCreateForm(byId('schedule-form'), async (data) => {
  const selected = (referenceData.get('workorders') ?? []).find((row) => String(row.id) === data.workorderId);
  if (!selected) throw new Error('Ververs de keuzelijst en kies een actuele werkorder.');
  await postCommand('schedule-workorder', {
    id: Number(data.workorderId),
    schedule: { resourceId: Number(data.resourceId), startAt: localDateTime(data.startAt), endAt: localDateTime(data.endAt) },
    version: selected.version,
  });
}, ['workorders']);
bindCreateForm(byId('hours-form'), async (data) => {
  await postCommand('record-hours', {
    workorderId: Number(data.workorderId), minutes: Number(data.minutes), date: data.date,
    ...(data.note.trim() ? { note: data.note.trim() } : {}),
  });
}, ['hours']);
bindCreateForm(byId('inventory-form'), async (data) => {
  await postCommand(data.action, {
    workorderId: Number(data.workorderId), productId: Number(data.productId), quantity: Number(data.quantity),
  });
}, ['products', 'workorders', 'reservations', 'movements']);
bindCreateForm(byId('stock-form'), async (data) => {
  await postCommand('adjust-stock', { productId: Number(data.productId), delta: Number(data.delta), reason: data.reason.trim() });
}, ['products', 'movements']);
bindCreateForm(byId('invoice-form'), async (data) => {
  const payload = { quoteId: Number(data.quoteId), dueDate: data.dueDate };
  const workorder = (referenceData.get('workorders') ?? []).find((row) => row.quoteId === payload.quoteId);
  if (workorder) payload.workorderId = workorder.id;
  await postCommand('issue-invoice', payload);
}, ['invoices', 'quotes']);
bindCreateForm(byId('payment-form'), async (data) => {
  await postCommand('record-payment', {
    invoiceId: Number(data.invoiceId), amountCents: moneyToCents(data.amount, 1000000000000), reference: data.reference.trim(),
  });
}, ['invoices', 'payments', 'outbox']);
bindCreateForm(byId('credit-form'), async (data) => {
  await postCommand('issue-credit-note', {
    invoiceId: Number(data.invoiceId), amountCents: moneyToCents(data.amount, 1000000000000), reason: data.reason.trim(),
  });
}, ['invoices', 'credits', 'outbox']);

const labels = {
  customers: 'Klanten', resources: 'Medewerkers', products: 'Producten en voorraad',
  quotes: 'Offertes', workorders: 'Werkorders', hours: 'Uren',
  reservations: 'Voorraadreserveringen', movements: 'Voorraadmutaties',
  invoices: 'Facturen', payments: 'Betalingen', credits: 'Creditnota’s',
  outbox: 'Boekhoud-outbox', audit: 'Auditlog',
};
const referenceEntities = ['customers', 'resources', 'products', 'quotes', 'workorders', 'invoices'];
function money(cents) {
  const value = Number(cents);
  if (!Number.isSafeInteger(value)) return '—';
  return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(value / 100);
}
async function fetchReference(entity) {
  const rows = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const page = await request(`/api/operations/${entity}?limit=100&offset=${offset}`);
    rows.push(...page);
    if (page.length < 100) break;
  }
  return rows;
}
async function refreshReferences(entities = referenceEntities) {
  const status = byId('reference-status');
  status.textContent = 'Keuzelijsten vernieuwen…';
  const results = await Promise.all(entities.map(async (entity) => {
    try { referenceData.set(entity, await fetchReference(entity)); return null; }
    catch (error) { referenceData.set(entity, []); return `${labels[entity]}: ${error.message}`; }
  }));
  let technicianError = null;
  if (entities.includes('resources') && ['admin', 'planner'].includes(session.actor.role)) {
    try { technicianChoices = await request('/api/technicians'); }
    catch (error) { technicianChoices = []; technicianError = `Monteurs: ${error.message}`; }
  }
  updateSelects();
  const failed = results.filter(Boolean);
  if (technicianError) failed.push(technicianError);
  status.textContent = failed.length
    ? `Niet alle keuzelijsten konden worden geladen. ${failed.join(' · ')}`
    : 'Keuzelijsten bijgewerkt; per soort zijn maximaal 500 records geladen.';
}
function fillSelect(select, rows, labelFor, placeholder, predicate = () => true) {
  if (!select) return;
  const selected = select.value;
  const options = [new Option(placeholder, '')];
  for (const row of rows.filter(predicate)) options.push(new Option(labelFor(row), String(row.id)));
  select.replaceChildren(...options);
  if (options.some((option) => option.value === selected)) select.value = selected;
}
function updateSelects() {
  const customers = referenceData.get('customers') ?? [];
  const products = referenceData.get('products') ?? [];
  const quotes = referenceData.get('quotes') ?? [];
  const workorders = referenceData.get('workorders') ?? [];
  const resources = referenceData.get('resources') ?? [];
  const invoices = referenceData.get('invoices') ?? [];
  const createdQuoteIds = new Set(workorders.map((row) => row.quoteId));
  const invoicedQuoteIds = new Set(invoices.map((row) => row.quoteId));
  fillSelect(byId('quote-form')?.elements.customerId, customers,
    (row) => `#${row.id} · ${row.name} · ${row.type === 'b2b' ? 'zakelijk' : 'particulier'}`, 'Klant kiezen…');
  fillSelect(byId('quote-form')?.elements.productId, products,
    (row) => `#${row.id} · ${row.name} · ${row.sku} · voorraad ${row.stock} (gereserveerd ${row.reserved})`, 'Geen productkoppeling');
  fillSelect(byId('workorder-form')?.elements.quoteId,
    quotes.filter((row) => row.status === 'accepted' && !createdQuoteIds.has(row.id)),
    (row) => `#${row.id} · klant #${row.customerId} · ${money(row.totalCents)}`, 'Geaccepteerde offerte kiezen…');
  const schedulable = workorders.filter((row) => ['planned', 'active'].includes(row.status));
  fillSelect(byId('schedule-form')?.elements.workorderId, schedulable,
    (row) => `#${row.id} · klant #${row.customerId} · v${row.version} · ${row.status}`, 'Werkorder kiezen…');
  fillSelect(byId('hours-form')?.elements.workorderId, workorders.filter((row) => row.status === 'active'),
    (row) => `#${row.id} · klant #${row.customerId} · actief`, 'Actieve werkorder kiezen…');
  fillSelect(byId('inventory-form')?.elements.workorderId, schedulable,
    (row) => `#${row.id} · klant #${row.customerId} · ${row.status}`, 'Werkorder kiezen…');
  fillSelect(byId('schedule-form')?.elements.resourceId, resources,
    (row) => `#${row.id} · ${row.name} · monteur #${row.technicianId}`, 'Medewerker kiezen…');
  const assignedTechnicians = new Set(resources.map((row) => Number(row.technicianId)));
  fillSelect(byId('resource-form')?.elements.technicianId, technicianChoices,
    (row) => `#${row.id} · ${row.email}`, 'Monteur kiezen…',
    (row) => !assignedTechnicians.has(Number(row.id)));
  fillSelect(byId('inventory-form')?.elements.productId, products,
    (row) => `#${row.id} · ${row.name} · ${row.sku} · beschikbaar ${row.stock - row.reserved}`, 'Product kiezen…');
  fillSelect(byId('stock-form')?.elements.productId, products,
    (row) => `#${row.id} · ${row.name} · ${row.sku} · voorraad ${row.stock}`, 'Product kiezen…');
  const billableQuotes = quotes.filter((row) => {
    if (row.status !== 'accepted' || invoicedQuoteIds.has(row.id)) return false;
    const linked = workorders.find((workorder) => workorder.quoteId === row.id);
    return !linked || linked.status === 'done';
  });
  fillSelect(byId('invoice-form')?.elements.quoteId, billableQuotes,
    (row) => `#${row.id} · klant #${row.customerId} · ${money(row.totalCents)}`, 'Offerte kiezen…');
  const openInvoices = invoices.filter((row) => row.balanceCents > 0);
  for (const formId of ['payment-form', 'credit-form']) {
    fillSelect(byId(formId)?.elements.invoiceId, openInvoices,
      (row) => `${row.number} · openstaand ${money(row.balanceCents)}`, 'Factuur kiezen…');
  }
  const action = byId('inventory-form')?.elements.action;
  if (action) {
    for (const option of action.options) option.hidden = session.actor.role === 'technician' && option.value !== 'consume-inventory';
    if (session.actor.role === 'technician') action.value = 'consume-inventory';
  }
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'lokale tijdzone';
  document.querySelectorAll('[data-timezone]').forEach((node) => { node.textContent = `Tijden worden geïnterpreteerd in ${timezone}.`; });
}
async function loadEntity() {
  const entity = byId('entity-select').value;
  byId('entity-heading').textContent = labels[entity] ?? entity;
  const list = byId('entity-list');
  const status = byId('entity-message');
  list.replaceChildren(document.createTextNode('Laden…'));
  try {
    const rows = await request(`/api/operations/${entity}?limit=${pageSize}&offset=${entityOffset}`);
    list.replaceChildren();
    entityHasNext = rows.length === pageSize;
    byId('entity-prev').disabled = entityOffset === 0;
    byId('entity-next').disabled = !entityHasNext;
    byId('entity-page').textContent = `Pagina ${Math.floor(entityOffset / pageSize) + 1}`;
    if (!rows.length) { list.textContent = entityOffset ? 'Geen verdere gegevens.' : 'Nog geen gegevens.'; return; }
    for (const value of rows) list.append(entityRow(entity, value));
    message(status, '');
  } catch (error) {
    list.replaceChildren();
    message(status, errorText('Gegevens laden mislukt', error), true);
    byId('entity-prev').disabled = entityOffset === 0;
    byId('entity-next').disabled = true;
  }
}
function entitySummary(entity, value) {
  const id = value.id ?? `werkorder ${value.workorderId} · product ${value.productId}`;
  if (entity === 'customers') return `#${id} · ${value.name} · ${value.type}`;
  if (entity === 'resources') return `#${id} · ${value.name} · monteur #${value.technicianId}`;
  if (entity === 'products') return `#${id} · ${value.name} · ${value.sku} · voorraad ${value.stock}, gereserveerd ${value.reserved}`;
  if (entity === 'quotes') return `#${id} · klant #${value.customerId} · ${value.status} · ${money(value.totalCents)}`;
  if (entity === 'workorders') return `#${id} · klant #${value.customerId} · ${value.status} · v${value.version}`;
  if (entity === 'invoices') return `${value.number} · klant #${value.customerId} · openstaand ${money(value.balanceCents)}`;
  if (entity === 'payments') return `#${id} · factuur #${value.invoiceId} · ${money(value.amountCents)}`;
  if (entity === 'credits') return `${value.number} · factuur #${value.invoiceId} · ${money(value.amountCents)}`;
  return `#${id} · ${value.name ?? value.number ?? value.status ?? value.sku ?? value.operation ?? value.eventType ?? 'record'}`;
}
function entityRow(entity, value) {
  const item = document.createElement('details');
  item.className = 'record-card data-row';
  const summary = document.createElement('summary');
  summary.textContent = entitySummary(entity, value);
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(value, null, 2);
  item.append(summary, pre);
  const actions = document.createElement('div');
  actions.className = 'record-actions';
  const role = session.actor.role;
  if (entity === 'quotes' && ['admin', 'planner'].includes(role)) {
    if (value.status === 'draft') addAction(actions, 'Verstuur offerte', () => runEntityCommand('quote-status', { id: value.id, status: 'sent', version: value.version }));
    if (value.status === 'sent') {
      addAction(actions, 'Accepteer', () => runEntityCommand('quote-status', { id: value.id, status: 'accepted', version: value.version }));
      addAction(actions, 'Wijs af', () => runEntityCommand('quote-status', { id: value.id, status: 'rejected', version: value.version }), 'button-danger');
    }
    const hasWorkorder = (referenceData.get('workorders') ?? []).some((row) => row.quoteId === value.id);
    if (value.status === 'accepted' && !hasWorkorder) addAction(actions, 'Werkorder maken', () => runEntityCommand('workorder-from-quote', { quoteId: value.id, schedule: {} }));
  }
  if (entity === 'workorders') {
    if (['admin', 'planner'].includes(role) && ['planned', 'active'].includes(value.status)) {
      addAction(actions, 'Planning openen', () => {
        byId('schedule-form').elements.workorderId.value = String(value.id);
        byId('erp-workflows').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 'button-secondary');
    }
    if (['admin', 'planner', 'technician'].includes(role) && value.status === 'active') {
      addAction(actions, 'Uren registreren', () => {
        byId('hours-form').elements.workorderId.value = String(value.id);
        byId('erp-workflows').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 'button-secondary');
    }
    if (['admin', 'planner', 'technician'].includes(role) && ['planned', 'active'].includes(value.status)) {
      addAction(actions, 'Voorraadactie', () => {
        byId('inventory-form').elements.workorderId.value = String(value.id);
        byId('erp-workflows').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 'button-secondary');
    }
    if (['admin', 'planner', 'technician'].includes(role)) {
      const next = value.status === 'planned' ? ['active', 'cancelled'] : value.status === 'active' ? ['done', 'cancelled'] : [];
      for (const status of next) addAction(actions, status === 'active' ? 'Start' : status === 'done' ? 'Afronden' : 'Annuleren',
        () => runEntityCommand('workorder-status', { id: value.id, status, version: value.version }),
        status === 'cancelled' ? 'button-danger' : '');
    }
  }
  if (actions.childElementCount) item.append(actions);
  return item;
}

function addAction(container, label, action, className = '') {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
  if (className) button.className = className;
  button.addEventListener('click', action); container.append(button);
}
async function runEntityCommand(command, payload) {
  const target = byId('entity-message');
  try {
    await postCommand(command, payload);
    message(target, 'Actie opgeslagen.');
    const changed = command === 'workorder-from-quote' ? ['workorders', 'quotes']
      : command === 'quote-status' ? ['quotes']
        : ['workorders'];
    await refreshReferences(changed);
    await loadEntity();
  } catch (error) { message(target, errorText('Actie niet uitgevoerd', error), true); }
}
byId('entity-select').addEventListener('change', () => { entityOffset = 0; loadEntity(); });
byId('refresh-entity').addEventListener('click', () => loadEntity());
byId('entity-prev').addEventListener('click', () => { entityOffset = Math.max(0, entityOffset - pageSize); loadEntity(); });
byId('entity-next').addEventListener('click', () => { if (entityHasNext) { entityOffset += pageSize; loadEntity(); } });
byId('refresh-references').addEventListener('click', () => refreshReferences().catch((error) => {
  message(byId('reference-status'), errorText('Keuzelijsten vernieuwen mislukt', error), true);
}));
byId('quote-form').elements.productId.addEventListener('change', (event) => {
  const product = (referenceData.get('products') ?? []).find((row) => String(row.id) === event.target.value);
  if (!product) return;
  const form = byId('quote-form');
  form.elements.description.value = product.name;
  form.elements.price.value = centsToInput(product.unitCents);
  form.elements.vat.value = String(product.vatBasisPoints / 100).replace('.', ',');
});
byId('inventory-form').elements.action.addEventListener('change', (event) => {
  const button = byId('inventory-form').querySelector('button[type="submit"]');
  button.textContent = event.target.value === 'reserve-inventory' ? 'Voorraad reserveren'
    : event.target.value === 'consume-inventory' ? 'Verbruik vastleggen' : 'Reservering vrijgeven';
});

async function downloadBookkeeping() {
  const button = byId('export-bookkeeping');
  const status = byId('entity-message');
  button.disabled = true;
  try {
    const entries = [];
    let generatedAt = null;
    for (let offset = 0; offset <= 1000000; offset += 100) {
      if (offset / 100 >= 100) throw new Error('De export is groter dan 10.000 regels; gebruik de boekhoud-outbox per pagina.');
      const page = await request(`/api/operations/bookkeeping?limit=100&offset=${offset}`);
      generatedAt = page.generatedAt;
      entries.push(...page.entries);
      if (page.entries.length < 100) break;
    }
    const blob = new Blob([JSON.stringify({ generatedAt, entries }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `boekhoud-outbox-${localDate(new Date())}.json`;
    document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    message(status, `${entries.length} boekhoudregels gedownload.`);
  } catch (error) { message(status, errorText('Export mislukt', error), true); }
  finally { button.disabled = false; }
}
byId('export-bookkeeping').addEventListener('click', downloadBookkeeping);

function applyRoleVisibility() {
  const role = session.actor.role;
  const canUseOperations = ['admin', 'planner', 'technician', 'finance', 'reader'].includes(role);
  document.querySelectorAll('[data-roles]').forEach((element) => {
    element.hidden = !element.dataset.roles.split(',').includes(role);
  });
  byId('content').hidden = !['admin', 'editor', 'publisher'].includes(role);
  if (!['admin', 'editor'].includes(role)) {
    contentForm.hidden = true;
    byId('new-content').hidden = true;
  }
  byId('operations').hidden = !canUseOperations;
  byId('erp-workflows').hidden = !canUseOperations;
  const allowed = {
    admin: Object.keys(labels),
    planner: ['customers', 'resources', 'products', 'quotes', 'workorders', 'hours', 'reservations', 'movements'],
    technician: ['products', 'workorders', 'hours', 'reservations', 'movements'],
    finance: ['customers', 'quotes', 'workorders', 'invoices', 'payments', 'credits', 'outbox'],
    reader: ['customers', 'resources', 'products', 'quotes', 'workorders', 'hours', 'reservations', 'movements'],
  }[role] ?? [];
  for (const option of byId('entity-select').options) option.hidden = !allowed.includes(option.value);
  const first = [...byId('entity-select').options].find((option) => !option.hidden);
  if (first) byId('entity-select').value = first.value;
}

async function start() {
  try {
    session = await request('/api/auth/session');
    byId('welcome').textContent = `Ingelogd als ${session.actor.email} · rol ${session.actor.role}`;
    createPasswordPanel();
    applyRoleVisibility();
    if (session.actor.role === 'admin') createUserPanel();
    const today = localDate(new Date());
    byId('hours-form').elements.date.value = today;
    const due = new Date(); due.setDate(due.getDate() + 30);
    byId('invoice-form').elements.dueDate.value = localDate(due);
    await Promise.all([
      byId('erp-workflows').hidden ? Promise.resolve() : refreshReferences(),
      byId('content').hidden ? Promise.resolve() : loadContent(),
      byId('operations').hidden ? Promise.resolve() : loadEntity(),
    ]);
  } catch (error) {
    if (error.message !== 'AUTH_REQUIRED') byId('welcome').textContent = `Laden mislukt: ${error.message}`;
  }
}

function createPasswordPanel() {
  const section = document.createElement('section');
  section.id = 'security'; section.className = 'panel';
  const heading = document.createElement('div'); heading.className = 'section-heading';
  const title = document.createElement('div');
  const eyebrow = document.createElement('p'); eyebrow.className = 'eyebrow'; eyebrow.textContent = 'Accountbeveiliging';
  const h2 = document.createElement('h2'); h2.textContent = 'Wachtwoord wijzigen';
  title.append(eyebrow, h2); heading.append(title); section.append(heading);
  const note = document.createElement('p'); note.className = 'muted';
  note.textContent = 'Gebruik een uniek wachtwoord van minimaal 14 tekens. Na de wijziging worden andere sessies afgemeld.';
  const form = document.createElement('form'); form.className = 'form-grid';
  const addPassword = (name, labelText, autocomplete) => {
    const label = document.createElement('label'); label.append(document.createTextNode(labelText));
    const input = document.createElement('input'); input.type = 'password'; input.name = name;
    input.autocomplete = autocomplete; input.minLength = name === 'currentPassword' ? 1 : 14;
    input.maxLength = 1024; input.required = true; label.append(input); form.append(label);
  };
  addPassword('currentPassword', 'Huidig wachtwoord', 'current-password');
  addPassword('newPassword', 'Nieuw wachtwoord', 'new-password');
  addPassword('confirmPassword', 'Nieuw wachtwoord herhalen', 'new-password');
  const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = 'Wachtwoord opslaan';
  const feedback = document.createElement('p'); feedback.className = 'message'; feedback.setAttribute('role', 'status');
  form.append(submit, feedback);
  const mfaSection = document.createElement('div'); mfaSection.className = 'form-grid';
  const mfaHeading = document.createElement('h3'); mfaHeading.textContent = 'Tweestapsverificatie';
  const mfaStatus = document.createElement('p'); mfaStatus.className = 'muted'; mfaStatus.setAttribute('role', 'status');
  const mfaFeedback = document.createElement('p'); mfaFeedback.className = 'message'; mfaFeedback.setAttribute('role', 'status');
  const enrollmentForm = document.createElement('form'); enrollmentForm.className = 'form-grid';
  const enrollmentPasswordLabel = document.createElement('label'); enrollmentPasswordLabel.append(document.createTextNode('Huidig wachtwoord om MFA in te schakelen'));
  const enrollmentPassword = document.createElement('input'); enrollmentPassword.type = 'password'; enrollmentPassword.name = 'currentPassword'; enrollmentPassword.autocomplete = 'current-password'; enrollmentPassword.required = true; enrollmentPassword.maxLength = 1024;
  enrollmentPasswordLabel.append(enrollmentPassword);
  const enrollmentButton = document.createElement('button'); enrollmentButton.type = 'submit'; enrollmentButton.textContent = 'MFA instellen';
  enrollmentForm.append(enrollmentPasswordLabel, enrollmentButton);
  const setupDetails = document.createElement('div'); setupDetails.hidden = true;
  const secretLabel = document.createElement('p'); secretLabel.textContent = 'Voer deze sleutel handmatig in bij je authenticator-app:';
  const secretValue = document.createElement('code');
  const uriLabel = document.createElement('p'); uriLabel.textContent = 'Authenticator-URI:';
  const uriValue = document.createElement('code');
  setupDetails.append(secretLabel, secretValue, uriLabel, uriValue);
  const confirmForm = document.createElement('form'); confirmForm.className = 'form-grid'; confirmForm.hidden = true;
  const confirmLabel = document.createElement('label'); confirmLabel.append(document.createTextNode('Zescijferige verificatiecode'));
  const confirmCode = document.createElement('input'); confirmCode.name = 'code'; confirmCode.type = 'text'; confirmCode.inputMode = 'numeric'; confirmCode.autocomplete = 'one-time-code'; confirmCode.pattern = '[0-9]{6}'; confirmCode.maxLength = 6; confirmCode.required = true;
  confirmLabel.append(confirmCode);
  const confirmButton = document.createElement('button'); confirmButton.type = 'submit'; confirmButton.textContent = 'MFA bevestigen';
  confirmForm.append(confirmLabel, confirmButton);
  const recoveryPanel = document.createElement('div'); recoveryPanel.hidden = true;
  const recoveryNote = document.createElement('p'); recoveryNote.textContent = 'Bewaar deze herstelcodes nu op een veilige plek. Elke code is één keer te gebruiken.';
  const recoveryCodes = document.createElement('pre'); recoveryCodes.className = 'record-card';
  recoveryPanel.append(recoveryNote, recoveryCodes);
  const disableForm = document.createElement('form'); disableForm.className = 'form-grid'; disableForm.hidden = true;
  const disablePasswordLabel = document.createElement('label'); disablePasswordLabel.append(document.createTextNode('Huidig wachtwoord'));
  const disablePassword = document.createElement('input'); disablePassword.name = 'currentPassword'; disablePassword.type = 'password'; disablePassword.autocomplete = 'current-password'; disablePassword.maxLength = 1024; disablePassword.required = true;
  disablePasswordLabel.append(disablePassword);
  const disableCodeLabel = document.createElement('label'); disableCodeLabel.append(document.createTextNode('Authenticator- of herstelcode'));
  const disableCode = document.createElement('input'); disableCode.name = 'code'; disableCode.type = 'text'; disableCode.autocomplete = 'one-time-code'; disableCode.maxLength = 128; disableCode.required = true;
  disableCodeLabel.append(disableCode);
  const disableButton = document.createElement('button'); disableButton.type = 'submit'; disableButton.className = 'button-secondary'; disableButton.textContent = 'MFA uitschakelen';
  disableForm.append(disablePasswordLabel, disableCodeLabel, disableButton);
  mfaSection.append(mfaHeading, mfaStatus, mfaFeedback, enrollmentForm, setupDetails, confirmForm, recoveryPanel, disableForm);
  section.append(note, form, mfaSection); byId('content').before(section);
  const navLink = document.createElement('a'); navLink.href = '#security'; navLink.textContent = 'Beveiliging';
  document.querySelector('.topbar nav').append(navLink);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = fields(form);
    if (values.newPassword !== values.confirmPassword) {
      message(feedback, 'De nieuwe wachtwoorden komen niet overeen.', true); return;
    }
    try {
      session = await request('/api/auth/password', {
        method: 'POST', headers: postHeaders(),
        body: JSON.stringify({ currentPassword: values.currentPassword, newPassword: values.newPassword }),
      });
      form.reset();
      message(feedback, 'Wachtwoord bijgewerkt. Andere sessies zijn afgemeld.');
    } catch (error) { message(feedback, `Niet bijgewerkt: ${error.message}`, true); }
  });
  async function refreshMfaStatus() {
    try {
      const state = await request('/api/auth/mfa');
      mfaStatus.textContent = state.enabled ? 'MFA is ingeschakeld. Inloggen vereist je authenticator- of herstelcode.' : 'MFA is uitgeschakeld.';
      enrollmentForm.hidden = state.enabled || !state.encryptionConfigured;
      disableForm.hidden = !state.enabled;
      if (!state.enabled && state.encryptionConfigured) enrollmentButton.disabled = false;
      if (!state.encryptionConfigured) mfaFeedback.textContent = 'MFA is nog niet beschikbaar. De beheerder moet CMS_ERP_MFA_ENCRYPTION_KEY privé configureren.';
    } catch (error) { message(mfaStatus, `MFA-status niet geladen: ${error.message}`, true); }
  }
  enrollmentForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    enrollmentButton.disabled = true;
    try {
      const pending = await request('/api/auth/mfa/enroll', {
        method: 'POST', headers: postHeaders(), body: JSON.stringify({ currentPassword: enrollmentPassword.value }),
      });
      secretValue.textContent = pending.secret;
      uriValue.textContent = pending.otpauthUrl;
      confirmCode.value = '';
      confirmButton.disabled = false;
      recoveryPanel.hidden = true;
      setupDetails.hidden = false; confirmForm.hidden = false;
      enrollmentForm.hidden = true; enrollmentPassword.value = '';
      message(mfaFeedback, 'Sleutel aangemaakt. Bevestig de instelling met de actuele code uit je authenticator-app.');
    } catch (error) {
      message(mfaFeedback, `MFA instellen mislukt: ${error.message}`, true);
      enrollmentButton.disabled = false;
    }
  });
  confirmForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    confirmButton.disabled = true;
    try {
      const result = await request('/api/auth/mfa/confirm', {
        method: 'POST', headers: postHeaders(), body: JSON.stringify({ code: confirmCode.value }),
      });
      recoveryCodes.textContent = result.recoveryCodes.join('\n');
      recoveryPanel.hidden = false; confirmForm.hidden = true; setupDetails.hidden = true;
      message(mfaFeedback, 'MFA is ingeschakeld. De herstelcodes worden alleen nu getoond.');
      await refreshMfaStatus();
    } catch (error) {
      message(mfaFeedback, `MFA bevestigen mislukt: ${error.message}`, true);
      confirmButton.disabled = false;
    }
  });
  disableForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    disableButton.disabled = true;
    try {
      await request('/api/auth/mfa/disable', {
        method: 'POST', headers: postHeaders(),
        body: JSON.stringify({ currentPassword: disablePassword.value, code: disableCode.value }),
      });
      disableForm.reset(); recoveryPanel.hidden = true;
      message(mfaFeedback, 'MFA uitgeschakeld; andere sessies zijn afgemeld.');
      await refreshMfaStatus();
    } catch (error) {
      message(mfaFeedback, `MFA uitschakelen mislukt: ${error.message}`, true);
    } finally { disableButton.disabled = false; }
  });
  void refreshMfaStatus();
}

function createUserPanel() {
  const section = document.createElement('section');
  section.id = 'users'; section.className = 'panel';
  const heading = document.createElement('div'); heading.className = 'section-heading';
  const title = document.createElement('div');
  const eyebrow = document.createElement('p'); eyebrow.className = 'eyebrow'; eyebrow.textContent = 'Toegang';
  const h2 = document.createElement('h2'); h2.textContent = 'Gebruikers';
  title.append(eyebrow, h2); heading.append(title);
  const note = document.createElement('p'); note.className = 'muted';
  note.textContent = 'Alleen admins kunnen gebruikers uitnodigen. De ontvanger stelt zelf een uniek wachtwoord in via een eenmalige link die zeven dagen geldig is. Uitnodigingen versturen vereist Resend-configuratie.';
  if (session.auth0McpEnabled) note.textContent += ' Auth0-koppelingen gebruiken een eenmalige code die na tien minuten verloopt.';
  const grid = document.createElement('div'); grid.className = 'content-grid';
  const form = document.createElement('form'); form.id = 'user-form'; form.className = 'form-grid';
  const formTitle = document.createElement('h3'); formTitle.textContent = 'Gebruiker uitnodigen'; form.append(formTitle);
  const addField = (labelText, name, type, options) => {
    const label = document.createElement('label'); label.append(document.createTextNode(labelText));
    const control = document.createElement(options ? 'select' : 'input');
    control.name = name; control.required = true;
    if (options) for (const [value, text] of options) { const option = document.createElement('option'); option.value = value; option.textContent = text; control.append(option); }
    else { control.type = type; control.maxLength = 254; }
    label.append(control); form.append(label);
  };
  addField('E-mailadres', 'email', 'email');
  addField('Rol', 'role', null, [['editor','CMS-editor'],['publisher','CMS-uitgever'],['planner','ERP-planner'],['technician','ERP-monteur'],['finance','ERP-financiën'],['reader','Alleen lezen'],['admin','Admin']]);
  const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = 'Uitnodiging versturen'; form.append(submit);
  const feedback = document.createElement('p'); feedback.id = 'user-message'; feedback.className = 'message'; feedback.setAttribute('role', 'status'); form.append(feedback);
  const listColumn = document.createElement('div');
  const toolbar = document.createElement('div'); toolbar.className = 'list-toolbar';
  const listTitle = document.createElement('h3'); listTitle.textContent = 'Accounts';
  const refresh = document.createElement('button'); refresh.type = 'button'; refresh.className = 'button-secondary'; refresh.textContent = 'Verversen';
  const list = document.createElement('div'); list.id = 'user-list'; list.className = 'record-list'; list.setAttribute('aria-live', 'polite');
  const invitationTitle = document.createElement('h3'); invitationTitle.textContent = 'Openstaande uitnodigingen';
  const invitationList = document.createElement('div'); invitationList.id = 'invitation-list'; invitationList.className = 'record-list'; invitationList.setAttribute('aria-live', 'polite');
  toolbar.append(listTitle, refresh); listColumn.append(toolbar, list, invitationTitle, invitationList); grid.append(form, listColumn); section.append(heading, note, grid);
  byId('operations').after(section);
  const navLink = document.createElement('a'); navLink.href = '#users'; navLink.textContent = 'Gebruikers'; document.querySelector('.topbar nav').append(navLink);
  async function loadUsers() {
    list.replaceChildren(document.createTextNode('Laden…'));
    const users = await request('/api/users');
    list.replaceChildren();
    for (const user of users) {
      const row = document.createElement('article'); row.className = 'record-card';
      const text = document.createElement('div');
      const email = document.createElement('strong'); email.textContent = user.email;
      const role = document.createElement('p'); role.textContent = `${user.role} · ${user.active ? 'actief' : 'uitgeschakeld'} · Auth0 ${user.auth0Linked ? 'gekoppeld' : 'niet gekoppeld'}`;
      text.append(email, role); row.append(text);
      const actions = document.createElement('div'); actions.className = 'record-actions';
      const roleSelect = document.createElement('select');
      roleSelect.setAttribute('aria-label', `Rol voor ${user.email}`);
      const roleOptions = [['editor','CMS-editor'],['publisher','CMS-uitgever'],['planner','ERP-planner'],['technician','ERP-monteur'],['finance','ERP-financiën'],['reader','Alleen lezen'],['admin','Admin']];
      for (const [value, label] of roleOptions) {
        const option = document.createElement('option'); option.value = value; option.textContent = label;
        option.selected = value === user.role; roleSelect.append(option);
      }
      const saveRole = document.createElement('button'); saveRole.type = 'button'; saveRole.className = 'button-secondary'; saveRole.textContent = 'Rol wijzigen';
      saveRole.disabled = user.id === session.actor.id;
      saveRole.addEventListener('click', async () => {
        saveRole.disabled = true;
        try {
          await postIntent(`/api/users/${user.id}`, { role: roleSelect.value }, { sensitive: true, scope: `users-update-${user.id}`, method: 'PATCH' });
          message(feedback, `Rol van ${user.email} bijgewerkt.`);
          await Promise.all([loadUsers(), refreshReferences(['resources'])]);
        } catch (error) {
          message(feedback, errorText('Rol niet bijgewerkt', error), true);
          saveRole.disabled = false;
        }
      });
      const toggleActive = document.createElement('button'); toggleActive.type = 'button'; toggleActive.className = 'button-secondary';
      toggleActive.textContent = user.active ? 'Account uitschakelen' : 'Account activeren';
      toggleActive.disabled = user.id === session.actor.id;
      toggleActive.addEventListener('click', async () => {
        toggleActive.disabled = true;
        try {
          await postIntent(`/api/users/${user.id}`, { active: !user.active }, { sensitive: true, scope: `users-update-${user.id}`, method: 'PATCH' });
          message(feedback, `Account van ${user.email} ${user.active ? 'uitgeschakeld' : 'geactiveerd'}.`);
          await Promise.all([loadUsers(), refreshReferences(['resources'])]);
        } catch (error) {
          message(feedback, errorText('Accountstatus niet bijgewerkt', error), true);
          toggleActive.disabled = false;
        }
      });
      actions.append(roleSelect, saveRole, toggleActive); row.append(actions);
      if (session.auth0McpEnabled && user.active && !user.auth0Linked) {
        const actions = document.createElement('div'); actions.className = 'record-actions';
        const link = document.createElement('button'); link.type = 'button'; link.className = 'button-secondary'; link.textContent = 'Auth0-koppeling starten';
        const outcome = document.createElement('p'); outcome.className = 'muted'; outcome.setAttribute('role', 'status');
        link.addEventListener('click', async () => {
          link.disabled = true;
          outcome.textContent = 'Tijdelijke koppelcode wordt aangemaakt…';
          const code = crypto.randomUUID() + crypto.randomUUID();
          try {
            await request(`/api/users/${user.id}/auth0-link`, {
              method: 'POST', headers: postHeaders(idempotencyKey()), body: JSON.stringify({ code }),
            });
            outcome.textContent = `Laat de gebruiker in ChatGPT de MCP-tool complete_account_link met deze eenmalige code gebruiken binnen tien minuten: ${code}`;
            link.textContent = 'Nieuwe code maken';
          } catch (error) {
            outcome.textContent = `Koppeling niet gestart: ${error.message}`;
            link.disabled = false;
          }
        });
        actions.append(link, outcome); row.append(actions);
      }
      list.append(row);
    }
    if (!users.length) list.textContent = 'Geen accounts gevonden.';
  }
  async function loadInvitations() {
    invitationList.replaceChildren(document.createTextNode('Laden…'));
    const invitations = await request('/api/user-invitations');
    invitationList.replaceChildren();
    for (const invitation of invitations) {
      const row = document.createElement('article'); row.className = 'record-card';
      const details = document.createElement('div');
      const email = document.createElement('strong'); email.textContent = invitation.email;
      const expiration = document.createElement('p');
      expiration.textContent = `${invitation.role} · verloopt ${new Date(invitation.expiresAt).toLocaleString('nl-NL')}`;
      details.append(email, expiration);
      const actions = document.createElement('div'); actions.className = 'record-actions';
      const resend = document.createElement('button'); resend.type = 'button'; resend.className = 'button-secondary'; resend.textContent = 'Nieuwe link sturen';
      resend.addEventListener('click', async () => {
        resend.disabled = true;
        try {
          await postIntent('/api/user-invitations', { email: invitation.email, role: invitation.role }, { sensitive: true, scope: `user-invitation-${invitation.email}` });
          message(feedback, `Nieuwe uitnodigingslink verstuurd naar ${invitation.email}. De vorige link is daarna ongeldig.`);
          await loadInvitations();
        } catch (error) {
          message(feedback, errorText('Nieuwe uitnodigingslink niet verstuurd', error), true);
          resend.disabled = false;
        }
      });
      const revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'button-danger'; revoke.textContent = 'Intrekken';
      revoke.addEventListener('click', async () => {
        revoke.disabled = true;
        try {
          await postIntent(`/api/user-invitations/${invitation.id}`, {}, { sensitive: true, scope: `user-invitation-revoke-${invitation.id}`, method: 'DELETE' });
          message(feedback, `Uitnodiging voor ${invitation.email} ingetrokken.`);
          await loadInvitations();
        } catch (error) {
          message(feedback, errorText('Uitnodiging niet ingetrokken', error), true);
          revoke.disabled = false;
        }
      });
      actions.append(resend, revoke);
      row.append(details, actions); invitationList.append(row);
    }
    if (!invitations.length) invitationList.textContent = 'Geen openstaande uitnodigingen.';
  }
  refresh.addEventListener('click', () => loadUsers().catch((error) => message(feedback, errorText('Laden mislukt', error), true)));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const values = fields(form);
      await postIntent('/api/user-invitations', values, { sensitive: true, scope: `user-invitation-${values.email.trim().toLowerCase()}` });
      form.reset(); message(feedback, `Uitnodiging verstuurd naar ${values.email}.`);
      await loadInvitations();
    } catch (error) { message(feedback, errorText('Uitnodiging niet verstuurd', error), true); }
  });
  loadUsers().catch((error) => { list.textContent = `Laden mislukt: ${error.message}`; });
  loadInvitations().catch((error) => { invitationList.textContent = `Laden mislukt: ${error.message}`; });
}

byId('logout-button').addEventListener('click', async () => {
  try {
    await fetch('/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': session.csrfToken } });
  } finally { location.assign('/login'); }
});
start();
