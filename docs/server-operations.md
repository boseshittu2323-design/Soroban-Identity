# Server Operations

The `server/` package exposes operational endpoints for deployed Soroban Identity contracts.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP listen port. | `3001` |
| `ADMIN_API_KEY` | Required `x-api-key` or Bearer token for `/admin/*` routes. | unset |
| `ADMIN_ACTOR` | Default actor written to the issuer audit log. | `admin` |
| `DATA_DIR` | Base directory for local file storage. | `data` (in project folder) |
| `AUDIT_LOG_PATH` | Base file path prefix for daily rotated audit logs. | `data/audit` |
| `AUDIT_LOG_RETENTION_DAYS` | Number of days to retain daily audit log files. | `30` |
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

## Audit Logging

Issuer administration actions (such as adding or removing registered issuers) append entry logs to NDJSON (Newline Delimited JSON) files.

### Log File Naming Scheme
The active log file path is derived by appending the current UTC date to the configured `AUDIT_LOG_PATH` base path:
`audit-YYYY-MM-DD.ndjson`

* Entries written on **Day 1** are stored in `audit-YYYY-MM-Day1.ndjson`.
* Entries written on **Day 2** are stored in `audit-YYYY-MM-Day2.ndjson`.
* Rotation happens dynamically at midnight UTC on the write path.

### Retention Policy
On server startup, old audit files that exceed the `AUDIT_LOG_RETENTION_DAYS` retention limit (default: 30 days) are automatically deleted from disk.

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

## StorageAdapter (#389)

By default the server persists credentials to the local filesystem (`storage.js`). Set `STORAGE_ADAPTER` to the absolute path of a Node.js module that exports a default object implementing the following interface to swap the backend:

```ts
interface StorageAdapter {
  read(id: string): Promise<object | null>;
  write(id: string, data: object): Promise<void>;
  delete(id: string): Promise<boolean>;
  list(): Promise<object[]>;
}
```

### Environment variable

| Variable | Purpose | Default |
| --- | --- | --- |
| `STORAGE_ADAPTER` | Absolute path to a custom adapter module. | unset (filesystem) |

### Example custom adapter (S3)

```js
// s3-adapter.js
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
const s3 = new S3Client({});
const Bucket = process.env.S3_BUCKET;

export default {
  async read(id) { /* ... */ },
  async write(id, data) { /* ... */ },
  async delete(id) { /* ... */ },
  async list() { /* ... */ },
};
```

Set `STORAGE_ADAPTER=/path/to/s3-adapter.js` and the server will load it at startup via `loadStorageAdapter()`. If any of the four methods is missing the server will throw at startup.

### Adapter contract

A valid adapter must:

1. Return `null` from `read(id)` when the record does not exist.
2. Return `true` from `delete(id)` when the record existed and was removed, `false` otherwise.
3. Return an array (empty if no records) from `list()`.
4. Be idempotent: calling `write` twice with the same `id` replaces the existing record.