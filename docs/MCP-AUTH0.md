# ChatGPT MCP endpoint with Auth0

The local host exposes an optional stateless MCP endpoint at `/mcp`. It calls
the existing `ContentService` and `OperationsService`; it does not start a
second application or connect to the CAI-Techniek Site. The endpoint returns
404 while Auth0 is unconfigured. Supplying only part of the required Auth0
configuration prevents the host from starting.

## Configuration

Set these runtime variables outside Git:

| Variable | Meaning |
| --- | --- |
| `AUTH0_ISSUER` | Exact HTTPS Auth0 issuer URL, including its trailing slash. |
| `AUTH0_AUDIENCE` | Must exactly equal `CMS_ERP_ORIGIN/mcp`. Configure the same value as the Auth0 API identifier. |
| `AUTH0_ORGANIZATION_ID` | Required Auth0 organization claim for this single-organization installation. |
| `AUTH0_JWKS_URL` | Optional HTTPS JWKS URL. Defaults to `/.well-known/jwks.json` under the issuer. |

The API must issue RS256 access tokens with `iss`, `aud`, `exp`, `iat`, `sub`,
and the expected `org_id`. The verifier accepts scopes from `scope` and
`permissions`, rejects other organizations, and does not accept a role from the
token. It requires the MCP API audience; Auth0's optional second `/userinfo`
audience is accepted for user tokens, while other audiences are rejected.
Configure Auth0's Resource Parameter Compatibility Profile so the requested
MCP `resource` is represented as the API token audience. Keep all
provider client secrets in Auth0's provider configuration or the deployment
secret manager; no credential values belong in this repository.

The resource metadata is served at
`/.well-known/oauth-protected-resource/mcp` (and the root alias) and points to
the Auth0 issuer. The MCP server does not implement an authorization server or
store access tokens. Auth0 handles the OAuth authorization-code/PKCE flow;
ChatGPT's actual OAuth client registration and redirect configuration still
need to be confirmed for the deployment.

## Linking an Auth0 identity to an existing account

1. An admin creates the intended CMS/ERP user with the right local role.
2. In the admin user list, choose **Auth0-koppeling starten**. The browser
   creates a random one-time code; only its SHA-256 hash is stored. The code
   expires after ten minutes and a new code invalidates prior pending codes for
   that user.
3. The user authenticates to the configured ChatGPT plugin and calls
   `complete_account_link` with that code. The server links the exact verified
   `(issuer, subject)` from the Auth0 access token. The code can only be used
   once; the audit row records the target user and initiating admin.
4. `get_my_profile` can confirm that the identity is linked. Role changes and
   account disablement remain in the local admin user store.

The server never matches an account by email and never accepts a role or
organization from a tool argument.

## Tools and authorization

- `get_my_profile` (`profile:read`), `complete_account_link` (`profile:link`)
- `cms_list`, `cms_get`, `cms_revisions`, `cms_create`, `cms_update`,
  `cms_submit_review`, `cms_return_for_changes`, `cms_publish`, `cms_archive`
- `erp_list`, `erp_get`, `erp_execute`, `erp_execute_finance`

Every tool advertises its OAuth `securitySchemes` at the top level of the
`tools/list` result. Anonymous discovery is allowed; a tool call without its
required scopes returns an error result with `_meta["mcp/www_authenticate"]`
and the protected-resource metadata URL so ChatGPT can start or renew OAuth
linking. The service layer then checks the linked local account's role and,
for technicians, record ownership.
All writes require an idempotency key. CMS publication/archive keeps the CMS
review and optimistic-version rules. ERP writes continue through the existing
transactional engine; financial commands also require `erp:finance` and a local
`admin` or `finance` role. A scope does not replace a local role check.
Financial commands are exposed through `erp_execute_finance`, which advertises
and requires both `erp:write` and `erp:finance`; the ordinary `erp_execute`
tool accepts only non-financial commands.

## Deployment boundary

The host is currently single-organization and is not multi-tenant SaaS. Use a
separate deployment, database and Auth0 organization per business. Do not put
this standalone host on the existing CAI Site or replace `/app/cms` or its
existing authentication. Site-hosted MCP is a separate integration path and
must use the Site platform's own hosting authentication as documented by its
Site skill.

This is source implementation only. A public ChatGPT plugin still needs a
public HTTPS deployment, Auth0 tenant/API/client setup, live authorization and
tool acceptance, plugin metadata/package, and the required OpenAI review. None
of those live or publication results is claimed here. OpenAI's tool-level
OAuth flow specifically relies on per-tool `securitySchemes` plus a tool
error carrying `_meta["mcp/www_authenticate"]`; the local implementation
provides both in its wire response, but must still be checked against a live
ChatGPT connection after deployment.
