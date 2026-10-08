import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OperationsService } from './engine.mjs';

const admin = { id: 'acceptance-admin', role: 'admin' };
const planner = { id: 'acceptance-planner', role: 'planner' };
const finance = { id: 'acceptance-finance', role: 'finance' };
const technician = { id: 'acceptance-tech', role: 'technician' };
const stranger = { id: 'unassigned-tech', role: 'technician' };
const reader = { id: 'acceptance-reader', role: 'reader' };
const clock = () => '2026-10-09T10:00:00.000Z';

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cms-erp-operations-acceptance-'));
  const database = join(directory, 'synthetic.sqlite');
  let service = new OperationsService(database, { now: clock, ...options });
  t.after(() => { service.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    database,
    get service() { return service; },
    restart() { service.close(); service = new OperationsService(database, { now: clock, ...options }); return service; },
  };
}

function failure(code, action) {
  assert.throws(action, error => {
    assert.equal(error.code, code, error.message);
    assert.ok(Number.isInteger(error.status), 'domain errors must expose an HTTP status');
    return true;
  });
}

function seed(service, prefix = 'seed-case') {
  const customer = service.createCustomer(admin, { name: 'Synthetische klant', email: 'customer@example.test', type: 'b2b' }, `${prefix}-customer`);
  const product = service.createProduct(admin, { name: 'Koppeling', sku: `SKU-${prefix}`, unitCents: 2500, vatBasisPoints: 2100, stock: 8 }, `${prefix}-product`);
  const resource = service.list(admin, 'resources').find(item => item.technicianId === technician.id)
    ?? service.createResource(admin, { name: 'Monteur acceptatie', technicianId: technician.id }, `${prefix}-resource`);
  const quote = service.createQuote(planner, { customerId: customer.id, lines: [
    { description: 'Montage', unitCents: 6000, quantityMilli: 1500, vatBasisPoints: 2100 },
    { description: 'Koppeling', unitCents: 2500, quantityMilli: 2000, vatBasisPoints: 2100, productId: product.id },
  ] }, `${prefix}-quote`);
  return { customer, product, resource, quote };
}

function accept(service, quote, prefix = 'accept-case') {
  const sent = service.transitionQuote(planner, quote.id, 'sent', quote.version, `${prefix}-sent`);
  return service.transitionQuote(planner, quote.id, 'accepted', sent.version, `${prefix}-accepted`);
}

function complete(service, state, prefix = 'complete-case') {
  const quote = accept(service, state.quote, prefix);
  const planned = service.createWorkorderFromQuote(planner, quote.id, {
    resourceId: state.resource.id, startAt: '2026-10-08T08:00:00.000Z', endAt: '2026-10-08T10:00:00.000Z',
  }, `${prefix}-workorder`);
  const active = service.transitionWorkorder(planner, planned.id, 'active', planned.version, `${prefix}-active`);
  const done = service.transitionWorkorder(planner, active.id, 'done', active.version, `${prefix}-done`);
  return { quote, workorder: done };
}

