// SPDX-License-Identifier: GPL-3.0-or-later
/** Pure projection of an explicitly configured WooCommerce product snapshot. */
export class ImportPlanError extends Error {
  constructor(code) { super(code); this.name = 'ImportPlanError'; this.code = code; }
}
const reject = code => { throw new ImportPlanError(code); };
function object(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) reject('INVALID_OBJECT');
}
function field(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) reject('MISSING_OR_ACCESSOR_FIELD');
  return descriptor.value;
}
function integer(value, max, code) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) reject(code);
  return value;
}
function plainText(value, max, code) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[<>\p{Cc}\p{Cf}]|&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);?/iu.test(value)) reject(code);
  return value.trim();
}
/** Decimal EUR only: no floating-point multiplication, rounding, or exponent syntax. */
export function decimalEuroToCents(value) {
  if (typeof value !== 'string' || value.length > 12 || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u.test(value)) reject('INVALID_PRICE');
  const [whole, fraction = ''] = value.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > 100_000_000n) reject('PRICE_OUT_OF_RANGE');
  return Number(cents);
}

/** Returns proposals, never writes, calls a service, authenticates, or fetches. */
export function planProductImport(config, products) {
  object(config);
  if (Object.keys(config).some(key => !['siteOrigin', 'currency', 'pricesIncludeTax', 'taxClasses'].includes(key))) reject('UNKNOWN_CONFIGURATION');
  const origin = field(config, 'siteOrigin');
  if (typeof origin !== 'string' || origin.length > 2048 || /[\s\\]/u.test(origin) || !/^https:\/\/[^/?#]+\/?$/iu.test(origin)) reject('INVALID_SITE_ORIGIN');
  let site;
  try { site = new URL(origin); } catch { reject('INVALID_SITE_ORIGIN'); }
  if (site.protocol !== 'https:' || site.username || site.password || site.search || site.hash || site.pathname !== '/' || site.origin === 'null') reject('INVALID_SITE_ORIGIN');
  if (field(config, 'currency') !== 'EUR') reject('UNSUPPORTED_CURRENCY');
  if (field(config, 'pricesIncludeTax') !== false) reject('NET_PRICES_REQUIRED');
  const taxClasses = field(config, 'taxClasses');
  object(taxClasses);
  for (const key of Object.keys(taxClasses)) {
    if (key.length > 80 || !/^[a-z0-9-]*$/u.test(key)) reject('INVALID_TAX_CLASS');
    integer(field(taxClasses, key), 10_000, 'INVALID_TAX_RATE');
  }
  if (!Array.isArray(products) || products.length > 100) reject('INVALID_BATCH');
  const ids = new Set(), skus = new Set();
  return Array.from({ length: products.length }, (_, index) => {
    const product = field(products, String(index));
    object(product);
    const id = integer(field(product, 'id'), Number.MAX_SAFE_INTEGER, 'INVALID_PRODUCT_ID');
    if (id === 0) reject('INVALID_PRODUCT_ID');
    if (field(product, 'type') !== 'simple') reject('UNSUPPORTED_PRODUCT_TYPE');
    if (field(product, 'manage_stock') !== true) reject('MANAGED_STOCK_REQUIRED');
    if (field(product, 'backorders') !== 'no') reject('BACKORDERS_UNSUPPORTED');
    if (field(product, 'tax_status') !== 'taxable') reject('UNSUPPORTED_TAX_STATUS');
    const taxClass = field(product, 'tax_class');
    if (typeof taxClass !== 'string' || !Object.hasOwn(taxClasses, taxClass)) reject('UNMAPPED_TAX_CLASS');
    const name = plainText(field(product, 'name'), 200, 'INVALID_NAME');
    const sku = plainText(field(product, 'sku'), 80, 'INVALID_SKU');
    if (ids.has(id) || skus.has(sku)) reject('DUPLICATE_SOURCE_OR_SKU');
    ids.add(id); skus.add(sku);
    return {
      operation: 'createProduct',
      source: { provider: 'woocommerce', siteOrigin: site.origin, productId: id },
      input: {
        name, sku,
        unitCents: decimalEuroToCents(field(product, 'price')),
        vatBasisPoints: field(taxClasses, taxClass),
        stock: integer(field(product, 'stock_quantity'), 1_000_000, 'INVALID_STOCK')
      }
    };
  });
}
