// SPDX-License-Identifier: GPL-3.0-or-later
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

const oauthSchemes = (scopes) => [{ type: 'oauth2', scopes }];
const pageSchema = z.object({ limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1000000).optional() }).strict();
const cmsPageSchema = pageSchema.extend({ type: z.enum(['page', 'article', 'service', 'project', 'faq']).optional(), status: z.enum(['draft', 'published', 'archived']).optional() });
const textBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('paragraph'), text: z.string() }).strict(),
  z.object({ type: z.literal('heading'), level: z.number().int(), text: z.string() }).strict(),
  z.object({ type: z.literal('list'), ordered: z.boolean(), items: z.array(z.string()) }).strict(),
]);
const contentSchema = z.object({
  type: z.enum(['page', 'article', 'service', 'project', 'faq']),
  title: z.string(), slug: z.string(), summary: z.string().optional(), blocks: z.array(textBlock).min(1).max(100),
  seoTitle: z.string().optional(), seoDescription: z.string().optional(),
}).strict();
const idSchema = z.number().int().positive().safe();
const idVersionSchema = z.object({ id: idSchema, version: idSchema }).strict();
const idemSchema = z.string().min(8).max(100).regex(/^[A-Za-z0-9._:-]+$/u);
const scheduleSchema = z.object({ resourceId: idSchema, startAt: z.string(), endAt: z.string() }).strict();
const commandNames = [
  'create-resource', 'create-customer', 'create-product', 'adjust-stock', 'create-quote', 'quote-status',
  'workorder-from-quote', 'schedule-workorder', 'workorder-status', 'record-hours', 'reserve-inventory',
  'consume-inventory', 'release-inventory', 'issue-invoice', 'record-payment', 'issue-credit-note',
];
const financeCommandNames = ['issue-invoice', 'record-payment', 'issue-credit-note'];
const standardCommandNames = commandNames.filter((command) => !financeCommandNames.includes(command));
const commandFields = {
  input: z.record(z.string(), z.json()),
  idempotencyKey: idemSchema,
};
const commandSchema = z.object({ command: z.enum(standardCommandNames), ...commandFields }).strict();
const financeCommandSchema = z.object({ command: z.enum(financeCommandNames), ...commandFields }).strict();

function ownObject(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    const error = new Error('INVALID_INPUT'); error.code = 'VALIDATION'; error.status = 422; throw error;
  }
}

function jsonResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: { data } };
}

function errorResult(error) {
  const code = /^[A-Z][A-Z0-9_]{0,63}$/u.test(error?.code ?? '') ? error.code : 'REQUEST_REJECTED';
  return {
    isError: true,
    content: [{ type: 'text', text: code }],
    structuredContent: { error: code },
  };
}

function authorizationRequired(authInfo, scopes, configuredResourceMetadataUrl) {
  const missingScopes = scopes.filter((scope) => !authInfo?.scopes?.includes(scope));
  if (missingScopes.length === 0) return null;
  const resourceMetadataUrl = authInfo?.resourceMetadataUrl ?? configuredResourceMetadataUrl ??
    (authInfo?.resource ? `${new URL(authInfo.resource).origin}/.well-known/oauth-protected-resource/mcp` : undefined);
  const metadata = resourceMetadataUrl ? ` resource_metadata="${resourceMetadataUrl}",` : '';
  const challenge = `Bearer${metadata} error="insufficient_scope", error_description="Authentication is required.", scope="${missingScopes.join(' ')}"`;
  return {
    isError: true,
    content: [{ type: 'text', text: 'AUTHORIZATION_REQUIRED' }],
    structuredContent: { error: 'AUTHORIZATION_REQUIRED' },
    _meta: { 'mcp/www_authenticate': [challenge] },
  };
}

function requireActor(auth, authInfo) {
  const identity = authInfo?.extra;
  const actor = auth.actorForExternalIdentity(identity?.issuer, identity?.subject);
  if (!actor) {
    const error = new Error('ACCOUNT_NOT_LINKED'); error.code = 'ACCOUNT_NOT_LINKED'; error.status = 403; throw error;
  }
  return actor;
}