test('complete operational and financial flow has exact money, stock, exports and survives restart', t => {
  const f = fixture(t);
  let s = f.service;
  const state = seed(s, 'flow');
  assert.equal(state.quote.netCents, 14000);
  assert.equal(state.quote.vatCents, 2940);
  assert.equal(state.quote.totalCents, 16940);
  const quote = accept(s, state.quote, 'flow');
  let workorder = s.createWorkorderFromQuote(planner, quote.id, {
    resourceId: state.resource.id, startAt: '2026-10-08T08:00:00.000Z', endAt: '2026-10-08T10:00:00.000Z',
  }, 'flow-workorder');
  assert.equal(workorder.customerId, state.customer.id);
  s.reserveInventory(planner, { workorderId: workorder.id, productId: state.product.id, quantity: 2 }, 'flow-reserve');
  assert.equal(s.get(admin, 'products', state.product.id).available, 6);
  workorder = s.transitionWorkorder(planner, workorder.id, 'active', workorder.version, 'flow-active');
  const hours = s.recordHours(technician, { workorderId: workorder.id, minutes: 90, date: '2026-10-08', note: 'Synthetische montage' }, 'flow-hours');
  assert.equal(hours.minutes, 90);
  s.consumeInventory(technician, { workorderId: workorder.id, productId: state.product.id, quantity: 2 }, 'flow-consume');
  const stock = s.get(admin, 'products', state.product.id);
  assert.equal(stock.stock, 6);
  assert.equal(stock.reserved, 0);
  assert.equal(stock.available, 6);
  workorder = s.transitionWorkorder(planner, workorder.id, 'done', workorder.version, 'flow-done');
  const invoice = s.issueInvoice(finance, { quoteId: quote.id, workorderId: workorder.id, dueDate: '2026-11-07' }, 'flow-invoice');
  assert.equal(invoice.totalCents, 16940);
  assert.equal(invoice.netCents + invoice.vatCents, invoice.totalCents);
  assert.ok(invoice.number);
  s.recordPayment(finance, { invoiceId: invoice.id, amountCents: 5000, reference: 'SYNTHETIC-PARTIAL-1' }, 'flow-payment');
  s.issueCreditNote(finance, { invoiceId: invoice.id, amountCents: 1940, reason: 'Synthetische tegemoetkoming' }, 'flow-credit');
  let balance = s.get(finance, 'invoices', invoice.id);
  assert.equal(balance.paidCents, 5000);
  assert.equal(balance.creditedCents, 1940);
  assert.equal(balance.balanceCents, 10000);
  const firstExport = s.exportBookkeeping(finance);
  assert.ok(firstExport.entries.length >= 3);
  assert.equal(new Set(firstExport.entries.map(entry => entry.id)).size, firstExport.entries.length);
  assert.deepEqual(s.exportBookkeeping(finance), firstExport, 'read-only export must not consume the outbox');
  const beforeAudit = s.list(admin, 'audit');
  assert.ok(beforeAudit.length > 0);
  s = f.restart();
  balance = s.get(finance, 'invoices', invoice.id);
  assert.equal(balance.balanceCents, 10000);
  assert.equal(s.get(admin, 'products', state.product.id).stock, 6);
  assert.equal(s.get(planner, 'workorders', workorder.id).status, 'done');
  assert.deepEqual(s.exportBookkeeping(finance), firstExport);
  assert.deepEqual(s.list(admin, 'audit'), beforeAudit);
  s.recordPayment(finance, { invoiceId: invoice.id, amountCents: 10000, reference: 'SYNTHETIC-SETTLEMENT-2' }, 'flow-settlement');
  assert.equal(s.get(finance, 'invoices', invoice.id).balanceCents, 0);
});

test('authorization denies operational and finance writes, including idempotency replay', t => {
  const { service: s } = fixture(t);
  const state = seed(s, 'roles');
  failure('FORBIDDEN', () => s.createCustomer(reader, { name: 'Denied', type: 'b2c' }, 'roles-denied-customer'));
  failure('FORBIDDEN', () => s.createProduct(technician, { name: 'Denied', sku: 'DENIED', unitCents: 1, vatBasisPoints: 0, stock: 0 }, 'roles-denied-product'));
  failure('FORBIDDEN', () => s.exportBookkeeping(planner));
  failure('FORBIDDEN', () => s.list(planner, 'audit'));
  failure('FORBIDDEN', () => s.createCustomer(reader, { name: 'Synthetische klant', email: 'customer@example.test', type: 'b2b' }, 'roles-customer'));
  failure('FORBIDDEN', () => s.createCustomer({ id: 'malicious', role: 'superadmin' }, { name: 'Denied', type: 'b2c' }, 'roles-forged-role'));
  assert.equal(s.list(admin, 'customers').length, 1);
  assert.equal(s.get(admin, 'customers', state.customer.id).name, 'Synthetische klant');
});

test('idempotency persists, does not repeat side effects, and rejects changed payloads', t => {
  const f = fixture(t);
  const args = { name: 'Idempotente klant', type: 'b2c' };
  const first = f.service.createCustomer(admin, args, 'idempotency-customer');
  const audit = f.service.list(admin, 'audit');
  assert.deepEqual(f.service.createCustomer(admin, args, 'idempotency-customer'), first);
  assert.deepEqual(f.service.list(admin, 'audit'), audit);
  failure('CONFLICT', () => f.service.createCustomer(admin, { ...args, name: 'Gewijzigd' }, 'idempotency-customer'));
  assert.equal(f.service.list(admin, 'customers').length, 1);
  f.restart();
  assert.deepEqual(f.service.createCustomer(admin, args, 'idempotency-customer'), first);
  assert.deepEqual(f.service.list(admin, 'audit'), audit);
});

