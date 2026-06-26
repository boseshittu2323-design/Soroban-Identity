/**
 * Machine-readable SDK error codes exposed as a const object so callers can
 * reference codes without hard-coding strings.
 *
 * - `NOT_FOUND` — DID, credential, or reporter record does not exist
 * - `UNAUTHORIZED` — caller is not authorised for the requested operation
 * - `ALREADY_EXISTS` — creation conflicts with an existing record
 * - `INVALID_INPUT` — caller-provided data failed schema/shape validation
 * - `INVALID_ADDRESS` — address fails Stellar ed25519 format validation
 * - `INVALID_PROOF` — presentation proof.jws signature is invalid
 * - `INVALID_ARGUMENT` — a required argument is missing or malformed
 * - `NETWORK_ERROR` — generic transport or connection failure
 * - `NETWORK_TIMEOUT` — network call timed out before a response arrived
 * - `RPC_ERROR` — the RPC node returned an unexpected non-contract error
 * - `CONTRACT_ERROR` — contract returned a non-zero error code or simulation failed
 * - `CONTRACT_PANIC` — contract execution panicked (host environment error)
 * - `INSUFFICIENT_FEE` — transaction fee below network minimum
 * - `LEDGER_CLOSED` — ledger closed before the transaction was included
 * - `RATE_LIMITED` — request rate limit exhausted
 * - `TIMEOUT` — polling or overall operation timed out
 * - `VALIDATION_ERROR` — retained for backwards-compatibility
 * - `UNKNOWN` — fallback when no other code fits
 */
export const SorobanErrorCodes = {
  NOT_FOUND: "NOT_FOUND",
  UNAUTHORIZED: "UNAUTHORIZED",
  ALREADY_EXISTS: "ALREADY_EXISTS",
  INVALID_INPUT: "INVALID_INPUT",
  INVALID_ADDRESS: "INVALID_ADDRESS",
  INVALID_PROOF: "INVALID_PROOF",
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  NETWORK_ERROR: "NETWORK_ERROR",
  NETWORK_TIMEOUT: "NETWORK_TIMEOUT",
  RPC_ERROR: "RPC_ERROR",
  CONTRACT_ERROR: "CONTRACT_ERROR",
  CONTRACT_PANIC: "CONTRACT_PANIC",
  INSUFFICIENT_FEE: "INSUFFICIENT_FEE",
  LEDGER_CLOSED: "LEDGER_CLOSED",
  RATE_LIMITED: "RATE_LIMITED",
  TIMEOUT: "TIMEOUT",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  UNKNOWN: "UNKNOWN",
} as const;

export const IDENTITY_REGISTRY_ERRORS: Record<number, string> = {
  1: 'DID not found',
  2: 'DID is deactivated',
  3: 'Metadata key or value exceeds maximum length',
  4: 'Contract already initialized',
  5: 'Empty metadata not allowed',
  6: 'Unauthorized: caller is not the admin/controller',
  7: 'DID already exists for this address',
};

export const CREDENTIAL_MANAGER_ERRORS: Record<number, string> = {
  1: 'Contract already initialized',
  2: 'Unauthorized issuer',
  3: 'Credential not found',
  4: 'Credential already revoked',
  5: 'Credential already exists',
  6: 'Contract not initialized',
  7: 'Unauthorized: caller is not the admin',
  8: 'Maximum number of issuers reached',
  9: 'Credential is expired',
};

export const REPUTATION_ERRORS: Record<number, string> = {
  1: 'Contract already initialized',
  2: 'Reporter not registered',
  3: 'Rate limit exceeded for this reporter',
  4: 'Reason text exceeds maximum length',
  5: 'Contract not initialized',
  6: 'Unauthorized: caller is not the admin',
};
