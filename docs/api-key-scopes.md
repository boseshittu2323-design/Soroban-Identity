# API Key Scopes

## Overview

API key scopes provide granular access control for the Soroban Identity server. Instead of granting full access to all operations, you can issue scoped keys that only allow specific operations.

## Scope Format

API keys can include scopes in the format:

```
<api-key>:<scope1>,<scope2>,<scope3>
```

For example:
- `my-secret-key:credentials:read` - Read-only access to credentials
- `my-secret-key:credentials:write` - Write access to credentials
- `my-secret-key:admin:read,admin:write` - Full admin access
- `my-secret-key:*` - Wildcard grants all permissions

## Available Scopes

### Credential Scopes

- **`credentials:read`** - Verify and read credentials
  - `POST /credentials/{id}/verify`

- **`credentials:write`** - Issue new credentials
  - `POST /credentials`

### Admin Scopes

- **`admin:read`** - Read administrative data
  - `GET /admin/issuers`
  - `GET /admin/expiry-report`

- **`admin:write`** - Modify administrative settings
  - `POST /admin/issuers`
  - `DELETE /admin/issuers`

### Wildcard Scope

- **`*`** - Grants access to all operations (equivalent to no scopes)

## Using Scoped Keys

### X-API-Key Header

```bash
curl -H "X-API-Key: my-key:credentials:read" \
  http://localhost:3001/credentials/cred-123/verify
```

### Authorization Bearer Token

```bash
curl -H "Authorization: Bearer my-key:credentials:write" \
  -X POST http://localhost:3001/credentials \
  -d '{"id": "cred-123", "subject": "alice"}'
```

## Backward Compatibility

Keys without scopes (legacy format) are treated as having wildcard (`*`) access, maintaining full backward compatibility with existing deployments.

```bash
# This still works and grants full access
curl -H "X-API-Key: my-legacy-key" \
  http://localhost:3001/admin/issuers
```

## Error Responses

### 401 Unauthorized

Returned when the API key is missing, malformed, or invalid:

```json
{
  "error": "unauthorized",
  "code": "UNAUTHORIZED",
  "message": "Invalid API key"
}
```

### 403 Forbidden

Returned when the API key is valid but lacks required scopes:

```json
{
  "error": "forbidden",
  "code": "INSUFFICIENT_SCOPE",
  "message": "API key does not have required permissions",
  "requiredScopes": ["credentials:write"],
  "missingScopes": ["credentials:write"]
}
```

### 503 Service Unavailable

Returned when API key authentication is not configured:

```json
{
  "error": "admin_api_key_not_configured",
  "code": "SERVICE_UNAVAILABLE",
  "message": "API key authentication is not configured"
}
```

## Use Cases

### Dashboard Consumer (Read-Only)

Issue a key with read-only access for monitoring dashboards:

```
DASHBOARD_KEY=my-key:credentials:read,admin:read
```

This key can:
- Verify credentials
- View issuers
- View expiry reports

But cannot:
- Issue credentials
- Add/remove issuers

### Issuer Integration (Write-Only)

Issue a key for credential issuance systems:

```
ISSUER_KEY=my-key:credentials:write
```

This key can:
- Issue new credentials

But cannot:
- Read or verify credentials
- Access admin endpoints

### Admin Operations

Issue a key for full administrative access:

```
ADMIN_KEY=my-key:admin:read,admin:write
```

This key can:
- View and modify issuers
- View expiry reports
- Perform all admin operations

But cannot:
- Issue or verify credentials

### Full Access

Issue a key with wildcard access for full server control:

```
FULL_ACCESS_KEY=my-key:*
```

Or use legacy format (no scopes):

```
FULL_ACCESS_KEY=my-key
```

## Implementation Notes

- Scopes are checked on every request before route handlers execute
- Multiple scopes can be specified in comma-separated format
- Scope checks are case-sensitive
- The wildcard `*` scope bypasses all scope checks
- Scopes are stored in the `req.apiKeyScopes` array for use in route handlers