test('null, zero and non-integer references are rejected rather than silently omitted', t => {
  const { service: s } = fixture(t);
  const state = seed(s, 'references');
  for (const customerId of [null, 0, -1, 1.5, String(state.customer.id)]) {
    failure('VALIDATION', () => s.createQuote(planner, { customerId, lines: [{ description: 'Test', unitCents: 100, quantityMilli: 1000, vatBasisPoints: 0 }] }, `references-invalid-${String(customerId)}`));
  }
  for (const productId of [null, 0]) {
    failure('VALIDATION', () => s.createQuote(planner, { customerId: state.customer.id, lines: [{ description: 'Test', unitCents: 100, quantityMilli: 1000, vatBasisPoints: 0, productId }] }, `references-product-${String(productId)}`));
  }
  failure('NOT_FOUND', () => s.createQuote(planner, { customerId: 999999, lines: [{ description: 'Test', unitCents: 100, quantityMilli: 1000, vatBasisPoints: 0 }] }, 'references-unknown-customer'));
  assert.equal(s.list(planner, 'quotes').length, 1);
});

test('strict schemas and integer unit limits reject invalid money, quantity, VAT and stock', t => {
  const { service: s } = fixture(t);
  const state = seed(s, 'units');
  failure('VALIDATION', () => s.createCustomer(admin, { name: 'Invalid', type: 'b2c', privileged: true }, 'units-extra-customer'));
  const base = { description: 'Materiaal', unitCents: 100, quantityMilli: 1000, vatBasisPoints: 2100 };
  const invalid = [
    { unitCents: -1 }, { unitCents: 1.1 }, { unitCents: NaN }, { unitCents: Infinity },
    { quantityMilli: 0 }, { quantityMilli: 0.5 }, { quantityMilli: null },
    { vatBasisPoints: -1 }, { vatBasisPoints: 21.5 }, { unexpected: 'field' },
  ];
  invalid.forEach((patch, index) => failure('VALIDATION', () => s.createQuote(planner, { customerId: state.customer.id, lines: [{ ...base, ...patch }] }, `units-invalid-line-${index}`)));
  failure('VALIDATION', () => s.createQuote(planner, { customerId: state.customer.id, lines: [] }, 'units-empty-quote'));
  failure('VALIDATION', () => s.createProduct(admin, { name: 'Invalid', sku: 'INVALID', unitCents: 1, vatBasisPoints: 0, stock: 0.5 }, 'units-fractional-stock'));
  assert.equal(s.list(planner, 'quotes').length, 1);
});

test('quote transitions require current versions and rejected quotes cannot reopen or produce workorders', t => {
  const { service: s } = fixture(t);
  const { quote } = seed(s, 'quote-state');
  failure('CONFLICT', () => s.transitionQuote(planner, quote.id, 'accepted', quote.version, 'quote-state-skip'));
  const sent = s.transitionQuote(planner, quote.id, 'sent', quote.version, 'quote-state-sent');
  failure('CONFLICT', () => s.transitionQuote(planner, quote.id, 'accepted', quote.version, 'quote-state-stale'));
  const rejected = s.transitionQuote(planner, quote.id, 'rejected', sent.version, 'quote-state-rejected');
  failure('CONFLICT', () => s.transitionQuote(planner, quote.id, 'sent', rejected.version, 'quote-state-reopen'));
  failure('CONFLICT', () => s.createWorkorderFromQuote(planner, quote.id, {}, 'quote-state-denied-workorder'));
  failure('CONFLICT', () => s.issueInvoice(finance, { quoteId: quote.id, dueDate: '2026-11-07' }, 'quote-state-denied-invoice'));
  assert.equal(s.list(planner, 'workorders').length, 0);
  assert.equal(s.list(finance, 'invoices').length, 0);
});

test('scheduling blocks overlaps, permits adjacent visits and rolls back failed updates', t => {
  const { service: s } = fixture(t);
  const first = seed(s, 'planning-first');
  const second = seed(s, 'planning-second');
  const q1 = accept(s, first.quote, 'planning-first');
  const q2 = accept(s, second.quote, 'planning-second');
  const w1 = s.createWorkorderFromQuote(planner, q1.id, {
    resourceId: first.resource.id, startAt: '2026-10-08T08:00:00.000Z', endAt: '2026-10-08T10:00:00.000Z',
  }, 'planning-first-order');
  const w2 = s.createWorkorderFromQuote(planner, q2.id, {}, 'planning-second-order');
  const before = s.get(planner, 'workorders', w2.id);
  const audit = s.list(admin, 'audit');
  failure('CONFLICT', () => s.scheduleWorkorder(planner, w2.id, {
    resourceId: first.resource.id, startAt: '2026-10-08T09:00:00.000Z', endAt: '2026-10-08T11:00:00.000Z',
  }, w2.version, 'planning-conflict'));
  assert.deepEqual(s.get(planner, 'workorders', w2.id), before);
  assert.deepEqual(s.list(admin, 'audit'), audit);
  const adjacent = s.scheduleWorkorder(planner, w2.id, {
    resourceId: first.resource.id, startAt: '2026-10-08T10:00:00.000Z', endAt: '2026-10-08T11:00:00.000Z',
  }, w2.version, 'planning-adjacent');
  assert.equal(adjacent.resourceId, first.resource.id);
  assert.equal(s.get(planner, 'workorders', w1.id).status, 'planned');
  failure('CONFLICT', () => s.scheduleWorkorder(planner, w2.id, {
    resourceId: second.resource.id, startAt: '2026-10-09T10:00:00.000Z', endAt: '2026-10-09T11:00:00.000Z',
  }, w2.version, 'planning-stale'));
});

