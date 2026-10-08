// SPDX-License-Identifier: GPL-3.0-or-later
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export class DomainError extends Error {
  constructor(code, message, status = { VALIDATION: 422, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409 }[code] ?? 500) {
    super(message); this.name = 'DomainError'; this.code = code; this.status = status;
  }
}
const fail = (code, message) => { throw new DomainError(code, message); };
const own = (obj, key) => Object.hasOwn(obj, key);
const roles = ['admin', 'planner', 'technician', 'finance', 'reader'];
const ops = ['admin', 'planner'];
const finance = ['admin', 'finance'];
const entities = ['customers', 'resources', 'products', 'quotes', 'workorders', 'hours', 'reservations', 'movements', 'invoices', 'payments', 'credits', 'outbox', 'audit'];
// Public entity names stay short; every internal table lives in the ops_ namespace.
const scopedSql = sql => sql.replace(/\b(customers|resources|products|quotes|workorders|hours|reservations|movements|invoices|payments|credits|outbox|audit|sequences|idempotency)\b/gu, name => `ops_${name}`);
function shape(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('VALIDATION', 'Expected a plain object');
  if (Object.keys(value).some(k => !allowed.includes(k))) fail('VALIDATION', 'Unknown field');
  if (required.some(k => !own(value, k))) fail('VALIDATION', 'Missing required field');
}
function int(value, name, min = 1, max = 1_000_000_000_000) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('VALIDATION', `Invalid ${name}`);
  return value;
}
function text(value, name, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail('VALIDATION', `Invalid ${name}`);
  return value.trim();
}
function identity(value) {
  if (typeof value === 'number') return String(int(value, 'actor id'));
  return text(value, 'actor id', 128);
}
function day(value, name = 'date') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail('VALIDATION', `Invalid ${name}`);
  return value;
}
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) fail('VALIDATION', 'Expected an ISO timestamp with timezone');
  day(value.slice(0, 10));
  return new Date(value).toISOString();
}
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
function jsonSafe(value) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' || (typeof value === 'number' && !Number.isFinite(value))) fail('VALIDATION', 'Input must be finite JSON');
  if (value && typeof value === 'object') {
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) fail('VALIDATION', 'Input must be plain JSON');
    for (const v of Object.values(value)) jsonSafe(v);
  }
}

