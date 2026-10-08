// SPDX-License-Identifier: GPL-3.0-or-later
// Host adapter only: session resolution and CSRF verification are injected by the app.
import { randomUUID } from 'node:crypto';

const prefix = '/api/content';
const roleSet = new Set(['admin', 'editor', 'publisher', 'reader']);
const allowedStatuses = new Set([400, 401, 403, 404, 409, 413, 415, 422, 429, 503]);
const publicTypes = new Set(['page', 'article', 'service', 'project', 'faq']);

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function shape(value, fields) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some((key) => !fields.includes(key))) {
    throw new HttpError(400, 'INVALID_COMMAND');
  }
}

function integer(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new HttpError(400, 'INVALID_REFERENCE');
  return value;
}

function pagination(params, accepted) {
  const result = {};
  for (const [key, value] of params) {
    if (!accepted.includes(key) || Object.hasOwn(result, key)) {
      throw new HttpError(400, 'INVALID_QUERY');
    }
    if (key === 'type' || key === 'status') {
      if (!/^[a-z]+$/.test(value)) throw new HttpError(400, 'INVALID_QUERY');
      result[key] = value;
      continue;
    }
    if (!/^(0|[1-9]\d*)$/.test(value)) throw new HttpError(400, 'INVALID_QUERY');
    const number = Number(value);
    if (!Number.isSafeInteger(number) || (key === 'limit' && (number < 1 || number > 100)) || (key === 'offset' && number > 1000000)) {
      throw new HttpError(400, 'INVALID_QUERY');
    }
    result[key] = number;
  }
  if (result.type !== undefined && !publicTypes.has(result.type)) throw new HttpError(400, 'INVALID_QUERY');
  if (result.status !== undefined && !['draft', 'published', 'archived'].includes(result.status)) throw new HttpError(400, 'INVALID_QUERY');
  return result;
}

function reply(res, status, payload, requestId) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Request-ID': requestId,
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req, maxBytes, timeoutMs) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'JSON_REQUIRED');
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new HttpError(413, 'BODY_TOO_LARGE');
  return await new Promise((resolve, reject) => {
    let bytes = 0;
    let settled = false;
    const chunks = [];
    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      req.off('close', onClose);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      req.pause();
      error.closeConnection = true;
      reject(error);
    };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) return fail(new HttpError(413, 'BODY_TOO_LARGE'));
      chunks.push(buffer);
    };
    const onEnd = () => {
      if (settled) return;
      let parsed;
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { return fail(new HttpError(400, 'INVALID_JSON')); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail(new HttpError(400, 'OBJECT_REQUIRED'));
      settled = true;
      cleanup();
      resolve(parsed);
    };
    const onError = () => fail(new HttpError(400, 'BODY_READ_FAILED'));
    const onAborted = () => fail(new HttpError(400, 'BODY_ABORTED'));
    const onClose = () => { if (!settled) fail(new HttpError(400, 'BODY_ABORTED')); };
    const timer = setTimeout(() => fail(new HttpError(400, 'BODY_TIMEOUT')), timeoutMs);
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
    req.once('close', onClose);
  });
}