test('assignment protects workorder and time visibility and unauthorized time writes have no side effects', t => {
  const { service: s } = fixture(t);
  const state = seed(s, 'assignment');
  const quote = accept(s, state.quote, 'assignment');
  const workorder = s.createWorkorderFromQuote(planner, quote.id, {
    resourceId: state.resource.id, startAt: '2026-10-08T08:00:00.000Z', endAt: '2026-10-08T10:00:00.000Z',
  }, 'assignment-order');
  s.transitionWorkorder(planner, workorder.id, 'active', workorder.version, 'assignment-active');
  const audit = s.list(admin, 'audit');
  failure('FORBIDDEN', () => s.recordHours(stranger, { workorderId: workorder.id, minutes: 60, date: '2026-10-08' }, 'assignment-denied-hours'));
  failure('FORBIDDEN', () => s.get(stranger, 'workorders', workorder.id));
  assert.equal(s.list(stranger, 'workorders').length, 0);
  assert.equal(s.list(admin, 'hours').length, 0);
  assert.deepEqual(s.list(admin, 'audit'), audit);
  const recorded = s.recordHours(technician, { workorderId: workorder.id, minutes: 60, date: '2026-10-08' }, 'assignment-valid-hours');
  assert.equal(s.get(technician, 'hours', recorded.id).minutes, 60);
  assert.equal(s.list(stranger, 'hours').length, 0);
});

test('inventory cannot reserve unavailable units, consume another order reservation, or go negative', t => {
  const { service: s } = fixture(t);
  const one = seed(s, 'inventory-one');
  const two = seed(s, 'inventory-two');
  const q1 = accept(s, one.quote, 'inventory-one');
  const q2 = accept(s, two.quote, 'inventory-two');
  const w1 = s.createWorkorderFromQuote(planner, q1.id, { resourceId: one.resource.id, startAt: '2026-10-08T08:00:00.000Z', endAt: '2026-10-08T10:00:00.000Z' }, 'inventory-one-order');
  const w2 = s.createWorkorderFromQuote(planner, q2.id, {}, 'inventory-two-order');
  s.transitionWorkorder(planner, w1.id, 'active', w1.version, 'inventory-one-active');
  s.reserveInventory(planner, { workorderId: w1.id, productId: one.product.id, quantity: 6 }, 'inventory-reserve-six');
  const before = s.get(admin, 'products', one.product.id);
  const movements = s.list(admin, 'movements');
  const audit = s.list(admin, 'audit');
  failure('CONFLICT', () => s.reserveInventory(planner, { workorderId: w2.id, productId: one.product.id, quantity: 3 }, 'inventory-over-reserve'));
  failure('CONFLICT', () => s.consumeInventory(admin, { workorderId: w2.id, productId: one.product.id, quantity: 1 }, 'inventory-other-order-consume'));
  failure('CONFLICT', () => s.adjustStock(admin, { productId: one.product.id, delta: -3, reason: 'Must preserve reservations' }, 'inventory-adjust-below-reserved'));
  assert.deepEqual(s.get(admin, 'products', one.product.id), before);
  assert.deepEqual(s.list(admin, 'movements'), movements);
  assert.deepEqual(s.list(admin, 'audit'), audit);
  s.consumeInventory(technician, { workorderId: w1.id, productId: one.product.id, quantity: 6 }, 'inventory-consume-six');
  assert.equal(s.get(admin, 'products', one.product.id).stock, 2);
  assert.equal(s.get(admin, 'products', one.product.id).reserved, 0);
  failure('CONFLICT', () => s.consumeInventory(technician, { workorderId: w1.id, productId: one.product.id, quantity: 1 }, 'inventory-unreserved-consume'));
});

