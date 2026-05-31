// API key authentication middleware for the SDK's server layer
// (#253).
//
// Keys are issued, hashed-at-rest, and attached to the request
// context for downstream rate limiting / audit logging. The store
// interface is pluggable — `InMemoryApiKeyStore` is the default for
// tests and single-process deployments; production swaps in a
// Postgres / Redis impl.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SorobanIdentityError } from "../errors";

export type ApiKeyScope = "read" | "write" | "admin";

export interface ApiKeyMetadata {
  id: string;
  owner: string;
  createdAt: number;
  lastUsedAt?: number;
  scopes: ApiKeyScope[];
}

export interface ApiKeyRecord extends ApiKeyMetadata {
  /** SHA-256 hex of the raw key. Raw key is only returned at issuance. */
  hashedKey: string;
}

export interface ApiKeyStore {
  insert(record: ApiKeyRecord): Promise<void>;
  findByHashedKey(hashedKey: string): Promise<ApiKeyRecord | undefined>;
  list(): Promise<ApiKeyMetadata[]>;
  remove(id: string): Promise<boolean>;
  touch(id: string, at: number): Promise<void>;
}

export class InMemoryApiKeyStore implements ApiKeyStore {
  private readonly byId = new Map<string, ApiKeyRecord>();
  private readonly byHash = new Map<string, string>();

  async insert(record: ApiKeyRecord): Promise<void> {
    if (this.byId.has(record.id)) {
      throw new SorobanIdentityError(`api key ${record.id} already exists`, {
        code: "ALREADY_EXISTS",
        details: { id: record.id },
      });
    }
    this.byId.set(record.id, record);
    this.byHash.set(record.hashedKey, record.id);
  }

  async findByHashedKey(hashedKey: string): Promise<ApiKeyRecord | undefined> {
    const id = this.byHash.get(hashedKey);
    return id ? this.byId.get(id) : undefined;
  }

  async list(): Promise<ApiKeyMetadata[]> {
    return Array.from(this.byId.values()).map(({ hashedKey: _h, ...rest }) => rest);
  }

  async remove(id: string): Promise<boolean> {
    const record = this.byId.get(id);
    if (!record) return false;
    this.byId.delete(id);
    this.byHash.delete(record.hashedKey);
    return true;
  }

  async touch(id: string, at: number): Promise<void> {
    const record = this.byId.get(id);
    if (record) record.lastUsedAt = at;
  }
}

export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}

export interface IssueApiKeyResult {
  /** Raw key returned ONCE at issuance. Never stored. */
  rawKey: string;
  metadata: ApiKeyMetadata;
}

export interface IssueApiKeyOptions {
  owner: string;
  scopes?: ApiKeyScope[];
  /** Override the random-bytes source (tests). */
  randomFn?: () => Buffer;
  /** Override clock. */
  now?: () => number;
  /** Override id generator. */
  idFn?: () => string;
}

export async function issueApiKey(
  store: ApiKeyStore,
  options: IssueApiKeyOptions,
): Promise<IssueApiKeyResult> {
  const random = (options.randomFn ?? (() => randomBytes(32)))();
  const rawKey = `sk_${random.toString("hex")}`;
  const hashedKey = hashApiKey(rawKey);
  const now = (options.now ?? Date.now)();
  const id = (options.idFn ?? (() => randomBytes(8).toString("hex")))();
  const record: ApiKeyRecord = {
    id,
    owner: options.owner,
    createdAt: now,
    scopes: options.scopes ?? ["read"],
    hashedKey,
  };
  await store.insert(record);
  return {
    rawKey,
    metadata: { id, owner: record.owner, createdAt: record.createdAt, scopes: record.scopes },
  };
}

export function parseAuthorizationHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return undefined;
  const token = trimmed.slice(7).trim();
  return token.length === 0 ? undefined : token;
}

export interface AuthContext {
  apiKey: ApiKeyMetadata;
}

/**
 * Express-compatible middleware that authenticates an incoming
 * request via `Authorization: Bearer <key>` against the store, then
 * attaches `req.auth = { apiKey }` for downstream handlers.
 *
 * No dependency on Express types — duck-typed against `req`/`res`/`next`
 * so the same middleware works with a thin wrapper around any host
 * framework.
 */
export interface ApiKeyMiddlewareOptions {
  store: ApiKeyStore;
  now?: () => number;
  /** Required scope for this route. Default: no scope check. */
  requireScope?: ApiKeyScope;
}

type ReqLike = { headers: Record<string, string | string[] | undefined>; auth?: AuthContext };
type ResLike = {
  status(code: number): ResLike;
  json(body: unknown): ResLike;
  setHeader?(name: string, value: string): void;
};
type NextLike = (err?: unknown) => void;

export function createApiKeyAuthMiddleware(options: ApiKeyMiddlewareOptions) {
  const now = options.now ?? Date.now;
  return async function apiKeyAuth(req: ReqLike, res: ResLike, next: NextLike): Promise<void> {
    const header = req.headers.authorization;
    const headerValue = Array.isArray(header) ? header[0] : header;
    const rawKey = parseAuthorizationHeader(headerValue);
    if (!rawKey) {
      sendError(res, 401, new SorobanIdentityError("missing or malformed Authorization header", "UNAUTHORIZED"));
      return;
    }
    const hashed = hashApiKey(rawKey);
    const record = await options.store.findByHashedKey(hashed);
    if (!record) {
      // Use timingSafeEqual on a fixed-size buffer comparison to keep
      // the failure path roughly constant-time vs the success path.
      timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
      sendError(res, 401, new SorobanIdentityError("invalid API key", "UNAUTHORIZED"));
      return;
    }
    if (options.requireScope && !record.scopes.includes(options.requireScope)) {
      sendError(res, 401, new SorobanIdentityError(`scope ${options.requireScope} required`, "UNAUTHORIZED"));
      return;
    }
    await options.store.touch(record.id, now());
    req.auth = {
      apiKey: {
        id: record.id,
        owner: record.owner,
        createdAt: record.createdAt,
        lastUsedAt: now(),
        scopes: record.scopes,
      },
    };
    next();
  };
}

function sendError(res: ResLike, status: number, err: SorobanIdentityError): void {
  res.status(status).json({ error: err.toEnvelope() });
}
