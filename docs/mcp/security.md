# Authentication and safety

The hosted MCP endpoint is public at the network layer but every operation requires a valid OAuth bearer token or MCP API key.

## OAuth 2.1

OAuth is recommended for interactive MCP clients.

The endpoint publishes protected-resource metadata, validates issuer and audience, and maps the authenticated identity back to the same Cognito owner used by the dashboard. Client registration, PKCE, login, and consent are handled by the configured authorization server.

Paste the MCP endpoint into a compatible client's remote connector dialog:

```text
https://lacdatamelsv55cio7jpnn5jxe0yvuvm.lambda-url.ap-southeast-2.on.aws/
```

The client should discover the OAuth flow automatically.

## API keys

API keys are intended for header-capable automation clients and the local worker.

Generate a key locally from `frontend/`:

```sh
npm run mcp:key
```

Store only its SHA-256 hash, prefix, label, and owner in the dashboard data store. Keep the raw key in the client because it cannot be recovered later.

Send it with:

```http
X-API-Key: nd_mcp_...
```

Revoking the corresponding key record prevents future authentication.

## Owner isolation

Authentication alone is not treated as authorization. Every MCP read and write:

1. Filters by the authenticated Cognito owner.
2. Rechecks ownership after data is returned.
3. Rejects foreign model, run, provider, parent-model, job, or submission IDs.

The control plane stamps the authenticated owner on records it creates. A caller cannot choose another owner in tool input.

## Secrets

Provider and Numerai secrets are not returned by MCP tools. Provider listings expose operational metadata but omit API-key references, secret references, and credential payloads.

The MCP model tools do not edit provider credentials or Numerai credentials.

## Destructive operations

The following tools change or remove state:

- `create_model`: creates one or more registry records.
- `update_model`: changes registry configuration or lifecycle metadata.
- `delete_model`: permanently deletes a registry item.
- `launch_model_training`: creates and launches a training attempt.
- `launch_training_run`: launches an existing attempt.
- `cancel_run`: requests terminal cancellation.

MCP annotations identify read-only, idempotent, and destructive operations to compatible clients. Clients should still show the user the exact model or run ID before deletion or cancellation.

## Logs and errors

Tool errors are returned to the MCP client as failed tool results. Server logs avoid returning secret values. Local worker reports are sanitized and log text is bounded before it is stored.
