# SDK + Server layer

Helpers exposed alongside the SDK for any host application that wants
to expose Soroban-Identity over HTTP. Four issues land in this folder:

| Issue | File | Surface |
|-------|------|---------|
| [#249](https://github.com/El-Chapo-Npm/Soroban-Identity/issues/249) | `sdk/src/errors.ts` | `SorobanIdentityError` envelope + `SorobanErrorCode` union + `classifyError` / `wrapError` helpers |
| [#252](https://github.com/El-Chapo-Npm/Soroban-Identity/issues/252) | `sdk/src/server/webhooks.ts` | `WebhookStore` + `registerWebhook` + `WebhookDispatcher` |
| [#253](https://github.com/El-Chapo-Npm/Soroban-Identity/issues/253) | `sdk/src/server/api-keys.ts` | `ApiKeyStore` + `issueApiKey` + `createApiKeyAuthMiddleware` |
| [#254](https://github.com/El-Chapo-Npm/Soroban-Identity/issues/254) | `sdk/src/server/rate-limit.ts` | `TokenBucketRateLimiter` + `createRateLimitMiddleware` |

## Error envelope (#249)

```ts
import { SorobanIdentityError } from "@soroban-identity/sdk";

throw new SorobanIdentityError("DID already registered", {
  code: "ALREADY_EXISTS",
  details: { address: "GABC..." },
});

// In the HTTP layer:
res.status(409).json({ error: err.toEnvelope() });
// → { code: "ALREADY_EXISTS", message: "DID already registered", details: { address: "GABC..." } }
```

Codes: `NOT_FOUND | UNAUTHORIZED | ALREADY_EXISTS | INVALID_INPUT | NETWORK_ERROR | CONTRACT_ERROR | RATE_LIMITED | VALIDATION_ERROR | UNKNOWN`.

Helpers:
- `classifyError(msg)` — regex-based code derivation (used internally when wrapping unknown throws).
- `wrapError(err)` — idempotent; passes through existing `SorobanIdentityError`, classifies + wraps everything else.

## Webhook delivery (#252)

```ts
import { InMemoryWebhookStore, registerWebhook, WebhookDispatcher } from "@soroban-identity/sdk";

const store = new InMemoryWebhookStore();
const reg = await registerWebhook(store, {
  url: "https://customer.example/hook",
  secret: "at-least-16-chars-please",
  events: ["credential.issued", "credential.revoked"],
});

const dispatcher = new WebhookDispatcher({ maxAttempts: 5, baseDelayMs: 250 });
const result = await dispatcher.deliver(reg, "credential.issued", { credentialId: "abc" });
// result: { ok, attempts: [...] }
```

- HMAC-SHA256 signed via `X-SorobanIdentity-Signature` header.
- Event type in `X-SorobanIdentity-Event`.
- Delivery id in `X-SorobanIdentity-Delivery-Id` (for idempotent receiver-side dedupe).
- Retry policy: 5xx + 429 + transport errors retried with exponential backoff. Other 4xx fast-fail (caller misconfig).
- Receiver-side verification: `verifySignature(secret, body, signature)` does constant-time comparison.

## API key authentication (#253)

```ts
import { InMemoryApiKeyStore, issueApiKey, createApiKeyAuthMiddleware } from "@soroban-identity/sdk";

const store = new InMemoryApiKeyStore();
const { rawKey, metadata } = await issueApiKey(store, { owner: "alice", scopes: ["read", "write"] });
// Return rawKey to alice ONCE; only the hash is persisted.

app.use(createApiKeyAuthMiddleware({ store, requireScope: "write" }));
```

- `Authorization: Bearer sk_<hex>` parsed via `parseAuthorizationHeader`.
- Keys stored as `sha256(rawKey)` only.
- 401 + envelope on missing / invalid / scope-mismatched keys.
- `req.auth = { apiKey: ApiKeyMetadata }` attached for downstream middleware (e.g. rate limiter keys by `apiKey.id`).

Admin endpoints (recommended host wiring):
- `POST /admin/api-keys` → `issueApiKey`
- `GET /admin/api-keys` → `store.list`
- `DELETE /admin/api-keys/:id` → `store.remove`

## Rate limiting (#254)

```ts
import { createRateLimitMiddleware } from "@soroban-identity/sdk";

app.use(createApiKeyAuthMiddleware({ store }));
app.use(createRateLimitMiddleware({
  read: { limit: 60, windowMs: 60_000 },
  write: { limit: 20, windowMs: 60_000 },
}));
```

Token-bucket. Default classifier treats GET/HEAD/OPTIONS as reads. The
bucket key is `req.auth?.apiKey.id` (when authenticated) or
`ip:<address>` (when not). Per-key overrides supported via the
`overrides` map.

Every response carries:
- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset` (unix seconds)

When exhausted: `429 Too Many Requests` + `Retry-After` (seconds) +
envelope body `{ error: { code: "RATE_LIMITED", ... } }`.

Limits are configurable via environment variables when host
applications read them at startup; defaults match the issue's spec.
