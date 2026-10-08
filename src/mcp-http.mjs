// SPDX-License-Identifier: GPL-3.0-or-later
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { bearerTokenFromRequest, createAuth0AccessTokenVerifier, createMcpAuthConfig } from './mcp-auth.mjs';
import { createMcpServer } from './mcp.mjs';

const scopesSupported = Object.freeze(['profile:read', 'profile:link', 'cms:read', 'cms:write', 'cms:review', 'erp:read', 'erp:write', 'erp:finance']);
const requestsPerMinute = 120;

function writeJson(res, status, value, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(value));
}

export function createMcpEndpoint({ auth, content, operations, origin, env = process.env, verifyToken, onError = () => {} }) {
  const config = createMcpAuthConfig(env, origin);
  if (!config) return null;
  const verifier = verifyToken ?? createAuth0AccessTokenVerifier(config);
  const challenge = `Bearer resource_metadata="${new URL(config.resource).origin}/.well-known/oauth-protected-resource/mcp", scope="${scopesSupported.join(' ')}"`;
  const resourceMetadataUrl = `${new URL(config.resource).origin}/.well-known/oauth-protected-resource/mcp`;
  const handler = createMcpHandler((context) => createMcpServer({ auth, content, operations, authInfo: context.authInfo, resourceMetadataUrl, onError }), {
    legacy: 'stateless',
    maxRequestBodySize: 1048576,
    onerror: (error) => { try { onError({ code: 'MCP_TRANSPORT_ERROR', name: error?.name ?? 'Error' }); } catch { /* no token or request body is logged */ } },
  });
  const nodeHandler = toNodeHandler(handler, { maxRequestBodySize: 1048576, onerror: (error) => { try { onError({ code: 'MCP_ADAPTER_ERROR', name: error?.name ?? 'Error' }); } catch { /* no token or request body is logged */ } } });
  const metadata = Object.freeze({
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: scopesSupported,
    bearer_methods_supported: ['header'],
  });
  const metadataPaths = new Set(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']);
  const rates = new Map();
  return Object.freeze({
    resource: config.resource,
    metadata,
    async handle(req, res) {
      if (req.method === 'GET' && metadataPaths.has(new URL(req.url, origin).pathname)) {
        writeJson(res, 200, metadata, { 'Access-Control-Allow-Origin': '*' });
        return true;
      }
      if (new URL(req.url, origin).pathname !== '/mcp') return false;
      const token = bearerTokenFromRequest(req);
      let authInfo;
      if (token) {
        try { authInfo = await verifier(token); }
        catch {
          writeJson(res, 401, { error: 'INVALID_TOKEN' }, { 'WWW-Authenticate': `${challenge}, error="invalid_token"` });
          return true;
        }
      }
      const identityKey = authInfo
        ? `${authInfo.extra.issuer}\n${authInfo.extra.subject}`
        : `anonymous\n${req.socket.remoteAddress ?? 'unknown'}`;
      const now = Date.now();
      for (const [key, entry] of rates) if (entry.expiresAt <= now) rates.delete(key);
      if (!rates.has(identityKey) && rates.size >= 10000) {
        writeJson(res, 503, { error: 'RATE_CAPACITY' }, { 'Retry-After': '60' });
        return true;
      }
      const rate = rates.get(identityKey) ?? { count: 0, expiresAt: now + 60000 };
      rate.count += 1;
      rates.set(identityKey, rate);
      if (rate.count > requestsPerMinute) {
        writeJson(res, 429, { error: 'RATE_LIMITED' }, { 'Retry-After': String(Math.max(1, Math.ceil((rate.expiresAt - now) / 1000))) });
        return true;
      }
      if (authInfo) req.auth = authInfo;
      try { await nodeHandler(req, res); }
      catch {
        if (!res.headersSent) writeJson(res, 500, { error: 'MCP_REQUEST_FAILED' });
        else res.destroy();
      }
      return true;
    },
    async close() { await handler.close(); },
  });
}

export { scopesSupported };
