// SPDX-License-Identifier: GPL-3.0-or-later
import { createServer } from 'node:http';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { AuthStore, sessionCookie } from './auth.mjs';
import { createResendEmailSender } from './email.mjs';
import { ContentService, renderPublicContent } from '../modules/content-management/engine.mjs';
import { createContentHandler } from '../modules/content-management/http.mjs';
import { OperationsService } from '../modules/service-operations/engine.mjs';
import { createOperationsHandler } from '../modules/service-operations/http.mjs';
import { createMcpEndpoint } from './mcp-http.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = resolve(projectRoot, 'web');
const production = process.env.NODE_ENV === 'production';
const allowedOrigin = process.env.CMS_ERP_ORIGIN ?? (production ? '' : 'http://127.0.0.1:3000');
const originUrl = new URL(allowedOrigin || 'http://invalid');
const secureCookies = originUrl.protocol === 'https:';
if (!allowedOrigin || originUrl.origin !== allowedOrigin || originUrl.username || originUrl.password ||
    (originUrl.protocol !== 'https:' && !(originUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(originUrl.hostname)))) {
  throw new Error('Set CMS_ERP_ORIGIN to an exact HTTPS origin (HTTP is allowed only for localhost development).');
}

const dbPath = resolve(process.env.CMS_ERP_DATABASE ?? resolve(projectRoot, 'var', 'cms-erp.sqlite'));
const relativeToWeb = relative(webRoot, dbPath);
if (relativeToWeb === '' || (!relativeToWeb.startsWith(`..${sep}`) && relativeToWeb !== '..' && !isAbsolute(relativeToWeb))) {
  throw new Error('The database must be outside the served web directory.');
}
mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });

const auth = new AuthStore(dbPath, { mfaEncryptionKey: process.env.CMS_ERP_MFA_ENCRYPTION_KEY ?? '' });
auth.bootstrapAdmin(process.env.CMS_ERP_BOOTSTRAP_EMAIL, process.env.CMS_ERP_BOOTSTRAP_PASSWORD);
const resendApiKey = process.env.RESEND_API_KEY ?? '';
const resendFromEmail = process.env.RESEND_FROM_EMAIL ?? '';
if (Boolean(resendApiKey.trim()) !== Boolean(resendFromEmail.trim())) {
  throw new Error('Configure both RESEND_API_KEY and RESEND_FROM_EMAIL, or leave both empty.');
}
const emailSender = resendApiKey.trim()
  ? createResendEmailSender({ apiKey: resendApiKey, from: resendFromEmail, origin: allowedOrigin })
  : null;
if (!emailSender) console.warn(JSON.stringify({ event: 'password_reset_email_disabled' }));
const content = new ContentService(dbPath);
const operations = new OperationsService(dbPath, { businessTimezone: process.env.CMS_ERP_TIMEZONE ?? 'Europe/Amsterdam' });
const mcpEndpoint = createMcpEndpoint({ auth, content, operations, origin: allowedOrigin });
try { chmodSync(dbPath, 0o600); } catch { /* Windows ACLs control access on Windows. */ }

const contentRoles = new Set(['admin', 'editor', 'publisher', 'reader']);
const operationsRoles = new Set(['admin', 'planner', 'technician', 'finance', 'reader']);
const handleContent = createContentHandler({
  service: content,
  resolveActor: (req) => { const actor = auth.actor(req); return actor && contentRoles.has(actor.role) ? { id: actor.id, role: actor.role } : null; },
  verifyCsrf: (req, actor) => auth.verifyCsrf(req, actor),
  allowedOrigin,
  onError: ({ requestId }) => console.error(JSON.stringify({ event: 'content_request_error', requestId })),
});
const handleOperations = createOperationsHandler({
  service: operations,
  resolveActor: (req) => { const actor = auth.actor(req); return actor && operationsRoles.has(actor.role) ? { id: actor.id, role: actor.role } : null; },
  verifyCsrf: (req, actor) => auth.verifyCsrf(req, actor),
  authorizeCommand: ({ command, input }) => command !== 'create-resource' || auth.isActiveTechnician(input.technicianId),
  allowedOrigin,
  onError: ({ requestId }) => console.error(JSON.stringify({ event: 'operations_request_error', requestId })),
});