export function createContentHandler({
  service,
  resolveActor,
  verifyCsrf,
  allowedOrigin,
  maxBytes = 262144,
  bodyTimeoutMs = 5000,
  requestsPerMinute = 120,
  onError = () => {},
}) {
  if (!service || typeof resolveActor !== 'function' || typeof verifyCsrf !== 'function') {
    throw new TypeError('service, resolveActor and verifyCsrf are required');
  }
  const origin = new URL(allowedOrigin);
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) {
    throw new TypeError('HTTPS origin required');
  }
  if (origin.username || origin.password || origin.origin !== allowedOrigin) throw new TypeError('Use an exact origin without a path or credentials');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576 ||
      !Number.isSafeInteger(bodyTimeoutMs) || bodyTimeoutMs < 1 || bodyTimeoutMs > 30000 ||
      !Number.isSafeInteger(requestsPerMinute) || requestsPerMinute < 1) throw new TypeError('Invalid limits');

  const rates = new Map();
  return async function handleContent(req, res) {
    let url;
    try { url = new URL(req.url, allowedOrigin); } catch { return false; }
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return false;
    const requestId = randomUUID();
    try {
      if (url.origin !== allowedOrigin || (req.headers.origin !== undefined && req.headers.origin !== allowedOrigin)) {
        throw new HttpError(403, 'ORIGIN_REJECTED');
      }
      const parts = url.pathname.slice(prefix.length).split('/').filter(Boolean);
      if (req.method === 'GET' && parts[0] === 'public') {
        if (parts.length === 2 && !url.search) {
          const content = service.getPublished(parts[1]);
          if (!content) throw new HttpError(404, 'CONTENT_NOT_FOUND');
          reply(res, 200, { data: content }, requestId);
          return true;
        }
        if (parts.length === 1) {
          const options = pagination(url.searchParams, ['limit', 'offset', 'type']);
          reply(res, 200, { data: service.listPublished(options) }, requestId);
          return true;
        }
        throw new HttpError(404, 'ROUTE_NOT_FOUND');
      }

      const actor = await resolveActor(req);
      if (!actor || !((Number.isSafeInteger(actor.id) && actor.id > 0) ||
          (typeof actor.id === 'string' && actor.id.trim().length > 0 && actor.id.length <= 128)) || !roleSet.has(actor.role)) {
        throw new HttpError(401, 'AUTH_REQUIRED');
      }
      const rateKey = String(actor.id).trim();
      const now = Date.now();
      for (const [key, value] of rates) if (now >= value.expires) rates.delete(key);
      if (!rates.has(rateKey) && rates.size >= 10000) throw new HttpError(503, 'RATE_CAPACITY');
      const rate = rates.get(rateKey) ?? { expires: now + 60000, count: 0 };
      rate.count += 1;
      rates.set(rateKey, rate);
      if (rate.count > requestsPerMinute) throw new HttpError(429, 'RATE_LIMITED');

      if (req.method === 'GET') {
        if (parts.length === 1 && parts[0] === 'items') {
          const options = pagination(url.searchParams, ['limit', 'offset', 'type', 'status']);
          reply(res, 200, { data: service.listManaged(actor, options) }, requestId);
          return true;
        }
        if (url.search) throw new HttpError(400, 'QUERY_NOT_SUPPORTED');
        if (parts.length === 2 && parts[0] === 'items' && /^[1-9]\d*$/.test(parts[1])) {
          reply(res, 200, { data: service.getManaged(actor, integer(Number(parts[1]))) }, requestId);
          return true;
        }
        if (parts.length === 3 && parts[0] === 'items' && /^[1-9]\d*$/.test(parts[1]) && parts[2] === 'revisions') {
          reply(res, 200, { data: service.listRevisions(actor, integer(Number(parts[1]))) }, requestId);
          return true;
        }
        throw new HttpError(404, 'ROUTE_NOT_FOUND');
      }

      if (url.search) throw new HttpError(400, 'QUERY_NOT_SUPPORTED');
      if (req.method !== 'POST' || parts.length !== 2 || parts[0] !== 'commands' ||
          !['create', 'update', 'submit-review', 'return-for-changes', 'publish', 'archive'].includes(parts[1])) throw new HttpError(404, 'ROUTE_NOT_FOUND');
      if (req.headers.origin !== allowedOrigin || await verifyCsrf(req, actor) !== true) throw new HttpError(403, 'CSRF_REJECTED');
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,100}$/.test(key)) throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED');
      const input = await readJson(req, maxBytes, bodyTimeoutMs);
      let result;
      if (parts[1] === 'create') {
        shape(input, ['content']);
        result = service.createContent(actor, input.content, key);
      } else if (parts[1] === 'update') {
        shape(input, ['id', 'version', 'content']);
        result = service.updateContent(actor, integer(input.id), input.content, integer(input.version), key);
      } else if (parts[1] === 'publish') {
        shape(input, ['id', 'version']);
        result = service.publishContent(actor, integer(input.id), integer(input.version), key);
      } else if (parts[1] === 'submit-review') {
        shape(input, ['id', 'version']);
        result = service.submitForReview(actor, integer(input.id), integer(input.version), key);
      } else if (parts[1] === 'return-for-changes') {
        shape(input, ['id', 'version']);
        result = service.returnForChanges(actor, integer(input.id), integer(input.version), key);
      } else {
        shape(input, ['id', 'version']);
        result = service.archiveContent(actor, integer(input.id), integer(input.version), key);
      }
      reply(res, 200, { data: result }, requestId);
      return true;
    } catch (error) {
      const status = allowedStatuses.has(error.status) ? error.status : 500;
      const code = status === 500 ? 'INTERNAL_ERROR' : (/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code ?? '') ? error.code : 'REQUEST_REJECTED');
      if (status === 500) { try { onError({ requestId, code: 'INTERNAL_ERROR' }); } catch { /* logging must not leak */ } }
      if (error.closeConnection) {
        res.setHeader?.('Connection', 'close');
        if (typeof res.once === 'function') res.once('finish', () => req.destroy());
        else req.destroy();
      }
      reply(res, status, { error: code, requestId }, requestId);
      return true;
    }
  };
}
