# Request Body Size Limit

## Summary

Added configurable request body size enforcement to prevent denial-of-service attacks that exploit unbounded memory consumption through large POST/PUT/PATCH payloads.

## Changes

### 1. **server/src/config.js**

- Added `maxBodyBytes` config (default: 64 KB)
- Parsed from `MAX_BODY_BYTES` env var
- Uses `parseInteger()` helper with fallback

### 2. **server/src/http-utils.js**

- Enhanced `readJson(req, config)` to enforce size limits
- **Content-Length check**: Rejects before reading any body bytes
- **Streaming check**: Aborts if running total exceeds limit
- Logs warning with remote IP when limit triggered
- Returns `{ __payloadTooLarge: true }` marker on oversize

### 3. **server/src/app.js**

- Passes `config` to all `readJson()` calls
- Checks for `__payloadTooLarge` marker
- Returns 413 Payload Too Large with `{ error: 'payload_too_large' }`

### 4. **server/src/body-size-limit.test.js**

- Integration tests for Content-Length header check
- Tests for streaming check (no Content-Length)
- Tests for bodies at exactly the limit
- Tests for valid small payloads
- Warning logging verification
- Configuration testing

## Behavior

### Request Processing

1. **Content-Length present**: Check immediately, reject before reading body
2. **Content-Length absent**: Track bytes as chunks arrive, abort if exceeded
3. **Under limit**: Process request normally
4. **Over limit**: Log warning with remote IP, respond 413

### Default Behavior

```bash
MAX_BODY_BYTES=65536  # 64 KB default
```

### Custom Limit Example

```bash
MAX_BODY_BYTES=1048576 npm start  # 1 MB limit
```

## Response Format

**Oversized payload:**

```json
{
  "statusCode": 413,
  "body": { "error": "payload_too_large" }
}
```

**Warning log:**

```
[readJson] Payload too large from 192.168.1.100: 5242880 bytes (limit: 65536)
```

## Acceptance Criteria ✅

- ✅ 1 MB POST body to /admin/issuers returns 413 with payload_too_large
- ✅ Body exactly at limit succeeds
- ✅ Config accepts MAX_BODY_BYTES=1024 and applies it
- ✅ Integration tests cover under-limit and over-limit cases

## Security Impact

| Attack Vector            | Before           | After                |
| ------------------------ | ---------------- | -------------------- |
| Multi-GB POST body       | Process crashed  | 413 rejected, logged |
| Streaming upload attack  | Memory exhausted | Aborted at limit     |
| No Content-Length header | Unbounded read   | Tracked and limited  |

## Testing

```bash
npm test -- body-size-limit.test.js
```

Tests cover:

- Large Content-Length rejection
- Streaming size tracking
- Boundary conditions (at limit, just under, just over)
- Valid requests pass through
- Warning logging
