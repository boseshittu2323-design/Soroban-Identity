import { SorobanRpc, Contract } from "@stellar/stellar-sdk";
import type { SorobanIdentityConfig, SorobanIdentityLogger } from "./types";
import { ClientDisposedError, SorobanIdentityError } from "./errors";
import { retryWithBackoff } from "./utils";

/** Semantic version of this SDK build — must match package.json `version`. */
export const SDK_VERSION = "0.1.0";
import { RequestQueue } from "./request-queue";

const serverCache = new Map<string, SorobanRpc.Server>();

/**
 * Returns a process-wide singleton {@link SorobanRpc.Server} for a given RPC URL.
 *
 * Repeated clients pointing at the same RPC share the same underlying server
 * instance, avoiding redundant socket setup and ledger metadata fetches.
 *
 * @param rpcUrl Soroban RPC URL (e.g. `https://soroban-testnet.stellar.org`).
 * @returns Cached `SorobanRpc.Server`.
 */
export function getOrCreateServer(rpcUrl: string): SorobanRpc.Server {
  if (!serverCache.has(rpcUrl)) {
    serverCache.set(rpcUrl, new SorobanRpc.Server(rpcUrl));
  }
  return serverCache.get(rpcUrl)!;
}

/**
 * Drop all cached {@link SorobanRpc.Server} instances.
 *
 * Call between integration test runs to avoid leaking state across suites.
 */
export function clearServerCache(): void {
  serverCache.clear();
}

const noopLogger: SorobanIdentityLogger = {
  debug: () => undefined,
};

/**
 * Abstract base class shared by all SDK clients.
 *
 * Provides RPC endpoint failover across multiple `rpcUrl` entries, a
 * concurrency-controlled {@link RequestQueue}, and a pluggable
 * {@link SorobanIdentityLogger}. Concrete clients extend this class and add
 * contract-specific methods.
 */
export abstract class BaseClient {
  protected servers: SorobanRpc.Server[];
  protected currentServerIndex = 0;
  protected contract: Contract;
  protected config: SorobanIdentityConfig;
  protected requestQueue: RequestQueue;
  protected logger: SorobanIdentityLogger;
  private _disposed = false;

  /**
   * Resolves when the RPC node reports healthy status; rejects with a
   * `SorobanIdentityError` (code `CLIENT_NOT_READY`) if connectivity cannot
   * be established after the configured retry budget.
   *
   * The promise starts running immediately in the background — constructing
   * the client never blocks or throws.
   *
   * @example
   * ```ts
   * const client = new CredentialClient(config);
   * await client.ready; // verifies RPC connectivity before the first call
   * const cred = await client.getCredential(caller, id);
   * ```
   */
  readonly ready: Promise<void>;

  /**
   * @param config     SDK configuration including one or more RPC URLs.
   * @param contractId Deployed contract ID that this client wraps.
   */
  constructor(config: SorobanIdentityConfig, contractId: string) {
    this.config = config;

    // Support both single URL and array of URLs
    const rpcUrls = Array.isArray(config.rpcUrl) ? config.rpcUrl : [config.rpcUrl];
    this.servers = rpcUrls.map((url) => getOrCreateServer(url));

    this.contract = new Contract(contractId);
    this.requestQueue = new RequestQueue(
      config.maxConcurrentRequests || 5,
      config.retryDelay || 1000
    );
    this.logger = config.logger ?? noopLogger;

    if (config.version && config.version !== SDK_VERSION) {
      this.logger.warn?.(
        `sdk.version_mismatch: configured version "${config.version}" does not match SDK version "${SDK_VERSION}". ` +
          "Ensure the deployed contracts match this SDK release."
      );
    }

    this.ready = this._checkHealth().catch((err) => {
      throw new SorobanIdentityError(
        `Client not ready: ${err instanceof Error ? err.message : String(err)}`,
        "CLIENT_NOT_READY",
        err
      );
    });
  }

  protected async _checkHealth(): Promise<void> {
    await retryWithBackoff(() => this.server.getHealth());
  }

  protected get server(): SorobanRpc.Server {
    return this.servers[this.currentServerIndex];
  }

  protected debug(message: string, meta?: Record<string, unknown>): void {
    this.logger.debug(message, meta);
  }

  /**
   * Dispose this client, rejecting all queued requests with
   * {@link ClientDisposedError} and preventing new requests from being
   * submitted.
   *
   * Idempotent — calling `dispose()` more than once has no effect.
   *
   * @example
   * ```ts
   * // On wallet reconnect, dispose the stale client before creating a new one
   * oldClient.dispose();
   * const newClient = new CredentialClient(newConfig);
   * ```
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.requestQueue.dispose();
  }

  /** Returns `true` after {@link dispose} has been called. */
  get isDisposed(): boolean {
    return this._disposed;
  }

  /**
   * Execute `fn` against the current RPC server, failing over to the next URL
   * in the pool on 5xx / connection errors. Updates `currentServerIndex` on
   * a successful attempt so future calls prefer the healthy endpoint.
   *
   * Contract-level errors (non-network) are NOT retried — only transport
   * failures trigger failover.
   *
   * @param fn Async function that receives the active {@link SorobanRpc.Server}.
   * @returns The value returned by `fn` on the first successful attempt.
   * @throws The last error encountered if all servers fail.
   */
  protected async executeWithFailover<T>(fn: (server: SorobanRpc.Server) => Promise<T>): Promise<T> {
    if (this._disposed) {
      return Promise.reject(new ClientDisposedError());
    }
    return this.requestQueue.enqueue(async () => {
      let lastError: any;

      for (let attempt = 0; attempt < this.servers.length; attempt++) {
        const serverIndex = (this.currentServerIndex + attempt) % this.servers.length;
        const server = this.servers[serverIndex];

        try {
          const result = await fn(server);
          // Update current server on success
          this.currentServerIndex = serverIndex;
          this.debug("rpc.failover_success", { serverIndex, attempt });
          return result;
        } catch (error: any) {
          lastError = error;
          const errorStr = error?.toString() || "";
          this.debug("rpc.failover_attempt_failed", {
            serverIndex,
            attempt,
            error: errorStr,
          });

          // Don't failover on contract errors, only network/server errors
          if (
            !errorStr.includes("ECONNRESET") &&
            !errorStr.includes("ETIMEDOUT") &&
            !errorStr.includes("503") &&
            !errorStr.includes("502") &&
            !errorStr.includes("504")
          ) {
            throw error;
          }
        }
      }

      throw lastError;
    });
  }
}