test('invoice binds completed order to its quote and duplicate invoices roll back cleanly', t => {
  const { service: s } = fixture(t);
  const a = complete(s, seed(s, 'invoice-a'), 'invoice-a');
  const b = complete(s, seed(s, 'invoice-b'), 'invoice-b');
  failure('CONFLICT', () => s.issueInvoice(finance, { quoteId: a.quote.id, workorderId: b.workorder.id, dueDate: '2026-11-07' }, 'invoice-cross-customer'));
  const invoice = s.issueInvoice(finance, { quoteId: a.quote.id, workorderId: a.workorder.id, dueDate: '2026-11-07' }, 'invoice-first');
  const audit = s.list(admin, 'audit');
  const outbox = s.exportBookkeeping(finance);
  failure('CONFLICT', () => s.issueInvoice(finance, { quoteId: a.quote.id, workorderId: a.workorder.id, dueDate: '2026-11-07' }, 'invoice-second'));
  assert.equal(s.list(finance, 'invoices').length, 1);
  assert.deepEqual(s.list(admin, 'audit'), audit);
  assert.deepEqual(s.exportBookkeeping(finance), outbox);
  assert.deepEqual(s.issueInvoice(finance, { quoteId: a.quote.id, workorderId: a.workorder.id, dueDate: '2026-11-07' }, 'invoice-first'), invoice);
});

test('payments reject duplicate references, overpayments and malformed units without audit or outbox writes', t => {
  const { service: s } = fixture(t);
  const { quote } = complete(s, seed(s, 'payments'), 'payments');
  const invoice = s.issueInvoice(finance, { quoteId: quote.id, dueDate: '2026-11-07' }, 'payments-invoice');
  const args = { invoiceId: invoice.id, amountCents: 5000, reference: 'UNIQUE-SYNTHETIC-REFERENCE' };
  const payment = s.recordPayment(finance, args, 'payments-first');
  const audit = s.list(admin, 'audit');
  const outbox = s.exportBookkeeping(finance);
  failure('CONFLICT', () => s.recordPayment(finance, args, 'payments-duplicate-reference'));
  failure('CONFLICT', () => s.recordPayment(finance, { ...args, amountCents: 12000, reference: 'OVERPAYMENT' }, 'payments-overpayment'));
  [0, -1, 1.5, null].forEach((amountCents, index) => failure('VALIDATION', () => s.recordPayment(finance, { ...args, amountCents, reference: `INVALID-${index}` }, `payments-invalid-${index}`)));
  assert.deepEqual(s.recordPayment(finance, args, 'payments-first'), payment);
  failure('CONFLICT', () => s.recordPayment(finance, { ...args, amountCents: 5001 }, 'payments-first'));
  assert.equal(s.list(finance, 'payments').length, 1);
  assert.equal(s.get(finance, 'invoices', invoice.id).balanceCents, 11940);
  assert.deepEqual(s.list(admin, 'audit'), audit);
  assert.deepEqual(s.exportBookkeeping(finance), outbox);
});

test('credits cannot exceed unpaid balance and keep immutable invoice face value', t => {
  const { service: s } = fixture(t);
  const { quote } = complete(s, seed(s, 'credit'), 'credit');
  const invoice = s.issueInvoice(finance, { quoteId: quote.id, dueDate: '2026-11-07' }, 'credit-invoice');
  s.recordPayment(finance, { invoiceId: invoice.id, amountCents: 10000, reference: 'CREDIT-PARTIAL' }, 'credit-partial-payment');
  const before = s.get(finance, 'invoices', invoice.id);
  const audit = s.list(admin, 'audit');
  failure('CONFLICT', () => s.issueCreditNote(finance, { invoiceId: invoice.id, amountCents: 6941, reason: 'Above remaining balance' }, 'credit-too-much'));
  assert.deepEqual(s.get(finance, 'invoices', invoice.id), before);
  assert.deepEqual(s.list(admin, 'audit'), audit);
  s.issueCreditNote(finance, { invoiceId: invoice.id, amountCents: 6940, reason: 'Synthetic closeout' }, 'credit-closeout');
  const after = s.get(finance, 'invoices', invoice.id);
  assert.equal(after.totalCents, 16940);
  assert.equal(after.balanceCents, 0);
  assert.equal(after.creditedCents, 6940);
  failure('CONFLICT', () => s.recordPayment(finance, { invoiceId: invoice.id, amountCents: 1, reference: 'CREDIT-EXTRA' }, 'credit-extra-payment'));
});

