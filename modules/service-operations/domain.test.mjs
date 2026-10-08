// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAppendOnlyMutation,
  assertRecordVersion,
  assertWorkorderQuoteBinding,
  idempotencyFingerprint,
  normalizeIdempotencyKey,
  validateCustomer,
  validateLedgerEntry,
  validateQuote,
  validateTimeEntry,
  validateWorkorder,
} from './domain.mjs';

const line = { description: 'Installatie', unit_cents: 6000, quantity_milli: 1500 };

test('B2B customers require a company; B2C customers may omit it', () => {
  assert.deepEqual(validateCustomer({ kind: 'B2B', company: '  Voorbeeld BV  ' }), {
    kind: 'B2B',
    company: 'Voorbeeld BV',
  });
  assert.deepEqual(validateCustomer({ kind: 'B2C' }), { kind: 'B2C' });
  assert.throws(() => validateCustomer({ kind: 'B2B' }), /company/);
  assert.throws(() => validateCustomer({ kind: 'business', company: 'Voorbeeld BV' }));
});

test('quote requires a customer, a valid status and at least one line', () => {
  assert.equal(validateQuote({ customer_id: 7, status: 'draft', lines: [line] }).total_cents, 9000);
  assert.throws(() => validateQuote({ customer_id: 7, status: 'draft', lines: [] }), /lines/);
  assert.throws(() => validateQuote({ customer_id: 0, status: 'draft', lines: [line] }));
  assert.throws(() => validateQuote({ customer_id: 7, status: 'toString', lines: [line] }));
});

test('workorder can only link to an accepted quote for the same customer', () => {
  const workorder = { id: 12, customer_id: 7, quote_id: 5, status: 'planned' };
  const quote = { id: 5, customer_id: 7, status: 'accepted', lines: [line] };
  assert.equal(assertWorkorderQuoteBinding(workorder, quote), true);
  assert.throws(() => assertWorkorderQuoteBinding(workorder, { ...quote, status: 'sent' }), /accepted/);
  assert.throws(() => assertWorkorderQuoteBinding(workorder, { ...quote, customer_id: 8 }), /customer/);
  assert.throws(() => assertWorkorderQuoteBinding(workorder, { ...quote, id: 6 }), /reference/);
});

test('workorder status and optional reference use the published contract', () => {
  assert.deepEqual(validateWorkorder({ customer_id: 7, status: 'planned' }), {
    customer_id: 7,
    status: 'planned',
  });
  assert.throws(() => validateWorkorder({ customer_id: 7, quote_id: null, status: 'planned' }));
  assert.throws(() => validateWorkorder({ customer_id: 7, status: 'impossible' }));
});

test('time entries require a valid workorder, date, description and 1..1440 minutes', () => {
  const entry = {
    workorder_id: 12,
    minutes: 60,
    date: '2026-10-08',
    description: '  Montage  ',
  };
  assert.equal(validateTimeEntry(entry).description, 'Montage');
  for (const minutes of [0, -1, 1441, 1.5]) assert.throws(() => validateTimeEntry({ ...entry, minutes }));
  for (const date of ['2026-02-30', '08-10-2026', '']) {
    assert.throws(() => validateTimeEntry({ ...entry, date }));
  }
  assert.throws(() => validateTimeEntry({ ...entry, workorder_id: 0 }));
});

test('ledger entries use integer cents and a supported direction', () => {
  const entry = {
    workorder_id: 12,
    amount_cents: 12345,
    date: '2026-10-08',
    description: 'Materiaal',
    type: 'expense',
  };
  assert.equal(validateLedgerEntry(entry).amount_cents, 12345);
  for (const amount_cents of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateLedgerEntry({ ...entry, amount_cents }));
  }
  assert.throws(() => validateLedgerEntry({ ...entry, type: 'refund' }));
});

test('time and ledger records are append-only', () => {
  assert.equal(assertAppendOnlyMutation('time', 'create'), true);
  assert.equal(assertAppendOnlyMutation('ledger', 'create'), true);
  for (const kind of ['time', 'ledger']) {
    for (const action of ['update', 'delete']) {
      assert.throws(() => assertAppendOnlyMutation(kind, action), /immutable/);
    }
  }
});

test('optimistic version check rejects stale or omitted versions', () => {
  assert.equal(assertRecordVersion(3, 3), undefined);
  assert.throws(() => assertRecordVersion(2, 3), /version conflict/);
  assert.throws(() => assertRecordVersion(undefined, 3));
});

test('idempotency key syntax and canonical payload hash are stable', () => {
  assert.equal(normalizeIdempotencyKey('quote', 'request_123'), 'request_123');
  assert.deepEqual(
    idempotencyFingerprint('quote', 'request_123', { b: 2, a: 1 }),
    idempotencyFingerprint('quote', 'request_123', { a: 1, b: 2 }),
  );
  assert.notEqual(
    idempotencyFingerprint('quote', 'request_123', { a: 1 }).payload_hash,
    idempotencyFingerprint('quote', 'request_124', { a: 2 }).payload_hash,
  );
  for (const key of ['short', 'contains space', 'x'.repeat(101)]) {
    assert.throws(() => normalizeIdempotencyKey('quote', key));
  }
});

test('idempotency hash rejects non-JSON objects, cycles and oversized payloads', () => {
  const circular = {};
  circular.self = circular;
  assert.throws(() => idempotencyFingerprint('quote', 'request_123', circular));
  assert.throws(() => idempotencyFingerprint('quote', 'request_123', new Date()));
  assert.throws(() => idempotencyFingerprint('quote', 'request_123', { body: 'x'.repeat(262145) }), /size/);
});
