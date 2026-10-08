// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { decimalEuroToCents, planProductImport, ImportPlanError } from './planner.mjs';
import { OperationsService } from '../../modules/service-operations/engine.mjs';
const config = () => ({ siteOrigin: 'https://winkel.example.test', currency: 'EUR', pricesIncludeTax: false, taxClasses: { '': 2100, reduced: 900, zero: 0 } });
const product = (extra = {}) => ({ id: 42, name: 'Koperen buis', sku: 'BUIS-42', type: 'simple', manage_stock: true, stock_quantity: 4, backorders: 'no', tax_status: 'taxable', tax_class: '', price: '12.35', ...extra });
const rejects = (fn, code) => assert.throws(fn, error => error instanceof ImportPlanError && error.code === code);
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

test('frozen source projects only ERP fields and separate canonical site/id mapping', () => {
  const source = freeze([product({ description: '<script>secret</script>', meta_data: [{ key: 'private', value: 'do-not-copy' }], customer: { email: 'private@example.test' }, price_html: '<b>12.35</b>' })]);
  const settings = freeze({ ...config(), siteOrigin: 'https://WINKEL.example.test:443/' });
  const before = JSON.stringify({ source, settings });
  const result = planProductImport(settings, source);
  assert.deepEqual(result, [{ operation: 'createProduct', source: { provider: 'woocommerce', siteOrigin: 'https://winkel.example.test', productId: 42 }, input: { name: 'Koperen buis', sku: 'BUIS-42', unitCents: 1235, vatBasisPoints: 2100, stock: 4 } }]);
  assert.equal(JSON.stringify({ source, settings }), before);
  assert.doesNotMatch(JSON.stringify(result), /private|secret|meta_data|description|price_html/);
});

test('actual OperationsService accepts planner output including upper engine bounds', () => {
  const service = new OperationsService(':memory:');
  try {
    const proposals = planProductImport(config(), [product({ name: 'N'.repeat(200), sku: 'S'.repeat(80), price: '1000000.00', stock_quantity: 1_000_000, tax_class: 'zero' })]);
    const saved = service.createProduct({ id: 'import-worker', role: 'admin' }, proposals[0].input, 'import-42-0001');
    assert.equal(saved.unitCents, 100_000_000); assert.equal(saved.stock, 1_000_000); assert.equal(saved.vatBasisPoints, 0);
    assert.equal(service.createProduct({ id: 'import-worker', role: 'admin' }, proposals[0].input, 'import-42-0001').id, saved.id);
  } finally { service.close(); }
});

test('exact decimal cents: boundaries and fractions without rounding', () => {
  for (const [input, cents] of [['0', 0], ['0.01', 1], ['0.1', 10], ['19.99', 1999], ['1000000', 100_000_000]]) assert.equal(decimalEuroToCents(input), cents);
  for (const input of [0.1, '', '-1', '+1', '01', '1e2', '1,20', '1.', '1.001', ' 1.20', 'Infinity', '99999999999999']) rejects(() => decimalEuroToCents(input), 'INVALID_PRICE');
  rejects(() => decimalEuroToCents('1000000.01'), 'PRICE_OUT_OF_RANGE');
});

test('origin identifies separate stores; rejects credentials, paths, insecure and malformed origins', () => {
  assert.notDeepEqual(planProductImport(config(), [product()])[0].source, planProductImport({ ...config(), siteOrigin: 'https://second.example.test' }, [product()])[0].source);
  for (const siteOrigin of ['http://winkel.example.test', 'https://user:pass@winkel.example.test', 'https://winkel.example.test/shop', 'https://winkel.example.test/.', 'https://winkel.example.test/a/..', 'https://winkel.example.test/?token=private', 'https://winkel.example.test/#a', 'https://winkel.example.test\\a', ' https://winkel.example.test', 'not-a-url']) rejects(() => planProductImport({ ...config(), siteOrigin }, [product()]), 'INVALID_SITE_ORIGIN');
});

test('currency/net-tax configuration required explicitly; no automatic gross conversion', () => {
  rejects(() => planProductImport({ ...config(), currency: 'USD' }, [product()]), 'UNSUPPORTED_CURRENCY');
  for (const pricesIncludeTax of [true, 'false', null]) rejects(() => planProductImport({ ...config(), pricesIncludeTax }, [product()]), 'NET_PRICES_REQUIRED');
  const missing = config(); delete missing.pricesIncludeTax;
  rejects(() => planProductImport(missing, [product()]), 'MISSING_OR_ACCESSOR_FIELD');
  rejects(() => planProductImport({ ...config(), apiKey: 'private' }, [product()]), 'UNKNOWN_CONFIGURATION');
});