/** Transactional ERP domain service. HTTP authentication is the host application's responsibility. */
export class OperationsService {
  #db; #now; #timezone;
  constructor(path, { now = () => new Date().toISOString(), businessTimezone = 'Europe/Amsterdam' } = {}) {
    if (typeof path !== 'string' || !path || typeof now !== 'function') fail('VALIDATION', 'Invalid database configuration');
    try { new Intl.DateTimeFormat('sv-SE', { timeZone: businessTimezone }).format(new Date()); } catch { fail('VALIDATION', 'Invalid business timezone'); }
    this.#timezone = businessTimezone;
    this.#now = now;
    this.#db = new DatabaseSync(path);
    this.#db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
    const settings = this.#db.prepare('SELECT value FROM ops_settings WHERE name=?').get('business_timezone');
    if (settings && settings.value !== businessTimezone) {
      this.#db.close(); fail('CONFLICT', 'Business timezone differs from the existing database');
    }
    this.#db.prepare('INSERT OR IGNORE INTO ops_settings(name,value) VALUES(?,?)').run('business_timezone', businessTimezone);
  }
  close() { this.#db.close(); }
  #time() { return instant(this.#now()); }
  #businessDay(at) { return new Intl.DateTimeFormat('sv-SE', { timeZone: this.#timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at)); }
  #actor(actor, allowed = roles) {
    shape(actor, ['id', 'role'], ['id', 'role']);
    if (!roles.includes(actor.role) || !allowed.includes(actor.role)) fail('FORBIDDEN', 'Operation is not allowed for this role');
    return { id: identity(actor.id), role: actor.role };
  }
  #one(sql, ...params) { return this.#db.prepare(scopedSql(sql)).get(...params); }
  #all(sql, ...params) { return this.#db.prepare(scopedSql(sql)).all(...params); }
  #run(sql, ...params) { return this.#db.prepare(scopedSql(sql)).run(...params); }
  #row(entity, id) {
    int(id, `${entity} id`);
    const row = this.#one(`SELECT * FROM ${entity} WHERE id=?`, id);
    if (!row) fail('NOT_FOUND', `${entity} record not found`);
    return row;
  }
  #decode(entity, row) {
    const result = { ...JSON.parse(row.data), id: row.id };
    if (row.version !== undefined) result.version = row.version;
    if (entity === 'products') Object.assign(result, { stock: row.stock, reserved: row.reserved, available: row.stock - row.reserved });
    if (entity === 'quotes') result.status = row.status;
    if (entity === 'workorders') Object.assign(result, { status: row.status, resourceId: row.resource_id, startAt: row.start_at, endAt: row.end_at, reservations: this.#all('SELECT product_id AS productId,quantity FROM reservations WHERE workorder_id=? ORDER BY product_id', row.id).map(r => ({ ...r })) });
    if (entity === 'invoices') Object.assign(result, this.#balance(row));
    if (entity === 'outbox') result.exportedAt = row.exported_at;
    return result;
  }
  #balance(invoice) {
    const paidCents = this.#one('SELECT COALESCE(SUM(amount_cents),0) AS amount FROM payments WHERE invoice_id=?', invoice.id).amount;
    const creditedCents = this.#one('SELECT COALESCE(SUM(amount_cents),0) AS amount FROM credits WHERE invoice_id=?', invoice.id).amount;
    return { paidCents, creditedCents, balanceCents: invoice.total_cents - paidCents - creditedCents };
  }
  #write(actor, allowed, operation, input, key, callback) {
    const who = this.#actor(actor, allowed);
    text(key, 'idempotency key', 128);
    if (key.length < 8 || !/^[A-Za-z0-9._:-]+$/u.test(key)) fail('VALIDATION', 'Idempotency key must contain 8–128 safe characters');
    jsonSafe(input);
    const serial = canonical({ operation, role: who.role, input });
    if (Buffer.byteLength(serial) > 262_144) fail('VALIDATION', 'Input is too large');
    const fingerprint = createHash('sha256').update(serial).digest('hex');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.#one('SELECT fingerprint,response FROM idempotency WHERE actor_id=? AND key=?', who.id, key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail('CONFLICT', 'Idempotency key was used for a different request');
        this.#db.exec('COMMIT');
        return JSON.parse(previous.response);
      }
      const createdAt = this.#time();
      const result = callback(who, createdAt);
      // Audit intentionally stores operation/record IDs only, never customer or free-text payloads.
      this.#run('INSERT INTO audit(actor_id,operation,created_at,data) VALUES(?,?,?,?)', who.id, operation, createdAt, JSON.stringify({ actorId: who.id, operation, entityId: result.id ?? null, createdAt }));
      this.#run('INSERT INTO idempotency(actor_id,key,fingerprint,response) VALUES(?,?,?,?)', who.id, key, fingerprint, JSON.stringify(result));
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      if (error instanceof DomainError) throw error;
      if (String(error.message).includes('constraint failed')) fail('CONFLICT', 'A database constraint rejected the operation');
      throw error;
    }
  }
  #version(row, version) {
    int(version, 'version');
    if (row.version !== version) fail('CONFLICT', 'Record changed; reload before updating');
  }
  #insert(entity, columns, data) {
    const names = Object.keys(columns);
    const result = this.#run(`INSERT INTO ${entity}(${[...names, 'data'].join(',')}) VALUES(${[...names, 'data'].map(() => '?').join(',')})`, ...Object.values(columns), JSON.stringify(data));
    return this.#decode(entity, this.#row(entity, Number(result.lastInsertRowid)));
  }
  #resource(id) { return this.#row('resources', id); }
  #plan(input, excludeId = 0) {
    const has = ['resourceId', 'startAt', 'endAt'].map(k => own(input, k));
    if (!has.some(Boolean)) return { resourceId: null, startAt: null, endAt: null };
    if (!has.every(Boolean)) fail('VALIDATION', 'Planning needs resourceId, startAt and endAt together');
    this.#resource(input.resourceId);
    const startAt = instant(input.startAt), endAt = instant(input.endAt);
    if (endAt <= startAt || Date.parse(endAt) - Date.parse(startAt) > 7 * 24 * 3600_000) fail('VALIDATION', 'Planning duration must be positive and at most seven days');
    const overlap = this.#one("SELECT id FROM workorders WHERE resource_id=? AND status IN ('planned','active') AND id<>? AND start_at<? AND end_at>? LIMIT 1", input.resourceId, excludeId, endAt, startAt);
    if (overlap) fail('CONFLICT', 'Resource already has an overlapping workorder');
    return { resourceId: input.resourceId, startAt, endAt };
  }
  #accessibleWorkorder(who, row) {
    if (who.role !== 'technician') return;
    if (!row.resource_id || this.#resource(row.resource_id).technician_id !== who.id) fail('FORBIDDEN', 'Workorder is not assigned to this technician');
  }
  #readRole(actor, entity) {
    if (!entities.includes(entity)) fail('VALIDATION', 'Unknown entity');
    const who = this.#actor(actor);
    if (['invoices', 'payments', 'credits', 'outbox'].includes(entity) && !finance.includes(who.role)) fail('FORBIDDEN', 'Financial access is restricted');
    if (entity === 'audit' && who.role !== 'admin') fail('FORBIDDEN', 'Audit access is restricted');
    if (who.role === 'technician' && !['products', 'workorders', 'hours', 'reservations'].includes(entity)) fail('FORBIDDEN', 'Technician access is restricted');
    return who;
  }
  get(actor, entity, id) {
    const who = this.#readRole(actor, entity);
    if (entity === 'reservations') fail('VALIDATION', 'Reservations use composite IDs; list or read the workorder');
    const row = this.#row(entity, id);
    if (entity === 'workorders') this.#accessibleWorkorder(who, row);
    if (entity === 'hours' && who.role === 'technician' && row.technician_id !== who.id) fail('FORBIDDEN', 'Hours belong to another technician');
    return this.#decode(entity, row);
  }
  list(actor, entity, options = {}) {
    const who = this.#readRole(actor, entity);
    shape(options, ['limit', 'offset']);
    const limit = own(options, 'limit') ? int(options.limit, 'limit', 1, 100) : 100;
    const offset = own(options, 'offset') ? int(options.offset, 'offset', 0, 1_000_000) : 0;
    if (entity === 'reservations') {
      const where = who.role === 'technician' ? 'WHERE workorder_id IN (SELECT w.id FROM workorders w JOIN resources r ON r.id=w.resource_id WHERE r.technician_id=?)' : '';
      return this.#all(`SELECT workorder_id AS workorderId,product_id AS productId,quantity FROM reservations ${where} ORDER BY workorder_id,product_id LIMIT ? OFFSET ?`, ...(who.role === 'technician' ? [who.id] : []), limit, offset).map(r => ({ ...r }));
    }
    let where = '', params = [];
    if (who.role === 'technician' && entity === 'workorders') { where = 'WHERE resource_id IN (SELECT id FROM resources WHERE technician_id=?)'; params = [who.id]; }
    if (who.role === 'technician' && entity === 'hours') { where = 'WHERE technician_id=?'; params = [who.id]; }
    return this.#all(`SELECT * FROM ${entity} ${where} ORDER BY id LIMIT ? OFFSET ?`, ...params, limit, offset).map(row => this.#decode(entity, row));
  }
  createCustomer(actor, input, key) {
    return this.#write(actor, ops, 'customer.create', input, key, (_, createdAt) => {
      shape(input, ['name', 'email', 'type'], ['name', 'type']);
      const name = text(input.name, 'name', 200);
      if (!['b2b', 'b2c'].includes(input.type)) fail('VALIDATION', 'Customer type must be b2b or b2c');
      const data = { name, type: input.type, createdAt };
      if (own(input, 'email')) { data.email = text(input.email, 'email', 254); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(data.email)) fail('VALIDATION', 'Invalid email'); }
      return this.#insert('customers', { version: 1 }, data);
    });
  }
  createResource(actor, input, key) {
    return this.#write(actor, ops, 'resource.create', input, key, (_, createdAt) => {
      shape(input, ['name', 'technicianId'], ['name', 'technicianId']);
      const technicianId = identity(input.technicianId);
      if (this.#one('SELECT id FROM resources WHERE technician_id=?', technicianId)) fail('CONFLICT', 'Technician already has a planning resource');
      return this.#insert('resources', { version: 1, technician_id: technicianId }, { name: text(input.name, 'name', 200), technicianId, createdAt });
    });
  }
  createProduct(actor, input, key) {
    return this.#write(actor, ops, 'product.create', input, key, (_, createdAt) => {
      shape(input, ['name', 'sku', 'unitCents', 'vatBasisPoints', 'stock'], ['name', 'sku', 'unitCents', 'vatBasisPoints', 'stock']);
      const data = { name: text(input.name, 'name', 200), sku: text(input.sku, 'sku', 80), unitCents: int(input.unitCents, 'unitCents', 0, 100_000_000), vatBasisPoints: int(input.vatBasisPoints, 'vatBasisPoints', 0, 10_000), createdAt };
      const product = this.#insert('products', { version: 1, sku: data.sku, stock: int(input.stock, 'stock', 0, 1_000_000), reserved: 0 }, data);
      if (product.stock) this.#movement(product.id, null, 'opening', product.stock, createdAt);
      return product;
    });
  }
  #movement(productId, workorderId, kind, quantity, createdAt, extra = {}) {
    return this.#insert('movements', { product_id: productId, workorder_id: workorderId }, { productId, workorderId, kind, quantity, createdAt, ...extra });
  }
  adjustStock(actor, input, key) {
    return this.#write(actor, ops, 'stock.adjust', input, key, (_, createdAt) => {
      shape(input, ['productId', 'delta', 'reason'], ['productId', 'delta', 'reason']);
      const product = this.#row('products', input.productId);
      const delta = int(input.delta, 'delta', -1_000_000, 1_000_000);
      if (!delta) fail('VALIDATION', 'Stock delta must be nonzero');
      if (product.stock + delta < product.reserved || product.stock + delta > 1_000_000) fail('CONFLICT', 'Stock adjustment would violate stock or reservations');
      const reason = text(input.reason, 'reason');
      this.#run('UPDATE products SET stock=stock+?,version=version+1 WHERE id=?', delta, product.id);
      return this.#movement(product.id, null, 'adjust', delta, createdAt, { reason });
    });
  }
  #lines(lines) {
    if (!Array.isArray(lines) || !lines.length || lines.length > 100) fail('VALIDATION', 'Quote needs 1–100 lines');
    let net = 0n, vat = 0n;
    const result = lines.map(line => {
      shape(line, ['description', 'unitCents', 'quantityMilli', 'vatBasisPoints', 'productId'], ['description', 'unitCents', 'quantityMilli', 'vatBasisPoints']);
      const description = text(line.description, 'description');
      const unitCents = int(line.unitCents, 'unitCents', 0, 100_000_000);
      const quantityMilli = int(line.quantityMilli, 'quantityMilli', 1, 1_000_000);
      const vatBasisPoints = int(line.vatBasisPoints, 'vatBasisPoints', 0, 10_000);
      const netLine = (BigInt(unitCents) * BigInt(quantityMilli) + 500n) / 1000n;
      const vatLine = (netLine * BigInt(vatBasisPoints) + 5000n) / 10000n;
      net += netLine; vat += vatLine;
      const data = { description, unitCents, quantityMilli, vatBasisPoints, netCents: Number(netLine), vatCents: Number(vatLine), totalCents: Number(netLine + vatLine) };
      if (own(line, 'productId')) { this.#row('products', line.productId); data.productId = line.productId; }
      return data;
    });
    if (net + vat > 1_000_000_000_000n) fail('VALIDATION', 'Quote total exceeds the supported limit');
    return { lines: result, netCents: Number(net), vatCents: Number(vat), totalCents: Number(net + vat) };
  }
  createQuote(actor, input, key) {
    return this.#write(actor, ops, 'quote.create', input, key, (_, createdAt) => {
      shape(input, ['customerId', 'lines'], ['customerId', 'lines']);
      this.#row('customers', input.customerId);
      return this.#insert('quotes', { version: 1, customer_id: input.customerId, status: 'draft' }, { customerId: input.customerId, ...this.#lines(input.lines), createdAt });
    });
  }
  transitionQuote(actor, id, status, version, key) {
    return this.#write(actor, ops, 'quote.transition', { id, status, version }, key, () => {
      const row = this.#row('quotes', id); this.#version(row, version);
      const transitions = { draft: ['sent'], sent: ['accepted', 'rejected'], accepted: [], rejected: [] };
      if (!own(transitions, status) || !transitions[row.status].includes(status)) fail('CONFLICT', 'Invalid quote status transition');
      this.#run('UPDATE quotes SET status=?,version=version+1 WHERE id=?', status, id);
      return this.#decode('quotes', this.#row('quotes', id));
    });
  }
  createWorkorderFromQuote(actor, quoteId, input, key) {
    return this.#write(actor, ops, 'workorder.create', { quoteId, ...input }, key, (_, createdAt) => {
      shape(input, ['resourceId', 'startAt', 'endAt']);
      const quote = this.#row('quotes', quoteId);
      if (quote.status !== 'accepted') fail('CONFLICT', 'Workorder requires an accepted quote');
      const existing = this.#one('SELECT * FROM workorders WHERE quote_id=?', quoteId);
      if (existing) fail('CONFLICT', 'This quote already has a workorder');
      const plan = this.#plan(input);
      return this.#insert('workorders', { version: 1, quote_id: quote.id, customer_id: quote.customer_id, resource_id: plan.resourceId, start_at: plan.startAt, end_at: plan.endAt, status: 'planned' }, { quoteId, customerId: quote.customer_id, createdAt });
    });
  }
  scheduleWorkorder(actor, id, input, version, key) {
    return this.#write(actor, ops, 'workorder.schedule', { id, input, version }, key, () => {
      shape(input, ['resourceId', 'startAt', 'endAt'], ['resourceId', 'startAt', 'endAt']);
      const row = this.#row('workorders', id); this.#version(row, version);
      if (!['planned', 'active'].includes(row.status)) fail('CONFLICT', 'Completed or cancelled workorder cannot be rescheduled');
      const plan = this.#plan(input, id);
      this.#run('UPDATE workorders SET resource_id=?,start_at=?,end_at=?,version=version+1 WHERE id=?', plan.resourceId, plan.startAt, plan.endAt, id);
      return this.#decode('workorders', this.#row('workorders', id));
    });
  }
  transitionWorkorder(actor, id, status, version, key) {
    return this.#write(actor, ops, 'workorder.transition', { id, status, version }, key, (_, createdAt) => {
      const row = this.#row('workorders', id); this.#version(row, version);
      const transitions = { planned: ['active', 'cancelled'], active: ['done', 'cancelled'], done: [], cancelled: [] };
      if (!own(transitions, status) || !transitions[row.status].includes(status)) fail('CONFLICT', 'Invalid workorder status transition');
      const reservations = this.#all('SELECT * FROM reservations WHERE workorder_id=?', id);
      if (status === 'done' && reservations.length) fail('CONFLICT', 'Consume or release reserved stock before completing the workorder');
      if (status === 'cancelled') for (const r of reservations) {
        this.#run('UPDATE products SET reserved=reserved-?,version=version+1 WHERE id=?', r.quantity, r.product_id);
        this.#movement(r.product_id, id, 'release', r.quantity, createdAt);
      }
      if (status === 'cancelled') this.#run('DELETE FROM reservations WHERE workorder_id=?', id);
      this.#run('UPDATE workorders SET status=?,version=version+1 WHERE id=?', status, id);
      return this.#decode('workorders', this.#row('workorders', id));
    });
  }
  recordHours(actor, input, key) {
    return this.#write(actor, [...ops, 'technician'], 'hours.record', input, key, (who, createdAt) => {
      shape(input, ['workorderId', 'minutes', 'date', 'note'], ['workorderId', 'minutes', 'date']);
      const workorder = this.#row('workorders', input.workorderId); this.#accessibleWorkorder(who, workorder);
      if (workorder.status !== 'active') fail('CONFLICT', 'Hours require an active workorder');
      const minutes = int(input.minutes, 'minutes', 1, 1440), date = day(input.date);
      if (date > this.#businessDay(createdAt)) fail('VALIDATION', 'Hours cannot be recorded for a future date');
      const total = this.#one("SELECT COALESCE(SUM(CAST(json_extract(data,'$.minutes') AS INTEGER)),0) AS minutes FROM hours WHERE technician_id=? AND json_extract(data,'$.date')=?", who.id, date).minutes;
      if (total + minutes > 1440) fail('CONFLICT', 'Recorded hours exceed 24 hours for this actor and day');
      const data = { workorderId: workorder.id, technicianId: who.id, minutes, date, createdAt };
      if (own(input, 'note')) data.note = text(input.note, 'note');
      return this.#insert('hours', { workorder_id: workorder.id, technician_id: who.id }, data);
    });
  }
  #inventory(actor, input, key, mode) {
    const consume = mode === 'consume', release = mode === 'release';
    return this.#write(actor, consume ? [...ops, 'technician'] : ops, `inventory.${mode}`, input, key, (who, createdAt) => {
      shape(input, ['workorderId', 'productId', 'quantity'], ['workorderId', 'productId', 'quantity']);
      const workorder = this.#row('workorders', input.workorderId), product = this.#row('products', input.productId);
      this.#accessibleWorkorder(who, workorder);
      if (!['planned', 'active'].includes(workorder.status)) fail('CONFLICT', 'Inventory requires a planned or active workorder');
      const quantity = int(input.quantity, 'quantity', 1, 1_000_000);
      const reserved = this.#one('SELECT quantity FROM reservations WHERE workorder_id=? AND product_id=?', workorder.id, product.id)?.quantity ?? 0;
      if (consume || release) {
        if (quantity > reserved || quantity > product.stock) fail('CONFLICT', 'Consumption exceeds reserved stock');
        this.#run('UPDATE products SET stock=stock-?,reserved=reserved-?,version=version+1 WHERE id=?', consume ? quantity : 0, quantity, product.id);
        if (quantity === reserved) this.#run('DELETE FROM reservations WHERE workorder_id=? AND product_id=?', workorder.id, product.id);
        else this.#run('UPDATE reservations SET quantity=quantity-? WHERE workorder_id=? AND product_id=?', quantity, workorder.id, product.id);
      } else {
        if (quantity > product.stock - product.reserved) fail('CONFLICT', 'Insufficient available stock');
        this.#run('UPDATE products SET reserved=reserved+?,version=version+1 WHERE id=?', quantity, product.id);
        this.#run('INSERT INTO reservations(workorder_id,product_id,quantity) VALUES(?,?,?) ON CONFLICT(workorder_id,product_id) DO UPDATE SET quantity=quantity+excluded.quantity', workorder.id, product.id, quantity);
      }
      return this.#movement(product.id, workorder.id, mode, quantity, createdAt);
    });
  }
  reserveInventory(actor, input, key) { return this.#inventory(actor, input, key, 'reserve'); }
  consumeInventory(actor, input, key) { return this.#inventory(actor, input, key, 'consume'); }
  releaseInventory(actor, input, key) { return this.#inventory(actor, input, key, 'release'); }
  #number(prefix, createdAt) {
    const year = Number(this.#businessDay(createdAt).slice(0, 4));
    this.#run('INSERT INTO sequences(name,year,value) VALUES(?,?,1) ON CONFLICT(name,year) DO UPDATE SET value=value+1', prefix, year);
    const value = this.#one('SELECT value FROM sequences WHERE name=? AND year=?', prefix, year).value;
    return `${prefix}-${year}-${String(value).padStart(6, '0')}`;
  }
  #event(eventType, entityId, payload, createdAt) {
    return this.#insert('outbox', { event_type: eventType, entity_id: entityId, exported_at: null }, { eventType, entityId, payload, createdAt });
  }
  issueInvoice(actor, input, key) {
    return this.#write(actor, finance, 'invoice.issue', input, key, (_, createdAt) => {
      shape(input, ['quoteId', 'workorderId', 'dueDate'], ['quoteId', 'dueDate']);
      const quote = this.#row('quotes', input.quoteId);
      if (quote.status !== 'accepted') fail('CONFLICT', 'Invoice requires an accepted quote');
      let workorderId = null;
      if (own(input, 'workorderId')) {
        const workorder = this.#row('workorders', input.workorderId);
        if (workorder.quote_id !== quote.id || workorder.customer_id !== quote.customer_id) fail('CONFLICT', 'Workorder and quote must belong to the same customer and quote');
        if (workorder.status !== 'done') fail('CONFLICT', 'Workorder must be completed before invoicing');
        workorderId = workorder.id;
      }
      if (workorderId === null) {
        const linked = this.#one('SELECT * FROM workorders WHERE quote_id=?', quote.id);
        if (linked) {
          if (linked.status !== 'done') fail('CONFLICT', 'Linked workorder must be completed before invoicing');
          workorderId = linked.id;
        }
      }
      if (this.#one('SELECT id FROM invoices WHERE quote_id=?', quote.id)) fail('CONFLICT', 'This quote already has an invoice');
      const dueDate = day(input.dueDate, 'dueDate');
      const issuedDate = this.#businessDay(createdAt);
      if (dueDate < issuedDate) fail('VALIDATION', 'Due date precedes invoice date');
      const snapshot = JSON.parse(quote.data), customer = this.#decode('customers', this.#row('customers', quote.customer_id));
      const number = this.#number('INV', createdAt);
      const invoice = this.#insert('invoices', { quote_id: quote.id, customer_id: quote.customer_id, workorder_id: workorderId, number, total_cents: snapshot.totalCents }, { quoteId: quote.id, customerId: quote.customer_id, customerSnapshot: customer, workorderId, number, dueDate, issuedDate, issuedAt: createdAt, businessTimezone: this.#timezone, lines: snapshot.lines, netCents: snapshot.netCents, vatCents: snapshot.vatCents, totalCents: snapshot.totalCents });
      this.#event('invoice.issued', invoice.id, invoice, createdAt);
      return invoice;
    });
  }
  recordPayment(actor, input, key) {
    return this.#write(actor, finance, 'payment.record', input, key, (_, createdAt) => {
      shape(input, ['invoiceId', 'amountCents', 'reference'], ['invoiceId', 'amountCents', 'reference']);
      const invoice = this.#row('invoices', input.invoiceId), amountCents = int(input.amountCents, 'amountCents');
      if (amountCents > this.#balance(invoice).balanceCents) fail('CONFLICT', 'Payment exceeds outstanding balance');
      const reference = text(input.reference, 'reference', 200);
      if (this.#one('SELECT id FROM payments WHERE invoice_id=? AND reference=?', invoice.id, reference)) fail('CONFLICT', 'Payment reference already recorded for this invoice');
      const payment = this.#insert('payments', { invoice_id: invoice.id, amount_cents: amountCents, reference }, { invoiceId: invoice.id, amountCents, reference, createdAt });
      this.#event('payment.recorded', payment.id, payment, createdAt);
      return payment;
    });
  }
  issueCreditNote(actor, input, key) {
    return this.#write(actor, finance, 'credit.issue', input, key, (_, createdAt) => {
      shape(input, ['invoiceId', 'amountCents', 'reason'], ['invoiceId', 'amountCents', 'reason']);
      const invoice = this.#row('invoices', input.invoiceId), amountCents = int(input.amountCents, 'amountCents');
      if (amountCents > this.#balance(invoice).balanceCents) fail('CONFLICT', 'Credit exceeds unpaid balance; refunds require a separate workflow');
      const number = this.#number('CRN', createdAt);
      const credit = this.#insert('credits', { invoice_id: invoice.id, amount_cents: amountCents, number }, { invoiceId: invoice.id, invoiceNumber: invoice.number, number, amountCents, reason: text(input.reason, 'reason'), createdAt });
      this.#event('credit.issued', credit.id, credit, createdAt);
      return credit;
    });
  }
  exportBookkeeping(actor, options = {}) {
    this.#actor(actor, finance);
    return { generatedAt: this.#time(), entries: this.list(actor, 'outbox', options) };
  }
}
