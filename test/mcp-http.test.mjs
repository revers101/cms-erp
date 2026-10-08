// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createMcpEndpoint } from '../src/mcp-http.mjs';

test('MCP HTTP endpoint publishes resource metadata, per-tool scopes, and OAuth challenges', async (t) => {
  let endpoint;
  const server = createServer(async (req, res) => {
    if (await endpoint.handle(req, res)) return;
    res.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const issuer = 'https://cai-test.eu.auth0.com/';
  endpoint = createMcpEndpoint({
    auth: { actorForExternalIdentity: () => null },
    content: {},
    operations: {},
    origin,
    env: {
      AUTH0_ISSUER: issuer,
      AUTH0_AUDIENCE: `${origin}/mcp`,
      AUTH0_ORGANIZATION_ID: 'org_cai_test',
    },
    verifyToken: async (token) => {
      if (!['synthetic-valid-token', 'synthetic-write-token'].includes(token)) throw new Error('INVALID_TOKEN');
      return {
        token,
        clientId: 'synthetic-client',
        scopes: token === 'synthetic-write-token'
          ? ['erp:write']
          : ['profile:read', 'profile:link', 'cms:read', 'cms:write', 'cms:review', 'erp:read', 'erp:write', 'erp:finance'],
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        resource: `${origin}/mcp`,
        resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp`,
        extra: { issuer, subject: 'auth0|synthetic-user', organizationId: 'org_cai_test' },
      };
    },
  });
  t.after(async () => {
    await endpoint.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const metadataResponse = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  assert.equal(metadata.resource, `${origin}/mcp`);
  assert.ok(metadata.scopes_supported.includes('profile:link'));

  const toolsResponse = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(toolsResponse.status, 200);
  const toolsEvent = (await toolsResponse.text()).split(/\r?\n/u).find((line) => line.startsWith('data: '));
  assert.ok(toolsEvent);
  const toolsPayload = JSON.parse(toolsEvent.slice('data: '.length));
  const names = toolsPayload.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('cms_list'));
  assert.ok(names.includes('erp_execute_finance'));
  const financeTool = toolsPayload.result.tools.find((tool) => tool.name === 'erp_execute_finance');
  assert.deepEqual(financeTool.securitySchemes[0].scopes, ['erp:write', 'erp:finance']);

  const unauthenticatedCall = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'cms_list', arguments: { limit: 5 } },
    }),
  });
  assert.equal(unauthenticatedCall.status, 200);
  const unauthenticatedEvent = (await unauthenticatedCall.text()).split(/\r?\n/u).find((line) => line.startsWith('data: '));
  const unauthenticatedPayload = JSON.parse(unauthenticatedEvent.slice('data: '.length));
  assert.equal(unauthenticatedPayload.result.isError, true);
  assert.equal(unauthenticatedPayload.result.structuredContent.error, 'AUTHORIZATION_REQUIRED');
  const authChallenge = unauthenticatedPayload.result._meta['mcp/www_authenticate'][0];
  assert.match(authChallenge, /oauth-protected-resource\/mcp/u);
  assert.match(authChallenge, /error="insufficient_scope"/u);
  assert.match(authChallenge, /error_description=/u);

  const financeDenied = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer synthetic-write-token',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'erp_execute_finance', arguments: { command: 'issue-invoice', input: {}, idempotencyKey: 'synthetic-idem-01' } },
    }),
  });
  assert.equal(financeDenied.status, 200);
  const financeDeniedEvent = (await financeDenied.text()).split(/\r?\n/u).find((line) => line.startsWith('data: '));
  const financeDeniedPayload = JSON.parse(financeDeniedEvent.slice('data: '.length));
  assert.equal(financeDeniedPayload.result.isError, true);
  assert.deepEqual(financeDeniedPayload.result._meta['mcp/www_authenticate'], [
    `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", error_description="Authentication is required.", scope="erp:finance"`,
  ]);
});