test('a real database audit failure rolls back business writes and idempotency atomically', t => {
  const f = fixture(t);
  const db = new DatabaseSync(f.database);
  db.exec("CREATE TRIGGER acceptance_audit_failure BEFORE INSERT ON ops_audit BEGIN SELECT RAISE(ABORT, 'synthetic audit unavailable'); END;");
  db.close();
  const args = { name: 'Rollback verification', type: 'b2c' };
  assert.throws(() => f.service.createCustomer(admin, args, 'atomic-audit-failure'));
  assert.equal(f.service.list(admin, 'customers').length, 0, 'business row must roll back when audit write fails');
  assert.equal(f.service.list(admin, 'audit').length, 0);
  const inspection = new DatabaseSync(f.database);
  assert.equal(inspection.prepare('SELECT COUNT(*) AS count FROM ops_idempotency').get().count, 0, 'failed requests must not leave replay records');
  inspection.exec('DROP TRIGGER acceptance_audit_failure');
  inspection.close();
  const retried = f.service.createCustomer(admin, args, 'atomic-audit-failure');
  assert.equal(retried.name, args.name);
  assert.equal(f.service.list(admin, 'customers').length, 1);
  assert.equal(f.service.list(admin, 'audit').length, 1);
});

test('cancellation releases reservations atomically without consuming stock or reopening the order', t => {
  const { service: s } = fixture(t);
  const state = seed(s, 'cancellation');
  const quote = accept(s, state.quote, 'cancellation');
  const planned = s.createWorkorderFromQuote(planner, quote.id, {}, 'cancellation-order');
  s.reserveInventory(planner, { workorderId: planned.id, productId: state.product.id, quantity: 3 }, 'cancellation-reserve');
  assert.equal(s.get(admin, 'products', state.product.id).available, 5);
  const cancelled = s.transitionWorkorder(planner, planned.id, 'cancelled', planned.version, 'cancellation-cancel');
  const product = s.get(admin, 'products', state.product.id);
  assert.equal(product.stock, 8);
  assert.equal(product.reserved, 0);
  assert.equal(product.available, 8);
  assert.deepEqual(s.get(planner, 'workorders', planned.id).reservations, []);
  assert.ok(s.list(admin, 'movements').some(row => row.kind === 'release' && row.quantity === 3));
  failure('CONFLICT', () => s.transitionWorkorder(planner, planned.id, 'active', cancelled.version, 'cancellation-reopen'));
  failure('CONFLICT', () => s.reserveInventory(planner, { workorderId: planned.id, productId: state.product.id, quantity: 1 }, 'cancellation-reserve-again'));
});

test('planning and time validation reject impossible dates, inverted intervals and future or fractional hours', t => {
  const { service: s } = fixture(t);
  const state = seed(s, 'dates');
  const quote = accept(s, state.quote, 'dates');
  const order = s.createWorkorderFromQuote(planner, quote.id, {}, 'dates-order');
  const invalidPlans = [
    { resourceId: state.resource.id, startAt: '2026-02-30T08:00:00Z', endAt: '2026-03-02T10:00:00Z' },
    { resourceId: state.resource.id, startAt: '2026-10-08T10:00:00Z', endAt: '2026-10-08T08:00:00Z' },
    { resourceId: null, startAt: '2026-10-08T08:00:00Z', endAt: '2026-10-08T10:00:00Z' },
    { resourceId: state.resource.id, startAt: '2026-10-08T08:00:00', endAt: '2026-10-08T10:00:00' },
  ];
  invalidPlans.forEach((plan, index) => failure('VALIDATION', () => s.scheduleWorkorder(planner, order.id, plan, order.version, `dates-invalid-plan-${index}`)));
  const assigned = s.scheduleWorkorder(planner, order.id, {
    resourceId: state.resource.id, startAt: '2026-10-08T08:00:00Z', endAt: '2026-10-08T10:00:00Z',
  }, order.version, 'dates-valid-plan');
  s.transitionWorkorder(planner, assigned.id, 'active', assigned.version, 'dates-active');
  const invalidHours = [
    { minutes: 0, date: '2026-10-08' }, { minutes: 1.5, date: '2026-10-08' },
    { minutes: 1441, date: '2026-10-08' }, { minutes: 60, date: '2026-02-30' },
    { minutes: 60, date: '2026-10-10' },
  ];
  invalidHours.forEach((hours, index) => failure('VALIDATION', () => s.recordHours(technician, { workorderId: order.id, ...hours }, `dates-invalid-hours-${index}`)));
  assert.equal(s.list(admin, 'hours').length, 0);
});