function invokeCommand(operations, auth, actor, command, input, key) {
  switch (command) {
    case 'create-resource':
      ownObject(input, ['name', 'technicianId'], ['name', 'technicianId']);
      if (!Number.isSafeInteger(input.technicianId) || !auth.isActiveTechnician(input.technicianId)) {
        const error = new Error('INVALID_TECHNICIAN'); error.code = 'FORBIDDEN'; error.status = 403; throw error;
      }
      return operations.createResource(actor, input, key);
    case 'create-customer': return operations.createCustomer(actor, input, key);
    case 'create-product': return operations.createProduct(actor, input, key);
    case 'adjust-stock': return operations.adjustStock(actor, input, key);
    case 'create-quote': return operations.createQuote(actor, input, key);
    case 'quote-status':
      ownObject(input, ['id', 'status', 'version'], ['id', 'status', 'version']);
      return operations.transitionQuote(actor, input.id, input.status, input.version, key);
    case 'workorder-from-quote':
      ownObject(input, ['quoteId', 'schedule'], ['quoteId', 'schedule']);
      return operations.createWorkorderFromQuote(actor, input.quoteId, input.schedule, key);
    case 'schedule-workorder':
      ownObject(input, ['id', 'schedule', 'version'], ['id', 'schedule', 'version']);
      return operations.scheduleWorkorder(actor, input.id, input.schedule, input.version, key);
    case 'workorder-status':
      ownObject(input, ['id', 'status', 'version'], ['id', 'status', 'version']);
      return operations.transitionWorkorder(actor, input.id, input.status, input.version, key);
    case 'record-hours': return operations.recordHours(actor, input, key);
    case 'reserve-inventory': return operations.reserveInventory(actor, input, key);
    case 'consume-inventory': return operations.consumeInventory(actor, input, key);
    case 'release-inventory': return operations.releaseInventory(actor, input, key);
    case 'issue-invoice': return operations.issueInvoice(actor, input, key);
    case 'record-payment': return operations.recordPayment(actor, input, key);
    case 'issue-credit-note': return operations.issueCreditNote(actor, input, key);
    default: { const error = new Error('UNKNOWN_COMMAND'); error.code = 'VALIDATION'; error.status = 422; throw error; }
  }
}

