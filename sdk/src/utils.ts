import { StrKey, SorobanRpc, hash, Address } from "@stellar/stellar-sdk";
import type { CredentialType } from "./types";
import { SorobanIdentityError } from "./errors";

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
  options?: {
    maxAttempts?: number;
    intervalMs?: number;
    exponentialBackoff?: boolean;
  }
): Promise<void> {
  const maxAttempts = options?.maxAttempts ?? 10;
  const exponentialBackoff = options?.exponentialBackoff ?? true;
  let intervalMs = options?.intervalMs ?? 2000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await delay(intervalMs);
    const status = await server.getTransaction(hash);
    
    if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      return;
    }
    if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      throw new SorobanIdentityError(`Transaction failed on-chain: ${(status as any).resultXdr || 'unknown error'}`, "CONTRACT_ERROR");
    }

    if (exponentialBackoff) {
      intervalMs *= 2;
    }
  }
  throw new SorobanIdentityError("Transaction confirmation timeout", "NETWORK_ERROR");
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
 * Validates a Stellar address using `StrKey`.
 *
 * @param address The Stellar address (G…) to validate.
 * @throws {SorobanIdentityError} with code `VALIDATION_ERROR` when the address
 *   is not a valid ed25519 public key.
 */
export function validateStellarAddress(address: string): void {
  if (!StrKey.isValidEd25519PublicKey(address)) {
    throw new SorobanIdentityError(`InvalidAddress: "${address}" is not a valid Stellar address`, "VALIDATION_ERROR");
  }
}

/**
 * Checks if the RPC connection is healthy.
 *
 * Returns `false` on any network or server error without throwing — useful for
 * health probes that should never surface transport noise.
 *
 * @param server A {@link SorobanRpc.Server} instance to probe.
 * @returns `true` when `getLatestLedger()` succeeds, `false` on any error.
 */
export async function checkConnection(server: SorobanRpc.Server): Promise<boolean> {
  try {
    await server.getLatestLedger();
    return true;
  } catch {
    return false;
  }
}

/**
 * Deterministically computes a credential ID from issuer, subject, and type.
 *
 * Mirrors the derivation used by the credential-manager contract so a client
 * can predict the ID before submitting `issue_credential`.
 *
 * @param issuer         Registered issuer Stellar address.
 * @param subject        Subject Stellar address.
 * @param credentialType Credential category — see {@link CredentialType}.
 * @returns 64-character hex string (32-byte SHA-256 hash).
 *
 * @example
 * ```ts
 * const id = computeCredentialId(issuer, subject, 'Kyc');
 * ```
 */
export function computeCredentialId(
  issuer: string,
  subject: string,
  credentialType: CredentialType
): string {
  const typeTag = credentialType === "Kyc" ? 0 :
                  credentialType === "Reputation" ? 1 :
                  credentialType === "Achievement" ? 2 : 3;
  
  const issuerXdr = new Address(issuer).toScAddress().toXDR();
  const subjectXdr = new Address(subject).toScAddress().toXDR();
  
  const data = Buffer.concat([
    issuerXdr,
    subjectXdr,
    Buffer.from([typeTag])
  ]);
  
  return Buffer.from(hash(data)).toString("hex");
}
