// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMcpServer } from '../src/mcp.mjs';

function createServer() {
  return createMcpServer({ auth: {}, content: {}, operations: {}, authInfo: {} });
}

test('every MCP tool declares explicit boolean safety annotations', () => {
  const tools = createServer()._registeredTools;
  for (const [name, tool] of Object.entries(tools)) {
    for (const key of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) {
      assert.equal(typeof tool.annotations?.[key], 'boolean', `${name}.${key}`);
    }
  }
});

test('MCP tools advertise a separate, least-privilege scope for account linking', () => {
  const tools = createServer()._registeredTools;
  assert.deepEqual(tools.get_my_profile.securitySchemes[0].scopes, ['profile:read']);
  assert.deepEqual(tools.complete_account_link.securitySchemes[0].scopes, ['profile:link']);
});

test('financial MCP commands require both write and finance scopes', () => {
  const tools = createServer()._registeredTools;
  const ordinaryWrite = { command: 'create-customer', input: {}, idempotencyKey: 'stable-key-01' };
  const invoice = { command: 'issue-invoice', input: {}, idempotencyKey: 'stable-key-02' };

  assert.deepEqual(tools.erp_execute.securitySchemes[0].scopes, ['erp:write']);
  assert.equal(tools.erp_execute.inputSchema.safeParse(ordinaryWrite).success, true);
  assert.equal(tools.erp_execute.inputSchema.safeParse(invoice).success, false);

  assert.deepEqual(tools.erp_execute_finance.securitySchemes[0].scopes, ['erp:write', 'erp:finance']);
  assert.equal(tools.erp_execute_finance.inputSchema.safeParse(invoice).success, true);
  assert.equal(tools.erp_execute_finance.inputSchema.safeParse(ordinaryWrite).success, false);
});