const loginHtml = `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Inloggen · CMS/ERP</title><link rel="stylesheet" href="/assets/app.css"></head><body class="login-page"><main class="login-card"><p class="eyebrow">CMS · ERP</p><h1>Inloggen</h1><p>Gebruik het account dat voor deze installatie is ingesteld.</p><form method="post" action="/login"><label>E-mailadres<input name="email" type="email" autocomplete="username" maxlength="254" required></label><label>Wachtwoord<input name="password" type="password" autocomplete="current-password" maxlength="1024" required></label><label>Verificatie- of herstelcode (indien ingeschakeld)<input name="mfaCode" type="text" autocomplete="one-time-code" maxlength="128"></label><button type="submit">Inloggen</button><p class="form-error" role="alert">{{ERROR}}</p></form><p><a href="/password-reset">Wachtwoord vergeten?</a></p></main></body></html>`;
const passwordResetHtml = `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wachtwoord herstellen · CMS/ERP</title><link rel="stylesheet" href="/assets/app.css"><script src="/assets/password-reset.js" defer></script></head><body class="login-page"><main class="login-card"><p class="eyebrow">CMS · ERP</p><h1>Wachtwoord herstellen</h1><p id="reset-intro">Vraag een beveiligde herstellink aan voor je account.</p><form id="request-reset"><label>E-mailadres<input name="email" type="email" autocomplete="email" maxlength="254" required></label><button type="submit">Verstuur herstellink</button></form><form id="complete-reset" hidden><label>Nieuw wachtwoord<input name="password" type="password" autocomplete="new-password" minlength="14" maxlength="1024" required></label><label>Herhaal nieuw wachtwoord<input name="confirm" type="password" autocomplete="new-password" minlength="14" maxlength="1024" required></label><button type="submit">Wachtwoord opslaan</button></form><p id="reset-feedback" class="form-error" role="status" aria-live="polite"></p><p><a href="/login">Terug naar inloggen</a></p></main></body></html>`;
const invitationHtml = `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Uitnodiging · CMS/ERP</title><link rel="stylesheet" href="/assets/app.css"><script src="/assets/invitation.js" defer></script></head><body class="login-page"><main class="login-card"><p class="eyebrow">CMS · ERP</p><h1>Uitnodiging accepteren</h1><p>Stel een uniek wachtwoord in om je account te activeren.</p><form id="accept-invitation"><label>Nieuw wachtwoord<input name="password" type="password" autocomplete="new-password" minlength="14" maxlength="1024" required></label><label>Wachtwoord herhalen<input name="confirm" type="password" autocomplete="new-password" minlength="14" maxlength="1024" required></label><button type="submit">Account activeren</button></form><p id="invitation-feedback" class="form-error" role="status" aria-live="polite"></p><p><a href="/login">Naar inloggen</a></p></main></body></html>`;
const adminHtml = readFileSync(resolve(webRoot, 'admin.html'), 'utf8');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function send(res, status, body, contentType = 'text/html; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
    ...(production ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    ...extraHeaders,
  });
  res.end(body);
}

function json(res, status, value, extraHeaders = {}) {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8', extraHeaders);
}

function redirect(res, path, extraHeaders = {}) {
  res.writeHead(303, { Location: path, 'Cache-Control': 'no-store', ...extraHeaders });
  res.end();
}

async function readForm(req) {
  const contentType = req.headers['content-type'] ?? '';
  if (!/^application\/x-www-form-urlencoded(?:\s*;.*)?$/iu.test(contentType)) return null;
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > 8192)) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) return null;
    chunks.push(chunk);
  }
  try { return new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { return null; }
}

async function readJson(req, maxBytes = 8192) {
  if (!/^application\/json(?:\s*;.*)?$/iu.test(req.headers['content-type'] ?? '')) return null;
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) return null;
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) return null;
      chunks.push(chunk);
    }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function asset(res, name, type) {
  try {
    const body = readFileSync(resolve(webRoot, name));
    send(res, 200, body, type, { 'Cache-Control': 'public, max-age=300' });
  } catch {
    send(res, 404, 'Not found');
  }
}

