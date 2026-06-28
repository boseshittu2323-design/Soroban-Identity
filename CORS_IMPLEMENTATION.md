# CORS Implementation

## Summary

Added configurable CORS support to the server so browser-based SDK clients can connect without proxying through Vite's dev server.

## Changes

### 1. **server/src/config.js**

- Added `parseCorsOrigins()` helper to parse `CORS_ALLOWED_ORIGINS` env var
- Defaults: `*` in development, empty list in production
- Supports comma-separated list: `https://app.example.com,http://localhost:5173`

### 2. **server/src/http-utils.js**

- Added `getAllowedOrigin()` - matches request origin against allowed list
- Added `setCorsHeaders()` - sets CORS headers and handles OPTIONS preflight:
  - Sets `Access-Control-Allow-Origin` if origin is allowed
  - Sets `Access-Control-Expose-Headers` to expose `X-Request-ID`
  - Handles OPTIONS requests with 204 response
  - Caches preflight for 86400 seconds

### 3. **server/src/app.js**

- Integrated `setCorsHeaders()` at the top of request handler
- Responds to OPTIONS preflight before routing

### 4. **server/src/cors.test.js**

- Integration tests covering:
  - Preflight OPTIONS responses (204 with headers)
  - Allowed/blocked origins
  - X-Request-ID exposure
  - Wildcard support
  - All route types (GET, POST, etc.)
  - Disabled CORS behavior

## Environment Variables

| Variable               | Default          | Description                                    |
| ---------------------- | ---------------- | ---------------------------------------------- |
| `NODE_ENV`             | `development`    | If `development`, allows `*` unless overridden |
| `CORS_ALLOWED_ORIGINS` | Auto (see above) | Comma-separated origins or `*`                 |

## Examples

### Development (allow all)

```bash
npm start
# NODE_ENV defaults to development, CORS allows *
```

### Production (specific origins)

```bash
NODE_ENV=production CORS_ALLOWED_ORIGINS=https://app.example.com npm start
```

### Multiple origins

```bash
CORS_ALLOWED_ORIGINS=https://app.example.com,https://app2.example.com npm start
```

## Acceptance Criteria ✅

- ✅ Browser SDK on port 5173 can call all endpoints without CORS errors
- ✅ Preflight OPTIONS requests return 204 with correct headers
- ✅ `CORS_ALLOWED_ORIGINS=https://app.example.com` blocks other origins
- ✅ Integration tests verify CORS headers on all route types
