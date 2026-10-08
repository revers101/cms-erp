// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ContentService } from './engine.mjs';
import { createContentHandler } from './http.mjs';

const origin = 'https://cms.example.test';
const content = {
  type: 'page', title: 'Over ons', slug: 'over-ons', summary: '',
  blocks: [{ type: 'paragraph', text: 'Een openbaar voorbeeld.' }],
  seoTitle: 'Over ons', seoDescription: '',
};

function fixture(options = {}) {
  const calls = [];
  let actor = { id: 7, role: 'admin' };
  const service = {
    listPublished(...args) { calls.push(['listPublished', ...args]); return []; },
    getPublished(...args) { calls.push(['getPublished', ...args]); return null; },
    listManaged(...args) { calls.push(['listManaged', ...args]); return []; },
    getManaged(...args) { calls.push(['getManaged', ...args]); return { id: args[1] }; },
    listRevisions(...args) { calls.push(['listRevisions', ...args]); return []; },
    createContent(...args) { calls.push(['createContent', ...args]); return { id: 1 }; },
    updateContent(...args) { calls.push(['updateContent', ...args]); return { id: args[1] }; },
    submitForReview(...args) { calls.push(['submitForReview', ...args]); return { id: args[1] }; },
    returnForChanges(...args) { calls.push(['returnForChanges', ...args]); return { id: args[1] }; },
    publishContent(...args) { calls.push(['publishContent', ...args]); return { id: args[1] }; },
    archiveContent(...args) { calls.push(['archiveContent', ...args]); return { id: args[1] }; },
  };
  const handler = createContentHandler({
    service,
    allowedOrigin: origin,
    resolveActor: async () => actor,
    verifyCsrf: async () => true,
    ...options,
  });
  async function request(method, url, body, headers = {}) {
    const req = Readable.from(body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]);
    Object.assign(req, {
      method,
      url,
      headers: { 'content-type': 'application/json', origin, 'idempotency-key': 'content-test-001', ...headers },
    });
    const res = {
      writeHead(status, responseHeaders) { this.status = status; this.headers = responseHeaders; },
      end(value) { this.body = JSON.parse(value); },
    };
    const handled = await handler(req, res);
    return { handled, req, ...res };
  }
  return { calls, handler, request, setActor(value) { actor = value; } };
}

test('unrelated routes pass through and public reads never resolve an actor', async () => {
  let actorLookups = 0;
  const f = fixture({ resolveActor: () => { actorLookups += 1; return { id: 1, role: 'admin' }; } });
  assert.equal((await f.request('GET', '/api/operations/customers')).handled, false);
  assert.equal((await f.request('GET', '/api/content/public?limit=10')).status, 200);
  assert.equal(actorLookups, 0);
});

test('public routes expose only published lookup operations and reject unknown query parameters', async () => {
  const f = fixture();
  assert.equal((await f.request('GET', '/api/content/public/over-ons')).status, 404);
  assert.equal((await f.request('GET', '/api/content/public?limit=2&type=page')).status, 200);
  assert.deepEqual(f.calls.at(-1), ['listPublished', { limit: 2, type: 'page' }]);
  for (const query of ['type=unknown', 'limit=0', 'limit=2&limit=3', 'all=true', 'offset=-1']) {
    assert.equal((await f.request('GET', `/api/content/public?${query}`)).status, 400);
  }
});

test('management reads use the resolved session and ignore client identity headers', async () => {
  const f = fixture();
  const result = await f.request('GET', '/api/content/items/8', undefined, { 'x-user-id': '999', 'x-role': 'reader' });
  assert.equal(result.status, 200);
  assert.deepEqual(f.calls[0], ['getManaged', { id: 7, role: 'admin' }, 8]);
});

test('anonymous, malformed and unsupported actors cannot access management routes', async () => {
  for (const actor of [null, { id: 0, role: 'admin' }, { id: 1, role: 'owner' }]) {
    const f = fixture({ resolveActor: () => actor });
    assert.equal((await f.request('GET', '/api/content/items')).status, 401);
    assert.equal(f.calls.length, 0);
  }
});

