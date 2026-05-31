/**
 * Discriminator for {@link SorobanIdentityError}. Callers can branch on
 * `err.code` to handle each class without parsing the message.
 *
 * - `NOT_FOUND` — record (DID, credential, reporter) does not exist
 * - `UNAUTHORIZED` — caller is not authorised for the requested operation
 * - `NETWORK_ERROR` — transport failure, RPC timeout, etc.
 * - `VALIDATION_ERROR` — bad input shape (malformed hex, missing config, …)
 * - `CONTRACT_ERROR` — contract returned a non-zero error code or simulation failed
 * - `UNKNOWN` — fallback when no other code fits
 */
export type SorobanErrorCode = 'NOT_FOUND' | 'UNAUTHORIZED' | 'NETWORK_ERROR' | 'VALIDATION_ERROR' | 'CONTRACT_ERROR' | 'UNKNOWN';

/**
 * SDK-level error wrapping all client-side failure paths.
 *
 * @example
 * ```ts
 * try {
 *   await identity.createDid(keypair);
 * } catch (err) {
 *   if (err instanceof SorobanIdentityError && err.code === 'VALIDATION_ERROR') {
 *     // a DID already exists for this address
 *   }
 *   throw err;
 * }
 * ```
 */
export class SorobanIdentityError extends Error {
  /** Discriminator code — see {@link SorobanErrorCode}. */
  readonly code: SorobanErrorCode;
  /** The underlying error, if this wraps one. */
  readonly originalError?: unknown;

  /**
   * @param message       Human-readable error message.
   * @param code          {@link SorobanErrorCode}. Defaults to `'UNKNOWN'`.
   * @param originalError Optional wrapped error for diagnostic purposes.
   */
  constructor(message: string, code: SorobanErrorCode = 'UNKNOWN', originalError?: unknown) {
    super(message);
    this.name = 'SorobanIdentityError';
    this.code = code;
    this.originalError = originalError;
  }
}

/**
 * A typed contract-level error parsed from an RPC simulation failure.
 *
 * Use {@link ContractError.extract} to decode a `#N` marker out of an error
 * string and look up its human-readable description from a contract-specific
 * error map (e.g. `CREDENTIAL_MANAGER_ERRORS`).
 */
export class ContractError extends Error {
  /** The numeric error code returned by the contract. */
  readonly code: number;

  /**
   * @param code     Numeric contract error code.
   * @param errorMap Map of code → human-readable description.
   */
  constructor(code: number, errorMap: Record<number, string>) {
    super(errorMap[code] ?? `Contract error code ${code}`);
    this.name = 'ContractError';
    this.code = code;
  }

  /**
   * Parse the first `#N` marker out of an error string and return a typed
   * `ContractError`. Returns `null` when no marker is present (e.g. the error
   * is a transport failure, not a contract-level abort).
   *
   * @param errMsg   The raw error string from a simulation failure.
   * @param errorMap Contract-specific code → description map.
   * @returns The decoded {@link ContractError}, or `null` if no marker found.
   */
  static extract(errMsg: string, errorMap: Record<number, string>): ContractError | null {
    const match = errMsg.match(/#(\d+)/);
    if (!match) return null;
    return new ContractError(parseInt(match[1], 10), errorMap);
  }
}