test('a technician cannot acquire a second resource alias, while distinct technicians can work concurrently', t => {
  const { service: s } = fixture(t);
  const one = seed(s, 'alias-one');
  const two = seed(s, 'alias-two');
  const beforeResources = s.list(admin, 'resources');
  const aliasAudit = s.list(admin, 'audit');
  failure('CONFLICT', () => s.createResource(admin, { name: 'Second alias same person', technicianId: technician.id }, 'alias-duplicate-resource'));
  assert.deepEqual(s.list(admin, 'resources'), beforeResources);
  assert.deepEqual(s.list(admin, 'audit'), aliasAudit);
  const otherTechnician = s.createResource(admin, { name: 'Independent technician', technicianId: 'another-synthetic-tech' }, 'alias-distinct-tech');
  const q1 = accept(s, one.quote, 'alias-one');
  const q2 = accept(s, two.quote, 'alias-two');
  s.createWorkorderFromQuote(planner, q1.id, {
    resourceId: one.resource.id, startAt: '2026-10-08T08:00:00Z', endAt: '2026-10-08T10:00:00Z',
  }, 'alias-first-order');
  const order = s.createWorkorderFromQuote(planner, q2.id, {}, 'alias-second-order');
  const before = s.get(planner, 'workorders', order.id);
  const audit = s.list(admin, 'audit');
  failure('CONFLICT', () => s.scheduleWorkorder(planner, order.id, {
    resourceId: two.resource.id, startAt: '2026-10-08T09:00:00Z', endAt: '2026-10-08T11:00:00Z',
  }, order.version, 'alias-conflict-order'));
  assert.deepEqual(s.get(planner, 'workorders', order.id), before);
  assert.deepEqual(s.list(admin, 'audit'), audit);
  const scheduled = s.scheduleWorkorder(planner, order.id, {
    resourceId: otherTechnician.id, startAt: '2026-10-08T09:00:00Z', endAt: '2026-10-08T11:00:00Z',
  }, order.version, 'alias-independent-order');
  assert.equal(scheduled.resourceId, otherTechnician.id);
});

test('omitting an existing workorder from invoice input cannot bypass completion or cancellation', t => {
  const { service: s } = fixture(t);
  const one = seed(s, 'omit-active');
  const quote = accept(s, one.quote, 'omit-active');
  const planned = s.createWorkorderFromQuote(planner, quote.id, {}, 'omit-active-order');
  failure('CONFLICT', () => s.issueInvoice(finance, { quoteId: quote.id, dueDate: '2026-11-07' }, 'omit-planned-invoice'));
  const active = s.transitionWorkorder(planner, planned.id, 'active', planned.version, 'omit-active-start');
  failure('CONFLICT', () => s.issueInvoice(finance, { quoteId: quote.id, dueDate: '2026-11-07' }, 'omit-active-invoice'));
  const done = s.transitionWorkorder(planner, active.id, 'done', active.version, 'omit-active-done');
  const invoice = s.issueInvoice(finance, { quoteId: quote.id, dueDate: '2026-11-07' }, 'omit-completed-invoice');
  assert.equal(invoice.workorderId, done.id, 'completed linked workorder must remain bound to the invoice');
  const two = seed(s, 'omit-cancelled');
  const q2 = accept(s, two.quote, 'omit-cancelled');
  const p2 = s.createWorkorderFromQuote(planner, q2.id, {}, 'omit-cancelled-order');
  s.transitionWorkorder(planner, p2.id, 'cancelled', p2.version, 'omit-cancelled-stop');
  const audit = s.list(admin, 'audit');
  failure('CONFLICT', () => s.issueInvoice(finance, { quoteId: q2.id, dueDate: '2026-11-07' }, 'omit-cancelled-invoice'));
  assert.equal(s.list(finance, 'invoices').length, 1);
  assert.deepEqual(s.list(admin, 'audit'), audit);
});

test('unused reserved parts can be released without stock loss and a job completes after partial consumption', t => {
  const { service: s } = fixture(t);
  const state = seed(s, 'unused');
  const quote = accept(s, state.quote, 'unused');
  let order = s.createWorkorderFromQuote(planner, quote.id, {
    resourceId: state.resource.id, startAt: '2026-10-08T08:00:00Z', endAt: '2026-10-08T10:00:00Z',
  }, 'unused-order');
  s.reserveInventory(planner, { workorderId: order.id, productId: state.product.id, quantity: 4 }, 'unused-reserve-four');
  order = s.transitionWorkorder(planner, order.id, 'active', order.version, 'unused-active');
  s.consumeInventory(technician, { workorderId: order.id, productId: state.product.id, quantity: 2 }, 'unused-consume-two');
  const before = s.get(admin, 'products', state.product.id);
  const audit = s.list(admin, 'audit');
  assert.equal(before.stock, 6);
  assert.equal(before.reserved, 2);
  failure('CONFLICT', () => s.transitionWorkorder(planner, order.id, 'done', order.version, 'unused-premature-done'));
  failure('FORBIDDEN', () => s.releaseInventory(technician, { workorderId: order.id, productId: state.product.id, quantity: 2 }, 'unused-technician-release'));
  failure('CONFLICT', () => s.releaseInventory(planner, { workorderId: order.id, productId: state.product.id, quantity: 3 }, 'unused-overflow-release'));
  assert.deepEqual(s.get(admin, 'products', state.product.id), before);
  assert.deepEqual(s.list(admin, 'audit'), audit);
  const release = s.releaseInventory(planner, { workorderId: order.id, productId: state.product.id, quantity: 2 }, 'unused-release-two');
  assert.equal(release.kind, 'release');
  assert.equal(release.quantity, 2);
  const after = s.get(admin, 'products', state.product.id);
  assert.equal(after.stock, 6);
  assert.equal(after.reserved, 0);
  assert.equal(after.available, 6);
  const done = s.transitionWorkorder(planner, order.id, 'done', order.version, 'unused-done');
  assert.equal(done.status, 'done');
  assert.deepEqual(done.reservations, []);
});