function publicShell(title, description, body) {
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}"><link rel="stylesheet" href="/assets/app.css"></head><body><header class="topbar"><a class="brand" href="/">CMS <span>ERP</span></a><nav><a href="/">Website</a><a href="/login">Beheer</a></nav></header><main class="public-layout">${body}</main></body></html>`;
}

const loginAttempts = new Map();
function loginLimited(req) {
  const key = req.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
  for (const [address, entry] of loginAttempts) if (now >= entry.expiresAt) loginAttempts.delete(address);
  if (!loginAttempts.has(key) && loginAttempts.size >= 10000) return true;
  const entry = loginAttempts.get(key);
  return Boolean(entry && entry.count >= 5 && now < entry.expiresAt);
}
function failedLogin(req) {
  const key = req.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now >= entry.expiresAt) loginAttempts.set(key, { count: 1, expiresAt: now + 15 * 60 * 1000 });
  else entry.count += 1;
}

function mfaRateLimited(req, actor, operation) {
  return !auth.consumeRateLimits([
    { key: `mfa:${operation}:global`, limit: 1000, windowMs: 60 * 60 * 1000 },
    { key: `mfa:${operation}:user:${actor.id}`, limit: 10, windowMs: 15 * 60 * 1000 },
    { key: `mfa:${operation}:ip:${req.socket.remoteAddress ?? 'unknown'}`, limit: 50, windowMs: 60 * 60 * 1000 },
  ]);
}

