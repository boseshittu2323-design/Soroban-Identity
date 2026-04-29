import { StrKey, SorobanRpc } from "@stellar/stellar-sdk";

/**
 * Retries an async function with exponential backoff on transient network errors.
 * Contract-level errors (non-network) are NOT retried.
 *
 * @param fn          - Async function to execute.
 * @param maxRetries  - Maximum number of retry attempts (default: 3).
 * @param baseDelayMs - Initial delay in ms, doubles each retry (default: 500).
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 500
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (!isTransientError(err) || attempt === maxRetries) throw err;
      lastError = err;
      await delay(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

/**
 * Polls for the final transaction status (SUCCESS or FAILED).
 * Throws an error if the transaction fails or times out.
 *
 * @param server      - SorobanRpc.Server instance
 * @param hash        - Transaction hash
 * @param maxAttempts - Maximum polling attempts (default: 10)
 * @param intervalMs  - Polling interval in ms (default: 2000)
 */
export async function pollTransactionStatus(
  server: SorobanRpc.Server,
  hash: string,
  maxAttempts = 10,
  intervalMs = 2000
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await delay(intervalMs);
    const status = await server.getTransaction(hash);
    
    if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      return;
    }
    if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Transaction failed on-chain: ${(status as any).resultXdr || 'unknown error'}`);
    }
  }
  throw new Error("Transaction confirmation timeout");
}

function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("503") ||
    msg.includes("timeout") ||
    msg.includes("network") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("fetch failed")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => void }).setTimeout(resolve, ms));
}

/**
 * Validates a Stellar address using StrKey.
 * Throws an InvalidAddress error with a descriptive message if the address is invalid.
 */
export function validateStellarAddress(address: string): void {
  if (!StrKey.isValidEd25519PublicKey(address)) {
    throw new Error(`InvalidAddress: "${address}" is not a valid Stellar address`);
  }
}

/**
 * Checks if the RPC connection is healthy.
 * Returns false on any network or server error without throwing.
 *
 * @param server - SorobanRpc.Server instance
 * @returns Promise<boolean> - true if connection is healthy, false otherwise
 */
export async function checkConnection(server: SorobanRpc.Server): Promise<boolean> {
  try {
    await server.getLatestLedger();
    return true;
  } catch {
    return false;
  }
}
