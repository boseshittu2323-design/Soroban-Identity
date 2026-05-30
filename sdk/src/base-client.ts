import { SorobanRpc, Contract } from "@stellar/stellar-sdk";
import type { SorobanIdentityConfig } from "./types";
import { RequestQueue } from "./request-queue";

const serverCache = new Map<string, SorobanRpc.Server>();

export function getOrCreateServer(rpcUrl: string): SorobanRpc.Server {
  if (!serverCache.has(rpcUrl)) {
    serverCache.set(rpcUrl, new SorobanRpc.Server(rpcUrl));
  }
  return serverCache.get(rpcUrl)!;
}

export function clearServerCache(): void {
  serverCache.clear();
}

export abstract class BaseClient {
  protected servers: SorobanRpc.Server[];
  protected currentServerIndex = 0;
  protected contract: Contract;
  protected config: SorobanIdentityConfig;
  protected requestQueue: RequestQueue;

  constructor(config: SorobanIdentityConfig, contractId: string) {
    this.config = config;
    
    // Support both single URL and array of URLs
    const rpcUrls = Array.isArray(config.rpcUrl) ? config.rpcUrl : [config.rpcUrl];
    this.servers = rpcUrls.map(url => getOrCreateServer(url));
    
    this.contract = new Contract(contractId);
    this.requestQueue = new RequestQueue(
      config.maxConcurrentRequests || 5,
      config.retryDelay || 1000
    );
  }

  protected get server(): SorobanRpc.Server {
    return this.servers[this.currentServerIndex];
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
          return result;
        } catch (error: any) {
          lastError = error;
          const errorStr = error?.toString() || '';
          
          // Don't failover on contract errors, only network/server errors
          if (!errorStr.includes('ECONNRESET') && 
              !errorStr.includes('ETIMEDOUT') && 
              !errorStr.includes('503') && 
              !errorStr.includes('502') &&
              !errorStr.includes('504')) {
            throw error;
          }
        }
      }
      
      throw lastError;
    });
  }
}