async function route(req, res) {
  const requestId = randomUUID();
  const host = req.headers.host;
  if (host && host.toLowerCase() !== originUrl.host.toLowerCase()) return send(res, 400, 'Invalid host');
  let url;
  try { url = new URL(req.url, allowedOrigin); } catch { return send(res, 400, 'Bad request'); }
  if (url.origin !== allowedOrigin) return send(res, 400, 'Invalid origin');

  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok' });
  if (mcpEndpoint && await mcpEndpoint.handle(req, res)) return;
  if (req.method === 'GET' && url.pathname === '/assets/app.css') return asset(res, 'app.css', 'text/css; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/assets/admin.js') return asset(res, 'admin.js', 'text/javascript; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/assets/password-reset.js') return asset(res, 'password-reset.js', 'text/javascript; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/assets/invitation.js') return asset(res, 'invitation.js', 'text/javascript; charset=utf-8');

  if (req.method === 'POST' && url.pathname === '/api/auth/invitations/accept') {
    if (req.headers.origin !== allowedOrigin) return json(res, 403, { error: 'ORIGIN_REJECTED', requestId });
    const input = await readJson(req);
    if (!input || Object.keys(input).some((key) => !['token', 'password'].includes(key))) return json(res, 400, { error: 'INVALID_INVITATION', requestId });
    const tokenKey = typeof input.token === 'string' ? input.token.slice(0, 128) : 'invalid-token';
    if (!auth.consumeRateLimits([
      { key: 'invitation-accept:global', limit: 1000, windowMs: 60 * 60 * 1000 },
      { key: `invitation-accept:ip:${req.socket.remoteAddress ?? 'unknown'}`, limit: 50, windowMs: 60 * 60 * 1000 },
      { key: `invitation-accept:token:${tokenKey}`, limit: 5, windowMs: 60 * 60 * 1000 },
    ])) return json(res, 429, { error: 'INVITATION_RATE_LIMITED', requestId });
    const result = auth.acceptInvitation(input.token, input.password);
    if (result.error) return json(res, 400, { error: result.error, requestId });
    return json(res, 201, { data: result.data });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/password-reset/request') {
    if (req.headers.origin !== allowedOrigin) return json(res, 403, { error: 'ORIGIN_REJECTED', requestId });
    const input = await readJson(req);
    if (!input || Object.keys(input).some((key) => key !== 'email') || typeof input.email !== 'string' || input.email.length > 254) {
      return json(res, 400, { error: 'INVALID_RESET_REQUEST', requestId });
    }
    if (!emailSender) return json(res, 202, { data: { message: 'Als herstelinstructies naar dit account kunnen worden gestuurd, ontvang je ze.' } });
    const rateLimited = !auth.consumeRateLimits([
      { key: 'password-reset-request:global', limit: 1000, windowMs: 60 * 60 * 1000 },
      { key: `password-reset-request:ip:${req.socket.remoteAddress ?? 'unknown'}`, limit: 50, windowMs: 60 * 60 * 1000 },
      { key: `password-reset-request:email:${input.email.trim().toLowerCase()}`, limit: 3, windowMs: 60 * 60 * 1000 },
    ]);
    if (rateLimited) return json(res, 202, { data: { message: 'Als herstelinstructies naar dit account kunnen worden gestuurd, ontvang je ze.' } });
    const reset = auth.createPasswordReset(input.email);
    if (reset) {
      const resetUrl = new URL('/password-reset', allowedOrigin);
      resetUrl.hash = new URLSearchParams({ token: reset.token }).toString();
      void (async () => {
        try {
          await emailSender({ to: reset.email, url: resetUrl.href });
          if (!auth.activatePasswordReset(reset.token)) throw new Error('RESET_ACTIVATION_FAILED');
        } catch {
          try { auth.discardPendingPasswordReset(reset.token); } catch { /* preserve the generic recovery response */ }
          console.error(JSON.stringify({ event: 'password_reset_email_failed', requestId }));
        }
      })();
    }
    return json(res, 202, { data: { message: 'Als herstelinstructies naar dit account kunnen worden gestuurd, ontvang je ze.' } });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/password-reset/complete') {
    if (req.headers.origin !== allowedOrigin) return json(res, 403, { error: 'ORIGIN_REJECTED', requestId });
    const input = await readJson(req);
    if (!input || Object.keys(input).some((key) => !['token', 'newPassword'].includes(key))) {
      return json(res, 400, { error: 'INVALID_RESET_REQUEST', requestId });
    }
    const tokenKey = typeof input.token === 'string' ? input.token.slice(0, 1024) : 'invalid-token';
    if (!auth.consumeRateLimits([
      { key: 'password-reset-complete:global', limit: 1000, windowMs: 60 * 60 * 1000 },
      { key: `password-reset-complete:ip:${req.socket.remoteAddress ?? 'unknown'}`, limit: 100, windowMs: 60 * 60 * 1000 },
      { key: `password-reset-complete:token:${tokenKey}`, limit: 5, windowMs: 60 * 60 * 1000 },
    ])) return json(res, 400, { error: 'INVALID_OR_EXPIRED_RESET', requestId });
    const result = auth.completePasswordReset(input.token, input.newPassword);
    if (result.error) return json(res, 400, { error: result.error, requestId });
    return json(res, 200, { data: result.data });
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/session') {
    const actor = auth.actor(req);
    const csrfToken = auth.csrfToken(req);
    if (!actor || !csrfToken) return json(res, 401, { error: 'AUTH_REQUIRED', requestId });
    return json(res, 200, { data: { actor, csrfToken, auth0McpEnabled: Boolean(mcpEndpoint) } });
  }
  if (req.method === 'GET' && url.pathname === '/api/auth/mfa') {
    const actor = auth.actor(req);
    if (!actor) return json(res, 401, { error: 'AUTH_REQUIRED', requestId });
    const result = auth.mfaStatus(req, actor);
    return result.error ? json(res, 401, { error: result.error, requestId }) : json(res, 200, result);
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/mfa/enroll') {
    const actor = auth.actor(req);
    if (!actor) return json(res, 401, { error: 'AUTH_REQUIRED', requestId });
    if (req.headers.origin !== allowedOrigin || !auth.verifyCsrf(req, actor)) return json(res, 403, { error: 'CSRF_REJECTED', requestId });
    const input = await readJson(req);
    if (!input || Object.keys(input).some((key) => key !== 'currentPassword')) return json(res, 400, { error: 'INVALID_MFA_REQUEST', requestId });
    if (mfaRateLimited(req, actor, 'enroll')) return json(res, 429, { error: 'MFA_RATE_LIMITED', requestId });
    const result = auth.beginMfaEnrollment(req, actor, input.currentPassword);
    if (result.error) {
      const status = result.error === 'AUTH_REQUIRED' ? 401
        : result.error === 'MFA_NOT_CONFIGURED' ? 503
          : result.error === 'MFA_ALREADY_ENABLED' ? 409 : 400;
      return json(res, status, { error: result.error, requestId });
    }
    return json(res, 200, result);
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/mfa/confirm') {
    const actor = auth.actor(req);
    if (!actor) return json(res, 401, { error: 'AUTH_REQUIRED', requestId });
    if (req.headers.origin !== allowedOrigin || !auth.verifyCsrf(req, actor)) return json(res, 403, { error: 'CSRF_REJECTED', requestId });
    const input = await readJson(req);
    if (!input || Object.keys(input).some((key) => key !== 'code')) return json(res, 400, { error: 'INVALID_MFA_REQUEST', requestId });
    if (mfaRateLimited(req, actor, 'confirm')) return json(res, 429, { error: 'MFA_RATE_LIMITED', requestId });
    const result = auth.confirmMfaEnrollment(req, actor, input.code);
    if (result.error) {
      const status = result.error === 'AUTH_REQUIRED' ? 401
        : result.error === 'MFA_ALREADY_ENABLED' || result.error === 'MFA_ENROLLMENT_EXPIRED' ? 409
          : result.error === 'MFA_NOT_CONFIGURED' ? 503 : 400;
      return json(res, status, { error: result.error, requestId });
    }
    return json(res, 200, result);
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/mfa/disable') {
    const actor = auth.actor(req);
    if (!actor) return json(res, 401, { error: 'AUTH_REQUIRED', requestId });
    if (req.headers.origin !== allowedOrigin || !auth.verifyCsrf(req, actor)) return json(res, 403, { error: 'CSRF_REJECTED', requestId });
    const input = await readJson(req);
    if (!input || Object.keys(input).some((key) => !['currentPassword', 'code'].includes(key))) return json(res, 400, { error: 'INVALID_MFA_REQUEST', requestId });
    if (mfaRateLimited(req, actor, 'disable')) return json(res, 429, { error: 'MFA_RATE_LIMITED', requestId });
    const result = auth.disableMfa(req, actor, input.currentPassword, input.code);
    if (result.error) {
      const status = result.error === 'AUTH_REQUIRED' ? 401
        : result.error === 'MFA_NOT_ENABLED' ? 409 : 400;
      return json(res, status, { error: result.error, requestId });
    }
    return json(res, 200, result);
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/password') {
    const actor = auth.actor(req);
    if (!actor) return json(res, 401, { error: 'AUTH_REQUIRED', requestId });
    if (req.headers.origin !== allowedOrigin || !auth.verifyCsrf(req, actor)) {
      return json(res, 403, { error: 'CSRF_REJECTED', requestId });
    }
    const input = await readJson(req);
    if (!input || Object.keys(input).some((key) => !['currentPassword', 'newPassword'].includes(key))) {
      return json(res, 400, { error: 'INVALID_PASSWORD_REQUEST', requestId });
    }
    const result = auth.changePassword(req, actor, input.currentPassword, input.newPassword);
    if (result.error) {
      const status = result.error === 'AUTH_REQUIRED' ? 401
        : result.error === 'PASSWORD_CHANGED_CONCURRENTLY' ? 409
          : 400;
      return json(res, status, { error: result.error, requestId });
    }
    return json(res, 200, { data: { actor: result.actor, csrfToken: result.csrfToken } }, {
      'Set-Cookie': sessionCookie(result.token, { secure: secureCookies }),
    });
  }
  if (url.pathname === '/api/users' && req.method === 'GET') {
    if (auth.actor(req)?.role !== 'admin') return json(res, 403, { error: 'FORBIDDEN', requestId });
    return json(res, 200, { data: auth.listUsers() });
  }
  if (url.pathname === '/api/user-invitations' && req.method === 'GET') {
    if (auth.actor(req)?.role !== 'admin') return json(res, 403, { error: 'FORBIDDEN', requestId });
    return json(res, 200, { data: auth.listInvitations() });
  }
  if (url.pathname === '/api/user-invitations' && req.method === 'POST') {
    const actor = auth.actor(req);
    if (actor?.role !== 'admin') return json(res, 403, { error: 'FORBIDDEN', requestId });
    if (req.headers.origin !== allowedOrigin || !auth.verifyCsrf(req, actor)) return json(res, 403, { error: 'CSRF_REJECTED', requestId });
    if (!emailSender) return json(res, 503, { error: 'EMAIL_DELIVERY_DISABLED', requestId });
    const input = await readJson(req);
    if (!input || Object.keys(input).some((key) => !['email', 'role'].includes(key))) return json(res, 400, { error: 'INVALID_INVITATION', requestId });
    if (!auth.consumeRateLimits([
      { key: 'invitation-create:global', limit: 500, windowMs: 60 * 60 * 1000 },
      { key: `invitation-create:actor:${actor.id}`, limit: 30, windowMs: 60 * 60 * 1000 },
      { key: `invitation-create:ip:${req.socket.remoteAddress ?? 'unknown'}`, limit: 100, windowMs: 60 * 60 * 1000 },
    ])) return json(res, 429, { error: 'INVITATION_RATE_LIMITED', requestId });
    const token = randomBytes(32).toString('base64url');
    const result = auth.createInvitation(actor, req.headers['idempotency-key'], { ...input, token });
    if (result.error) {
      const status = ['EMAIL_IN_USE', 'INVITATION_EXISTS', 'IDEMPOTENCY_CONFLICT'].includes(result.error) ? 409
        : result.error === 'FORBIDDEN' ? 403 : 400;
      return json(res, status, { error: result.error, requestId });
    }
    if (result.data.alreadyCreated) return json(res, 200, { data: { email: result.data.email, role: result.data.role, expiresAt: result.data.expiresAt, alreadySent: true } });
    const invitationUrl = new URL('/invite', allowedOrigin);
    invitationUrl.hash = new URLSearchParams({ token: result.data.token }).toString();
    try {
      await emailSender.sendInvitation({ to: result.data.email, url: invitationUrl.href });
      if (!auth.activateInvitation(token)) throw new Error('INVITATION_ACTIVATION_FAILED');
      return json(res, 201, { data: { email: result.data.email, role: result.data.role, expiresAt: result.data.expiresAt } });
    } catch {
      try { auth.discardPendingInvitation(token); } catch { /* preserve the provider failure */ }
      console.error(JSON.stringify({ event: 'user_invitation_delivery_failed', requestId }));
      return json(res, 503, { error: 'INVITATION_DELIVERY_FAILED', requestId });
    }
  }
  const invitationMatch = /^\/api\/user-invitations\/([1-9]\d*)$/u.exec(url.pathname);
  if (invitationMatch && req.method === 'DELETE') {
    const actor = auth.actor(req);
    if (actor?.role !== 'admin') return json(res, 403, { error: 'FORBIDDEN', requestId });
    if (req.headers.origin !== allowedOrigin || !auth.verifyCsrf(req, actor)) return json(res, 403, { error: 'CSRF_REJECTED', requestId });
    const input = await readJson(req);
    if (!input || Object.keys(input).length !== 0) return json(res, 400, { error: 'INVALID_INVITATION', requestId });
    const result = auth.revokeInvitation(actor, req.headers['idempotency-key'], Number(invitationMatch[1]));
    if (result.error) {
      const status = result.error === 'INVITATION_NOT_FOUND' ? 404
        : result.error === 'FORBIDDEN' ? 403
          : ['IDEMPOTENCY_CONFLICT', 'INVITATION_NOT_ACTIVE'].includes(result.error) ? 409 : 400;
      return json(res, status, { error: result.error, requestId });
    }
    return json(res, 200, result);
  }
  const userMatch = /^\/api\/users\/([1-9]\d*)$/u.exec(url.pathname);
  if (userMatch && req.method === 'PATCH') {
    const actor = auth.actor(req);
    if (actor?.role !== 'admin') return json(res, 403, { error: 'FORBIDDEN', requestId });
    if (req.headers.origin !== allowedOrigin || !auth.verifyCsrf(req, actor)) return json(res, 403, { error: 'CSRF_REJECTED', requestId });
    const input = await readJson(req);
    if (!input || Object.keys(input).some((key) => !['role', 'active'].includes(key))) {
      return json(res, 400, { error: 'INVALID_USER_UPDATE', requestId });
    }
    const result = auth.updateUser(actor, req.headers['idempotency-key'], Number(userMatch[1]), input);
    if (result.error) {
      const status = result.error === 'USER_NOT_FOUND' ? 404
        : result.error === 'FORBIDDEN' ? 403
          : ['IDEMPOTENCY_CONFLICT', 'SELF_MANAGEMENT_FORBIDDEN', 'LAST_ADMIN_REQUIRED'].includes(result.error) ? 409
            : 400;
      return json(res, status, { error: result.error, requestId });
    }
    return json(res, 200, result);
  }
  const auth0LinkMatch = /^\/api\/users\/([1-9]\d*)\/auth0-link$/u.exec(url.pathname);
  if (auth0LinkMatch && req.method === 'POST') {
    if (!mcpEndpoint) return json(res, 503, { error: 'AUTH0_MCP_DISABLED', requestId });
    const actor = auth.actor(req);
    if (actor?.role !== 'admin') return json(res, 403, { error: 'FORBIDDEN', requestId });
    if (req.headers.origin !== allowedOrigin || !auth.verifyCsrf(req, actor)) return json(res, 403, { error: 'CSRF_REJECTED', requestId });
    const input = await readJson(req);
    if (!input || Object.keys(input).some((key) => key !== 'code')) return json(res, 400, { error: 'INVALID_LINK_REQUEST', requestId });
    const result = auth.createAuth0LinkChallenge(actor, req.headers['idempotency-key'], Number(auth0LinkMatch[1]), input.code);
    if (result.error) {
      const status = result.error === 'USER_NOT_FOUND' ? 404
        : result.error === 'FORBIDDEN' ? 403
          : ['IDENTITY_ALREADY_LINKED', 'IDEMPOTENCY_CONFLICT'].includes(result.error) ? 409
            : 400;
      return json(res, status, { error: result.error, requestId });
    }
    return json(res, 201, { data: result.data });
  }
  if (url.pathname === '/api/technicians' && req.method === 'GET') {
    const actor = auth.actor(req);
    if (!actor || !['admin', 'planner'].includes(actor.role)) return json(res, 403, { error: 'FORBIDDEN', requestId });
    return json(res, 200, { data: auth.listActiveTechnicians() });
  }
  if (url.pathname === '/api/users' && req.method === 'POST') {
    const actor = auth.actor(req);
    if (actor?.role !== 'admin') return json(res, 403, { error: 'FORBIDDEN', requestId });
    if (req.headers.origin !== allowedOrigin || !auth.verifyCsrf(req, actor)) return json(res, 403, { error: 'CSRF_REJECTED', requestId });
    const input = await readJson(req);
    if (!input || Object.keys(input).some((key) => !['email', 'password', 'role'].includes(key))) return json(res, 400, { error: 'INVALID_USER', requestId });
    const result = auth.createUser(actor, req.headers['idempotency-key'], input);
    if (result.error) {
      const status = result.error === 'EMAIL_IN_USE' || result.error === 'IDEMPOTENCY_CONFLICT' ? 409 : 400;
      return json(res, status, { error: result.error, requestId });
    }
    return json(res, 201, { data: result.data });
  }

  if (req.method === 'GET' && url.pathname === '/login') {
    if (auth.actor(req)) return redirect(res, '/admin');
    return send(res, 200, loginHtml.replace('{{ERROR}}', ''));
  }
  if (req.method === 'GET' && url.pathname === '/password-reset') {
    return send(res, 200, passwordResetHtml, 'text/html; charset=utf-8', { 'Referrer-Policy': 'no-referrer' });
  }
  if (req.method === 'GET' && url.pathname === '/invite') {
    return send(res, 200, invitationHtml, 'text/html; charset=utf-8', { 'Referrer-Policy': 'no-referrer' });
  }
  if (req.method === 'POST' && url.pathname === '/login') {
    if (req.headers.origin !== allowedOrigin) return send(res, 403, loginHtml.replace('{{ERROR}}', 'Ongeldige aanmeldpoging.'));
    if (loginLimited(req)) return send(res, 429, loginHtml.replace('{{ERROR}}', 'Te veel pogingen. Probeer het later opnieuw.'));
    const form = await readForm(req);
    const session = form && auth.authenticate(form.get('email'), form.get('password'), form.get('mfaCode') ?? '');
    if (!session) {
      failedLogin(req);
      return send(res, 401, loginHtml.replace('{{ERROR}}', 'E-mailadres of wachtwoord is onjuist.'));
    }
    loginAttempts.delete(req.socket.remoteAddress ?? 'unknown');
    return redirect(res, '/admin', { 'Set-Cookie': sessionCookie(session.token, { secure: secureCookies }) });
  }
  if (req.method === 'GET' && url.pathname === '/admin') {
    if (!auth.actor(req)) return redirect(res, '/login');
    return send(res, 200, adminHtml);
  }
  if (req.method === 'POST' && url.pathname === '/logout') {
    const actor = auth.actor(req);
    if (!actor || req.headers.origin !== allowedOrigin || !auth.verifyCsrf(req, actor)) return send(res, 403, 'Ongeldige aanvraag.');
    auth.revoke(req);
    return redirect(res, '/login', { 'Set-Cookie': sessionCookie('', { secure: secureCookies, clear: true }) });
  }
  if (req.method === 'GET' && url.pathname === '/') {
    const items = content.listPublished({ limit: 100, offset: 0 });
    const links = items.map((item) => `<li><a href="/p/${encodeURIComponent(item.slug)}">${escapeHtml(item.title)}</a><span>${escapeHtml(item.summary ?? '')}</span></li>`).join('');
    return send(res, 200, publicShell('Welkom', 'Gepubliceerde pagina’s en artikelen.', `<section class="public-hero"><p class="eyebrow">CMS · ERP</p><h1>Welkom</h1><p>Gepubliceerde pagina’s en artikelen.</p></section><ul class="public-list">${links || '<li>Nog geen gepubliceerde content.</li>'}</ul>`));
  }
  if (req.method === 'GET' && url.pathname.startsWith('/p/')) {
    let slug;
    try { slug = decodeURIComponent(url.pathname.slice(3)); } catch { return send(res, 404, 'Niet gevonden.'); }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) return send(res, 404, 'Niet gevonden.');
    const item = content.getPublished(slug);
    if (!item) return send(res, 404, 'Niet gevonden.');
    return send(res, 200, publicShell(item.seoTitle, item.seoDescription, renderPublicContent(item)));
  }

  if (await handleContent(req, res)) return;
  if (await handleOperations(req, res)) return;
  send(res, 404, 'Niet gevonden.');
}

const server = createServer((req, res) => {
  route(req, res).catch(() => {
    const requestId = randomUUID();
    console.error(JSON.stringify({ event: 'host_request_error', requestId }));
    if (!res.headersSent) send(res, 500, 'Er ging iets mis. Probeer het later opnieuw.');
    else res.destroy();
  });
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 100;

const portValue = Number(process.env.PORT ?? (originUrl.port || 3000));
if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) throw new Error('PORT must be an integer from 1 through 65535.');
const listenHost = process.env.CMS_ERP_HOST ?? (production ? '0.0.0.0' : '127.0.0.1');
server.listen(portValue, listenHost, () => {
  console.log(JSON.stringify({ event: 'server_started', origin: allowedOrigin, host: listenHost, port: portValue }));
});

function close() {
  server.close(() => {
    void mcpEndpoint?.close().catch(() => {});
    content.close();
    operations.close();
    auth.close();
  });
}
process.once('SIGINT', close);
process.once('SIGTERM', close);