export function createMcpServer({ auth, content, operations, authInfo, resourceMetadataUrl, onError = () => {} }) {
  const server = new McpServer({ name: 'CAI-Techniek CMS ERP', version: '0.2.0' });
  const register = (name, title, description, scopes, inputSchema, annotations, callback) => {
    const tool = server.registerTool(name, {
      title,
      description,
      inputSchema,
      annotations,
      _meta: {},
    }, async (input) => {
      const challenge = authorizationRequired(authInfo, scopes, resourceMetadataUrl);
      if (challenge) return challenge;
      try { return jsonResult(await callback(input)); }
      catch (error) {
        if (error?.status >= 500) { try { onError({ tool: name, code: 'INTERNAL_ERROR' }); } catch { /* logging is best effort */ } }
        return errorResult(error);
      }
    });
    tool.securitySchemes = oauthSchemes(scopes);
  };

  register('get_my_profile', 'Mijn gekoppelde account', 'Toont uitsluitend de Auth0-identiteit van de ingelogde gebruiker en of die aan een actief CMS/ERP-account gekoppeld is. De rol wordt uit de lokale gebruikersadministratie gelezen.', ['profile:read'], z.object({}).strict(), { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, () => {
    const identity = authInfo?.extra;
    if (!identity?.issuer || !identity?.subject || !identity?.organizationId) throw Object.assign(new Error('INVALID_TOKEN_CONTEXT'), { code: 'INVALID_TOKEN' });
    const actor = auth.actorForExternalIdentity(identity.issuer, identity.subject);
    return { issuer: identity.issuer, subject: identity.subject, organizationId: identity.organizationId, accountLinked: Boolean(actor), role: actor?.role ?? null };
  });
  register('complete_account_link', 'CMS/ERP-account koppelen', 'Koppelt de geverifieerde Auth0-identiteit van deze sessie aan een account nadat een admin een eenmalige code heeft aangemaakt. De code verloopt na tien minuten en is na gebruik ongeldig.', ['profile:link'], z.object({ code: z.string().min(32).max(100).regex(/^[A-Za-z0-9._~-]+$/u) }).strict(), { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, ({ code }) => {
    const identity = authInfo?.extra;
    const result = auth.completeAuth0IdentityLink(identity?.issuer, identity?.subject, code);
    if (result.error) throw Object.assign(new Error(result.error), { code: result.error, status: result.error === 'IDENTITY_IN_USE' ? 409 : 400 });
    return result.data;
  });

  register('cms_list', 'CMS-content zoeken', 'Leest beheerde content met dezelfde zichtbaarheid als de gekoppelde CMS-gebruiker. Gebruik limit/offset voor paginering.', ['cms:read'], cmsPageSchema, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, (input) => content.listManaged(requireActor(auth, authInfo), input));
  register('cms_get', 'CMS-content lezen', 'Leest één beheerd contentitem, inclusief huidige versie en reviewstatus.', ['cms:read'], z.object({ id: idSchema }).strict(), { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, ({ id }) => content.getManaged(requireActor(auth, authInfo), id));
  register('cms_revisions', 'CMS-revisies lezen', 'Leest de onveranderlijke revisiegeschiedenis voor een contentitem.', ['cms:read'], z.object({ id: idSchema }).strict(), { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, ({ id }) => content.listRevisions(requireActor(auth, authInfo), id));
  register('cms_create', 'CMS-concept maken', 'Maakt een nieuw concept. Publiceren vereist daarna indienen voor review en een publisher- of adminaccount.', ['cms:write'], z.object({ content: contentSchema, idempotencyKey: idemSchema }).strict(), { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, ({ content: draft, idempotencyKey }) => content.createContent(requireActor(auth, authInfo), draft, idempotencyKey));
  register('cms_update', 'CMS-content bewerken', 'Bewerkt een contentitem met optimistische versiecontrole. Een wijziging wist de bestaande reviewaanvraag; dien daarna opnieuw ter review in.', ['cms:write'], z.object({ id: idSchema, version: idSchema, content: contentSchema, idempotencyKey: idemSchema }).strict(), { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, ({ id, version, content: draft, idempotencyKey }) => content.updateContent(requireActor(auth, authInfo), id, draft, version, idempotencyKey));
  register('cms_submit_review', 'CMS-content ter review aanbieden', 'Zet een concept met de opgegeven actuele versie op review. De bestaande gepubliceerde versie blijft zichtbaar tot een publisher de nieuwe versie publiceert.', ['cms:write'], z.object({ ...idVersionSchema.shape, idempotencyKey: idemSchema }).strict(), { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, ({ id, version, idempotencyKey }) => content.submitForReview(requireActor(auth, authInfo), id, version, idempotencyKey));
  register('cms_return_for_changes', 'CMS-review terugsturen', 'Vraagt de editor om wijzigingen voor de actuele reviewversie.', ['cms:review'], z.object({ ...idVersionSchema.shape, idempotencyKey: idemSchema }).strict(), { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, ({ id, version, idempotencyKey }) => content.returnForChanges(requireActor(auth, authInfo), id, version, idempotencyKey));
  register('cms_publish', 'CMS-content publiceren', 'Publiceert uitsluitend een ingediende reviewversie met de actuele versie. Deze actie maakt content publiek.', ['cms:review'], z.object({ ...idVersionSchema.shape, idempotencyKey: idemSchema }).strict(), { readOnlyHint: false, destructiveHint: true, openWorldHint: true }, ({ id, version, idempotencyKey }) => content.publishContent(requireActor(auth, authInfo), id, version, idempotencyKey));
  register('cms_archive', 'CMS-content archiveren', 'Archiveert een contentitem met actuele versiecontrole en verwijdert de publieke snapshot.', ['cms:review'], z.object({ ...idVersionSchema.shape, idempotencyKey: idemSchema }).strict(), { readOnlyHint: false, destructiveHint: true, openWorldHint: true }, ({ id, version, idempotencyKey }) => content.archiveContent(requireActor(auth, authInfo), id, version, idempotencyKey));

  register('erp_list', 'ERP-lijst lezen', 'Leest een pagina uit een ERP-entiteit. De ERP-service past rol- en eigenaarbeperkingen toe, ook op financiële data en auditlog.', ['erp:read'], z.object({ entity: z.enum(['resources', 'customers', 'products', 'quotes', 'workorders', 'hours', 'reservations', 'movements', 'invoices', 'payments', 'credits', 'outbox', 'audit']), ...pageSchema.shape }).strict(), { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, ({ entity, limit, offset }) => operations.list(requireActor(auth, authInfo), entity, { ...(limit === undefined ? {} : { limit }), ...(offset === undefined ? {} : { offset }) }));
  register('erp_get', 'ERP-record lezen', 'Leest één ERP-record. De ERP-service past rol- en eigenaarbeperkingen toe.', ['erp:read'], z.object({ entity: z.enum(['resources', 'customers', 'products', 'quotes', 'workorders', 'hours', 'movements', 'invoices', 'payments', 'credits', 'outbox', 'audit']), id: idSchema }).strict(), { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, ({ entity, id }) => operations.get(requireActor(auth, authInfo), entity, id));
  register('erp_execute', 'ERP-opdracht uitvoeren', 'Voert één expliciete niet-financiële ERP-opdracht uit. Elke write vereist een unieke idempotencyKey; de bestaande ERP-engine controleert invoer, rol, eigenaarschap, transacties, audit en eventuele versieconflicten. Gebruik bedragen in centen en aantallen in de door de engine vereiste integer-eenheden.', ['erp:write'], commandSchema, { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, ({ command, input, idempotencyKey }) => {
    const actor = requireActor(auth, authInfo);
    return invokeCommand(operations, auth, actor, command, input, idempotencyKey);
  });

  register('erp_execute_finance', 'Financiële ERP-opdracht uitvoeren', 'Voert een factuur-, betalings- of creditnotaboeking uit. Vereist zowel erp:write als erp:finance; de ERP-engine controleert daarnaast de lokale rol, transacties, audit en idempotencyKey.', ['erp:write', 'erp:finance'], financeCommandSchema, { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, ({ command, input, idempotencyKey }) => {
    const actor = requireActor(auth, authInfo);
    return invokeCommand(operations, auth, actor, command, input, idempotencyKey);
  });

  // The current MCP SDK serializes tool _meta but has no first-class
  // securitySchemes config field. Add the OpenAI per-tool extension to the
  // actual tools/list wire definitions here.
  const listTools = server.server._requestHandlers.get('tools/list');
  server.server.setRequestHandler('tools/list', async (...args) => {
    const result = await listTools(...args);
    return {
      ...result,
      tools: result.tools.map((listedTool) => ({
        ...listedTool,
        securitySchemes: server._registeredTools[listedTool.name].securitySchemes,
      })),
    };
  });

  return server;
}

export const mcpCommands = Object.freeze([...commandNames]);
