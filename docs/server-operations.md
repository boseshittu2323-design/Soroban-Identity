# Server Operations

The `server/` package exposes operational endpoints for deployed Soroban Identity contracts.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP listen port. | `3001` |
| `ADMIN_API_KEY` | Required `x-api-key` or Bearer token for `/admin/*` routes. | unset |
| `ADMIN_ACTOR` | Default actor written to the issuer audit log. | `admin` |
| `STELLAR_SOURCE_ACCOUNT` / `STELLAR_SECRET_KEY` | Source account used by Stellar CLI contract invocations. | unset |
| `STELLAR_NETWORK` | Stellar network passphrase alias used by the CLI. | `testnet` |
| `STELLAR_RPC_URL` | Soroban RPC URL. | testnet RPC |
| `IDENTITY_REGISTRY_ID` | Identity registry contract ID. | unset |
| `CREDENTIAL_MANAGER_ID` | Credential manager contract ID. | unset |
| `REPUTATION_ID` | Reputation contract ID. | unset |
| `EXPIRY_WARNING_DAYS` | Credential expiry warning window. | `7` |
| `EXPIRY_JOB_INTERVAL_MS` | Background expiry job interval. | `3600000` |
| `NOTIFICATION_WEBHOOK_URL` | Default webhook receiving credential expiry warnings. | unset |
| `SUBJECT_NOTIFICATION_WEBHOOKS` | JSON map of subject address to webhook URL. | `{}` |

## Endpoints

- `GET /health` calls `ping()` on the identity, credential, and reputation contracts in parallel and returns HTTP `503` if any contract cannot respond.
- `GET /metrics` returns Prometheus-compatible counters for DID, credential, and reputation activity plus an RPC latency histogram.
- `GET /admin/issuers` returns the registered issuer list from the credential contract.
- `POST /admin/issuers` with `{ "issuer": "G..." }` calls `add_issuer` and appends an audit log entry.
- `DELETE /admin/issuers?issuer=G...` or `DELETE /admin/issuers` with `{ "issuer": "G..." }` calls `remove_issuer` and appends an audit log entry.
- `GET /admin/expiry-report?windowDays=7&page=1&pageSize=50` returns a paginated list of credentials expiring inside the requested window.

All `/admin/*` routes require `x-api-key: $ADMIN_API_KEY` or `Authorization: Bearer $ADMIN_API_KEY`.

## Expiry notifications

The server starts a background job every hour by default. It indexes credential issue events when available, reads the local credential store, finds credentials with `expires_at` inside the configured warning window, and dispatches a webhook POST to the configured subject-specific or default notification URL.

## Prometheus scrape config

```yaml
scrape_configs:
  - job_name: soroban_identity_server
    metrics_path: /metrics
    static_configs:
      - targets:
          - soroban-identity.example.com:3001
```