test('explicit own tax class mapping only, bounded integer VAT', () => {
  assert.equal(planProductImport(config(), [product({ tax_class: 'reduced' })])[0].input.vatBasisPoints, 900);
  rejects(() => planProductImport(config(), [product({ tax_class: 'toString' })]), 'UNMAPPED_TAX_CLASS');
  for (const tax_status of ['none', 'shipping', undefined]) rejects(() => planProductImport(config(), [product({ tax_status })]), 'UNSUPPORTED_TAX_STATUS');
  for (const value of [-1, 10_001, 2100.1, '2100']) rejects(() => planProductImport({ ...config(), taxClasses: { '': value } }, [product()]), 'INVALID_TAX_RATE');
});

test('rejects unsupported types, unmanaged inventory, fractional/negative stock and backorders', () => {
  for (const type of ['variable', 'variation', 'grouped', 'external']) rejects(() => planProductImport(config(), [product({ type })]), 'UNSUPPORTED_PRODUCT_TYPE');
  for (const manage_stock of [false, 'true', null]) rejects(() => planProductImport(config(), [product({ manage_stock })]), 'MANAGED_STOCK_REQUIRED');
  for (const stock_quantity of [-1, 1.5, 1_000_001, '4', null]) rejects(() => planProductImport(config(), [product({ stock_quantity })]), 'INVALID_STOCK');
  for (const backorders of ['yes', 'notify', undefined]) rejects(() => planProductImport(config(), [product({ backorders })]), 'BACKORDERS_UNSUPPORTED');
});

test('rejects unsafe text, controls, encoded markup and oversized ERP fields', () => {
  for (const name of ['<b>Buis</b>', '&#60;script&#62;', '&#60script', '&lt;b&gt;', '&ltb', 'ab\ncd', 'ab\u202ecd', '', ' ', 'N'.repeat(201)]) rejects(() => planProductImport(config(), [product({ name })]), 'INVALID_NAME');
  for (const sku of ['', 'S'.repeat(81), '<sku>', 'a\tb']) rejects(() => planProductImport(config(), [product({ sku })]), 'INVALID_SKU');
  assert.equal(planProductImport(config(), [product({ name: '  Buis & koppeling  ' })])[0].input.name, 'Buis & koppeling');
});

test('batch max100, unique source IDs and trimmed SKU; no partial proposal on invalid batch', () => {
  assert.deepEqual(planProductImport(config(), []), []);
  assert.equal(planProductImport(config(), Array.from({ length: 100 }, (_, i) => product({ id: i + 1, sku: `P-${i}` }))).length, 100);
  rejects(() => planProductImport(config(), Array(101).fill(product())), 'INVALID_BATCH');
  rejects(() => planProductImport(config(), [product(), product({ sku: 'OTHER' })]), 'DUPLICATE_SOURCE_OR_SKU');
  rejects(() => planProductImport(config(), [product(), product({ id: 43, sku: '  BUIS-42  ' })]), 'DUPLICATE_SOURCE_OR_SKU');
  for (const id of [0, -1, 1.1, '42', Number.MAX_SAFE_INTEGER + 1]) rejects(() => planProductImport(config(), [product({ id })]), 'INVALID_PRODUCT_ID');
});

test('required fields are own data, sparse batches/accessors cannot execute code', () => {
  rejects(() => planProductImport(config(), new Array(1)), 'MISSING_OR_ACCESSOR_FIELD');
  let called = false;
  const record = product(); Object.defineProperty(record, 'name', { get() { called = true; return 'bad'; } });
  rejects(() => planProductImport(config(), [record]), 'MISSING_OR_ACCESSOR_FIELD'); assert.equal(called, false);
  const records = []; Object.defineProperty(records, '0', { get() { called = true; return product(); } });
  rejects(() => planProductImport(config(), records), 'MISSING_OR_ACCESSOR_FIELD'); assert.equal(called, false);
  rejects(() => planProductImport(config(), [Object.create(product())]), 'INVALID_OBJECT');
});
