import { SorobanRpc } from "@stellar/stellar-sdk";

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
