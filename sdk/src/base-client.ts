import { SorobanRpc, Contract } from "@stellar/stellar-sdk";
import type { SorobanIdentityConfig, SorobanIdentityLogger } from "./types";
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

export abstract class BaseClient {
  protected servers: SorobanRpc.Server[];
  protected currentServerIndex = 0;
  protected contract: Contract;
  protected config: SorobanIdentityConfig;
  protected requestQueue: RequestQueue;
  protected logger: SorobanIdentityLogger;

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
  }

  protected get server(): SorobanRpc.Server {
    return this.servers[this.currentServerIndex];
  }

  protected debug(message: string, meta?: Record<string, unknown>): void {
    this.logger.debug(message, meta);
  }

  protected async executeWithFailover<T>(fn: (server: SorobanRpc.Server) => Promise<T>): Promise<T> {
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
