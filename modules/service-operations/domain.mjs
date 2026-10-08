// SPDX-License-Identifier: GPL-3.0-or-later
// Portable service-operations rules. Persistence, authorization and HTTP belong to the host app.
import { createHash } from 'node:crypto';
import {
  assertTransition,
  assertVersion,
  calculateLines,
  optionalReference,
} from '../../integrations/wordpress-contract/domain.mjs';

const recordKinds = new Set(['customer', 'quote', 'workorder', 'time', 'ledger']);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const idempotencyPattern = /^[A-Za-z0-9_-]{8,100}$/;
const maxPayloadBytes = 262144;

function requireRecord(value, allowedFields, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(label);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(label);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedFields.includes(key)) throw new TypeError(`${label} field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError(`${label} field`);
  }
  return value;
}

function positiveId(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(label);
  return value;
}

function requiredText(value, label, maxLength = 500) {
  if (typeof value !== 'string') throw new TypeError(label);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new TypeError(label);
  return normalized;
}

function validDate(value) {
  if (typeof value !== 'string' || !datePattern.test(value)) throw new TypeError('date');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new TypeError('date');
  }
  return value;
}

function metadata(value) {
  const result = {};
  if (value.id !== undefined) result.id = positiveId(value.id, 'id');
  if (value.version !== undefined) {
    if (!Number.isSafeInteger(value.version) || value.version < 1) throw new TypeError('version');
    result.version = value.version;
  }
  return result;
}

export function validateCustomer(value) {
  const customer = requireRecord(value, ['id', 'version', 'kind', 'company'], 'customer');
  if (customer.kind !== 'B2B' && customer.kind !== 'B2C') throw new TypeError('kind');
  const normalizedCompany = customer.company === undefined
    ? undefined
    : requiredText(customer.company, 'company');
  if (customer.kind === 'B2B' && normalizedCompany === undefined) throw new TypeError('company');
  return {
    ...metadata(customer),
    kind: customer.kind,
    ...(normalizedCompany === undefined ? {} : { company: normalizedCompany }),
  };
}

export function validateQuote(value) {
  const quote = requireRecord(value, ['id', 'version', 'customer_id', 'status', 'lines'], 'quote');
  const status = assertTransition('quote', quote.status, quote.status);
  const calculated = calculateLines(quote.lines);
  if (calculated.lines.length === 0) throw new TypeError('lines');
  return {
    ...metadata(quote),
    customer_id: positiveId(quote.customer_id, 'customer_id'),
    status,
    ...calculated,
  };
}

export function validateWorkorder(value) {
  const workorder = requireRecord(
    value,
    ['id', 'version', 'customer_id', 'quote_id', 'status'],
    'workorder',
  );
  const normalizedQuoteId = optionalReference(workorder.quote_id);
  return {
    ...metadata(workorder),
    customer_id: positiveId(workorder.customer_id, 'customer_id'),
    ...(normalizedQuoteId === undefined ? {} : { quote_id: normalizedQuoteId }),
    status: assertTransition('workorder', workorder.status, workorder.status),
  };
}

export function assertWorkorderQuoteBinding(workorderValue, quoteValue) {
  const workorder = validateWorkorder(workorderValue);
  if (workorder.quote_id === undefined) return true;
  const quote = validateQuote(quoteValue);
  if (quote.id !== workorder.quote_id) throw new Error('quote reference conflict');
  if (quote.status !== 'accepted') throw new Error('quote not accepted');
  if (quote.customer_id !== workorder.customer_id) throw new Error('customer reference conflict');
  return true;
}

export function validateTimeEntry(value) {
  const entry = requireRecord(
    value,
    ['id', 'version', 'workorder_id', 'minutes', 'date', 'description'],
    'time',
  );
  if (!Number.isSafeInteger(entry.minutes) || entry.minutes < 1 || entry.minutes > 1440) {
    throw new TypeError('minutes');
  }
  return {
    ...metadata(entry),
    workorder_id: positiveId(entry.workorder_id, 'workorder_id'),
    minutes: entry.minutes,
    date: validDate(entry.date),
    description: requiredText(entry.description, 'description'),
  };
}

export function validateLedgerEntry(value) {
  const entry = requireRecord(
    value,
    ['id', 'version', 'workorder_id', 'amount_cents', 'date', 'description', 'type'],
    'ledger',
  );
  if (!Number.isSafeInteger(entry.amount_cents) || entry.amount_cents < 1) {
    throw new TypeError('amount_cents');
  }
  if (entry.type !== 'income' && entry.type !== 'expense') throw new TypeError('type');
  return {
    ...metadata(entry),
    workorder_id: positiveId(entry.workorder_id, 'workorder_id'),
    amount_cents: entry.amount_cents,
    date: validDate(entry.date),
    description: requiredText(entry.description, 'description'),
    type: entry.type,
  };
}

export function assertAppendOnlyMutation(kind, action) {
  if (kind !== 'time' && kind !== 'ledger') throw new TypeError('kind');
  if (action === 'create') return true;
  if (action === 'update' || action === 'delete') throw new Error('record is immutable');
  throw new TypeError('action');
}

export function assertRecordVersion(expected, actual) {
  return assertVersion(expected, actual);
}

export function normalizeIdempotencyKey(kind, key) {
  if (!recordKinds.has(kind)) throw new TypeError('kind');
  if (typeof key !== 'string' || !idempotencyPattern.test(key)) {
    throw new TypeError('idempotency key');
  }
  return key;
}

function canonicalJson(value, seen, depth = 0) {
  if (depth > 32) throw new TypeError('payload depth');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('payload number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('payload cycle');
    seen.add(value);
    try {
      return `[${value.map((item) => canonicalJson(item, seen, depth + 1)).join(',')}]`;
    } finally {
      seen.delete(value);
    }
  }
  if (typeof value !== 'object') throw new TypeError('payload value');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('payload object');
  if (seen.has(value)) throw new TypeError('payload cycle');
  seen.add(value);
  try {
    const keys = Object.keys(value).sort();
    const fields = keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('payload accessor');
      return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, seen, depth + 1)}`;
    });
    return `{${fields.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

export function idempotencyFingerprint(kind, key, payload) {
  const normalizedKey = normalizeIdempotencyKey(kind, key);
  const normalizedPayload = canonicalJson(payload, new WeakSet());
  if (Buffer.byteLength(normalizedPayload, 'utf8') > maxPayloadBytes) {
    throw new RangeError('payload size');
  }
  const payloadHash = createHash('sha256')
    .update(`${kind}\n${normalizedPayload}`, 'utf8')
    .digest('hex');
  return { kind, key: normalizedKey, payload_hash: payloadHash };
}
