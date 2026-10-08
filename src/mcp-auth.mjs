// SPDX-License-Identifier: GPL-3.0-or-later
import { createRemoteJWKSet, jwtVerify } from 'jose';

const auth0Vars = ['AUTH0_ISSUER', 'AUTH0_AUDIENCE', 'AUTH0_ORGANIZATION_ID'];
const safeText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);

export function createMcpAuthConfig(env, origin) {
  const supplied = auth0Vars.some((name) => env[name]) || Boolean(env.AUTH0_JWKS_URL);
  if (!supplied) return null;
  if (auth0Vars.some((name) => !env[name])) throw new Error('MCP Auth0 requires AUTH0_ISSUER, AUTH0_AUDIENCE and AUTH0_ORGANIZATION_ID together.');
  const issuerUrl = new URL(env.AUTH0_ISSUER);
  if (issuerUrl.protocol !== 'https:' || issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash ||
      issuerUrl.pathname !== '/' || env.AUTH0_ISSUER !== issuerUrl.href) {
    throw new Error('AUTH0_ISSUER must be an exact HTTPS issuer URL ending in a slash.');
  }
  const resource = new URL('/mcp', origin).href;
  if (env.AUTH0_AUDIENCE !== resource) throw new Error('AUTH0_AUDIENCE must exactly match CMS_ERP_ORIGIN + /mcp.');
  if (!safeText(env.AUTH0_ORGANIZATION_ID, 128)) throw new Error('AUTH0_ORGANIZATION_ID is invalid.');
  const jwksUrl = env.AUTH0_JWKS_URL ? new URL(env.AUTH0_JWKS_URL) : new URL('.well-known/jwks.json', issuerUrl);
  if (jwksUrl.protocol !== 'https:' || jwksUrl.username || jwksUrl.password || jwksUrl.hash || jwksUrl.origin !== issuerUrl.origin) throw new Error('AUTH0_JWKS_URL must be an HTTPS URL on the Auth0 issuer origin.');
  return Object.freeze({ issuer: issuerUrl.href, audience: resource, organizationId: env.AUTH0_ORGANIZATION_ID, resource, jwksUrl: jwksUrl.href });
}

export function createAuth0AccessTokenVerifier(config, { jwks = createRemoteJWKSet(new URL(config.jwksUrl), { timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 600000 }) } = {}) {
  return async function verifyAccessToken(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 16384) throw new Error('INVALID_TOKEN');
    const { payload, protectedHeader } = await jwtVerify(token, jwks, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub', 'org_id'],
      clockTolerance: 5,
    });
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const allowedAudiences = new Set([config.audience, new URL('userinfo', config.issuer).href]);
    if (protectedHeader.alg !== 'RS256' || !audiences.includes(config.audience) ||
        audiences.some((audience) => !allowedAudiences.has(audience)) ||
        !Number.isSafeInteger(payload.iat) || payload.iat > Math.floor(Date.now() / 1000) + 5 ||
        !safeText(payload.sub, 255) || payload.org_id !== config.organizationId) throw new Error('INVALID_TOKEN');
    const scopeClaims = [
      ...(typeof payload.scope === 'string' ? payload.scope.split(/\s+/u) : []),
      ...(Array.isArray(payload.permissions) ? payload.permissions.filter((item) => typeof item === 'string') : []),
    ];
    const scopes = [...new Set(scopeClaims.filter((scope) => /^[A-Za-z0-9:._-]{1,100}$/u.test(scope)))];
    return {
      token,
      clientId: safeText(payload.client_id, 255) ? payload.client_id : (safeText(payload.azp, 255) ? payload.azp : payload.sub),
      scopes,
      expiresAt: payload.exp,
      resource: config.resource,
      resourceMetadataUrl: `${new URL(config.resource).origin}/.well-known/oauth-protected-resource/mcp`,
      extra: { issuer: config.issuer, subject: payload.sub, organizationId: payload.org_id },
    };
  };
}

export function bearerTokenFromRequest(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || header.length > 17000) return null;
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/iu.exec(header);
  return match?.[1] ?? null;
}