test('writes require exact origin, literal boolean CSRF success and a stable idempotency key', async () => {
  for (const csrf of [false, 'true', 1, null]) {
    const f = fixture({ verifyCsrf: () => csrf });
    assert.equal((await f.request('POST', '/api/content/commands/create', { content })).status, 403);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  assert.equal((await f.request('POST', '/api/content/commands/create', { content }, { origin: undefined })).status, 403);
  assert.equal((await f.request('POST', '/api/content/commands/create', { content }, { 'idempotency-key': 'short' })).status, 400);
  assert.equal((await f.request('POST', '/api/content/commands/create', { content })).status, 200);
  assert.deepEqual(f.calls[0], ['createContent', { id: 7, role: 'admin' }, content, 'content-test-001']);
});

test('command schemas and status/version references are strict', async () => {
  const f = fixture();
  for (const command of ['constructor', '__proto__', 'delete', 'list']) {
    assert.equal((await f.request('POST', `/api/content/commands/${command}`, {})).status, 404);
  }
  assert.equal((await f.request('POST', '/api/content/commands/update', { id: null, version: 1, content })).status, 400);
  assert.equal((await f.request('POST', '/api/content/commands/publish', { id: 1, version: 0 })).status, 400);
  assert.equal((await f.request('POST', '/api/content/commands/archive', { id: 1, version: 1, role: 'admin' })).status, 400);
  assert.equal((await f.request('POST', '/api/content/commands/submit-review', { id: 1, version: 1 })).status, 200);
  assert.equal((await f.request('POST', '/api/content/commands/return-for-changes', { id: 1, version: 1 })).status, 200);
  assert.deepEqual(f.calls.map((call) => call[0]), ['submitForReview', 'returnForChanges']);
});

test('body size, JSON type and malformed payloads are rejected before service invocation', async () => {
  const f = fixture({ maxBytes: 128 });
  assert.equal((await f.request('POST', '/api/content/commands/create', {}, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await f.request('POST', '/api/content/commands/create', {}, { 'content-length': '129' })).status, 413);
  for (const body of ['{', 'null', '[]', '1']) {
    assert.equal((await f.request('POST', '/api/content/commands/create', body)).status, 400);
  }
  assert.equal(f.calls.length, 0);
});

test('cross-origin requests and unsafe configuration are rejected', async () => {
  const f = fixture();
  assert.equal((await f.request('GET', '/api/content/public?limit=1', undefined, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('GET', 'https://evil.example/api/content/public')).status, 403);
  for (const allowedOrigin of ['http://cms.example.test', 'https://cms.example.test/', 'https://user:pass@cms.example.test']) {
    assert.throws(() => fixture({ allowedOrigin }));
  }
});

test('service errors do not expose SQL or internal text to clients', async () => {
  const logged = [];
  const f = fixture({
    service: { getPublished() { throw new Error('SQL password=private'); } },
    onError: (event) => logged.push(event),
  });
  const result = await f.request('GET', '/api/content/public/over-ons');
  assert.equal(result.status, 500);
  assert.equal(result.body.error, 'INTERNAL_ERROR');
  assert.doesNotMatch(JSON.stringify(result.body), /password|SQL/);
  assert.deepEqual(Object.keys(logged[0]).sort(), ['code', 'requestId']);
});

test('real adapter and SQLite service complete a draft-review-publish-public-read flow', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cms-content-http-'));
  const service = new ContentService(join(directory, 'content.sqlite'));
  t.after(() => { service.close(); rmSync(directory, { recursive: true, force: true }); });
  let actor = { id: 2, role: 'editor' };
  const handler = createContentHandler({
    service,
    allowedOrigin: origin,
    resolveActor: () => actor,
    verifyCsrf: () => true,
  });
  async function send(method, url, body, key) {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    Object.assign(req, { method, url, headers: { origin, 'content-type': 'application/json', 'idempotency-key': key } });
    const res = { writeHead(status) { this.status = status; }, end(data) { this.body = JSON.parse(data); } };
    await handler(req, res);
    return res;
  }
  const created = await send('POST', '/api/content/commands/create', { content }, 'real-create-001');
  assert.equal(created.status, 200);
  assert.equal((await send('GET', '/api/content/public/over-ons')).status, 404);
  const submitted = await send('POST', '/api/content/commands/submit-review', { id: created.body.data.id, version: created.body.data.version }, 'real-review-001');
  assert.equal(submitted.status, 200);
  actor = { id: 4, role: 'publisher' };
  const published = await send('POST', '/api/content/commands/publish', { id: created.body.data.id, version: submitted.body.data.version }, 'real-publish-001');
  assert.equal(published.status, 200);
  const publicPage = await send('GET', '/api/content/public/over-ons');
  assert.equal(publicPage.status, 200);
  assert.equal(publicPage.body.data.title, 'Over ons');
  assert.equal(Object.hasOwn(publicPage.body.data, 'createdBy'), false);
});
