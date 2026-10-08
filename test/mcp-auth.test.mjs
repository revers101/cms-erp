// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { bearerTokenFromRequest, createAuth0AccessTokenVerifier, createMcpAuthConfig } from '../src/mcp-auth.mjs';

const issuer = 'https://cai-test.eu.auth0.com/';
const origin = 'https://cms.example.test';
const audience = `${origin}/mcp`;
const organizationId = 'org_cai_test';
let jwks;
let privateKey;
let config;

async function token(claims = {}, aud = audience, issuedAt = Math.floor(Date.now() / 1000)) {
  return new SignJWT({ org_id: organizationId, scope: 'profile:read cms:read erp:read', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(aud)
    .setSubject(claims.sub ?? 'auth0|synthetic-user')
    .setIssuedAt(issuedAt)
    .setExpirationTime('2m')
    .sign(privateKey);
}

test('Auth0 config is opt-in, complete, and bound to the exact MCP resource', () => {
  assert.equal(createMcpAuthConfig({}, origin), null);
  assert.throws(() => createMcpAuthConfig({ AUTH0_ISSUER: issuer }, origin), /requires AUTH0_ISSUER/u);
  assert.throws(() => createMcpAuthConfig({ AUTH0_ISSUER: issuer, AUTH0_AUDIENCE: 'https://other.example/mcp', AUTH0_ORGANIZATION_ID: organizationId }, origin), /exactly match/u);
  assert.throws(() => createMcpAuthConfig({ AUTH0_ISSUER: issuer, AUTH0_AUDIENCE: audience, AUTH0_ORGANIZATION_ID: organizationId, AUTH0_JWKS_URL: 'https://other.example/jwks.json' }, origin), /issuer origin/u);
  config = createMcpAuthConfig({ AUTH0_ISSUER: issuer, AUTH0_AUDIENCE: audience, AUTH0_ORGANIZATION_ID: organizationId }, origin);
  assert.equal(config.resource, audience);
});

test('Auth0 verifier validates RS256 issuer, API audience, organization, and scopes', async (t) => {
  const keys = await generateKeyPair('RS256');
  privateKey = keys.privateKey;
  const publicJwk = await exportJWK(keys.publicKey);
  jwks = createLocalJWKSet({ keys: [{ ...publicJwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] });
  const verify = createAuth0AccessTokenVerifier(config, { jwks });
  const claims = await verify(await token());
  assert.equal(claims.clientId, 'auth0|synthetic-user');
  assert.equal(claims.resource, audience);
  assert.equal(claims.extra.issuer, issuer);
  assert.equal(claims.extra.organizationId, organizationId);
  assert.deepEqual(claims.scopes, ['profile:read', 'cms:read', 'erp:read']);
  assert.ok(claims.expiresAt > Math.floor(Date.now() / 1000));
  const userinfoAudience = await verify(await token({}, [audience, new URL('userinfo', issuer).href]));
  assert.equal(userinfoAudience.resource, audience);

  await assert.rejects(verify(await token({ org_id: 'org_other' })), /INVALID_TOKEN/u);
  await assert.rejects(verify(await token({}, audience, Math.floor(Date.now() / 1000) + 60)), /INVALID_TOKEN/u);
  await assert.rejects(verify(await token({}, [audience, 'https://other.example'])), /INVALID_TOKEN/u);
  await assert.rejects(verify('not-a-jwt'), /INVALID_TOKEN/u);
});

test('Bearer parser accepts one compact token and rejects malformed headers', () => {
  assert.equal(bearerTokenFromRequest({ headers: { authorization: 'Bearer abc.def_ghi-123' } }), 'abc.def_ghi-123');
  assert.equal(bearerTokenFromRequest({ headers: { authorization: 'Basic abc' } }), null);
  assert.equal(bearerTokenFromRequest({ headers: { authorization: ['Bearer one', 'Bearer two'] } }), null);
});