test('Dutch local business date and invoice numbering follow the year across UTC midnight boundaries', t => {
  const { service: s } = fixture(t, { now: () => '2026-12-31T23:30:00.000Z' });
  const state = seed(s, 'local-year');
  const quote = accept(s, state.quote, 'local-year');
  failure('VALIDATION', () => s.issueInvoice(finance, { quoteId: quote.id, dueDate: '2026-12-31' }, 'local-year-invalid-due-date'));
  const invoice = s.issueInvoice(finance, { quoteId: quote.id, dueDate: '2027-01-07' }, 'local-year-invoice');
  assert.equal(invoice.issuedAt, '2026-12-31T23:30:00.000Z');
  assert.equal(invoice.issuedDate, '2027-01-01');
  assert.equal(invoice.businessTimezone, 'Europe/Amsterdam');
  assert.match(invoice.number, /2027/);
  assert.doesNotMatch(invoice.number, /2026/);
  const order = s.createWorkorderFromQuote(planner, quote.id, {
    resourceId: state.resource.id, startAt: '2027-01-01T00:00:00Z', endAt: '2027-01-01T02:00:00Z',
  }, 'local-year-order');
  s.transitionWorkorder(planner, order.id, 'active', order.version, 'local-year-active');
  const hours = s.recordHours(technician, { workorderId: order.id, minutes: 30, date: '2027-01-01' }, 'local-year-hours-today');
  assert.equal(hours.date, '2027-01-01', 'local current date is valid even when UTC date is previous day');
  failure('VALIDATION', () => s.recordHours(technician, { workorderId: order.id, minutes: 30, date: '2027-01-02' }, 'local-year-hours-future'));
});

test('an outbox storage failure rolls back invoice, sequence, audit and replay state as one transaction', t => {
  const f = fixture(t);
  const { quote } = complete(f.service, seed(f.service, 'outbox-atomic'), 'outbox-atomic');
  const beforeAudit = f.service.list(admin, 'audit');
  const injection = new DatabaseSync(f.database);
  const replayCount = injection.prepare('SELECT COUNT(*) AS count FROM ops_idempotency').get().count;
  injection.exec("CREATE TRIGGER acceptance_outbox_failure BEFORE INSERT ON ops_outbox BEGIN SELECT RAISE(ABORT, 'synthetic outbox unavailable'); END;");
  injection.close();
  const input = { quoteId: quote.id, dueDate: '2026-11-07' };
  assert.throws(() => f.service.issueInvoice(finance, input, 'outbox-atomic-invoice'));
  assert.equal(f.service.list(finance, 'invoices').length, 0);
  assert.equal(f.service.list(finance, 'outbox').length, 0);
  assert.deepEqual(f.service.list(admin, 'audit'), beforeAudit);
  const inspection = new DatabaseSync(f.database);
  assert.equal(inspection.prepare('SELECT COUNT(*) AS count FROM ops_sequences').get().count, 0, 'failed invoice must not consume a document number');
  assert.equal(inspection.prepare('SELECT COUNT(*) AS count FROM ops_idempotency').get().count, replayCount);
  inspection.exec('DROP TRIGGER acceptance_outbox_failure');
  inspection.close();
  const invoice = f.service.issueInvoice(finance, input, 'outbox-atomic-invoice');
  assert.equal(invoice.number, 'INV-2026-000001');
  assert.equal(f.service.list(finance, 'invoices').length, 1);
  assert.equal(f.service.list(finance, 'outbox').length, 1);
  assert.equal(f.service.list(admin, 'audit').length, beforeAudit.length + 1);
});
