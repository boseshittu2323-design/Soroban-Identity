export type SorobanErrorCode =
  | "ALREADY_INITIALIZED"
  | "ALREADY_EXISTS"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "NOT_AN_ISSUER"
  | "NOT_A_REPORTER"
  | "CONTRACT_ERROR"
  | "UNKNOWN";

export class SorobanIdentityError extends Error {
  code: SorobanErrorCode;
  contractCode?: number;

  constructor(message: string, code: SorobanErrorCode, contractCode?: number) {
    super(message);
    this.name = "SorobanIdentityError";
    this.code = code;
    this.contractCode = contractCode;
  }
}

const IDENTITY_ERRORS: Record<number, { code: SorobanErrorCode; message: string }> = {
  1: { code: "ALREADY_INITIALIZED", message: "Registry is already initialized" },
  2: { code: "ALREADY_EXISTS", message: "DID already exists for this address" },
  3: { code: "NOT_FOUND", message: "DID not found" },
  4: { code: "UNAUTHORIZED", message: "Unauthorized operation" },
};

const CREDENTIAL_ERRORS: Record<number, { code: SorobanErrorCode; message: string }> = {
  1: { code: "ALREADY_INITIALIZED", message: "Credential manager is already initialized" },
  2: { code: "ALREADY_INITIALIZED", message: "Not initialized" },
  3: { code: "NOT_FOUND", message: "Credential not found" },
  4: { code: "UNAUTHORIZED", message: "Only the issuer can perform this action" },
  5: { code: "NOT_AN_ISSUER", message: "Not a registered issuer" },
};

const REPUTATION_ERRORS: Record<number, { code: SorobanErrorCode; message: string }> = {
  1: { code: "ALREADY_INITIALIZED", message: "Reputation contract is already initialized" },
  2: { code: "ALREADY_INITIALIZED", message: "Not initialized" },
  3: { code: "NOT_A_REPORTER", message: "Not a registered reporter" },
};

/**
 * Helper to parse raw Soroban simulation / tx errors into typed SorobanIdentityError.
 */
export function parseContractError(
  error: unknown,
  contractType: "identity" | "credential" | "reputation"
): SorobanIdentityError {
  if (error instanceof SorobanIdentityError) {
    return error;
  }
  const errStr = error instanceof Error ? error.message : String(error);

  // Match pattern like Error(Contract, 3) or Error(Contract, #3)
  const match =
    errStr.match(/Error\(Contract,\s*#?(\d+)\)/i) ||
    errStr.match(/contract error #?(\d+)/i);
  if (match) {
    const codeNum = parseInt(match[1], 10);
    const map =
      contractType === "identity"
        ? IDENTITY_ERRORS
        : contractType === "credential"
        ? CREDENTIAL_ERRORS
        : REPUTATION_ERRORS;

    const mapped = map[codeNum];
    if (mapped) {
      return new SorobanIdentityError(mapped.message, mapped.code, codeNum);
    }
    return new SorobanIdentityError(
      `Contract error #${codeNum}`,
      "CONTRACT_ERROR",
      codeNum
    );
  }

  return new SorobanIdentityError(errStr, "UNKNOWN");
/**
 * Discriminator for {@link SorobanIdentityError}. Callers can branch on
 * `err.code` to handle each class without parsing the message.
 *
 * - `NOT_FOUND` — record (DID, credential, reporter) does not exist
 * - `UNAUTHORIZED` — caller is not authorised for the requested operation
 * - `ALREADY_EXISTS` — creation conflicts; record already registered
 * - `INVALID_INPUT` — caller-provided data failed schema/shape validation
 * - `INVALID_ADDRESS` — address fails Stellar ed25519 format validation
 * - `INVALID_PROOF` — presentation proof.jws signature is invalid or missing
 * - `INVALID_ARGUMENT` — a required argument is missing or malformed
 * - `NETWORK_ERROR` — generic transport failure
 * - `NETWORK_TIMEOUT` — network call timed out before a response arrived
 * - `RPC_ERROR` — the RPC node returned an unexpected non-contract error
 * - `CONTRACT_ERROR` — contract returned a non-zero error code or simulation failed
 * - `CONTRACT_PANIC` — contract execution panicked (host environment error)
 * - `INSUFFICIENT_FEE` — transaction fee was below what the network requires
 * - `LEDGER_CLOSED` — the ledger closed before the transaction was included
 * - `RATE_LIMITED` — rate limit exhaustion
 * - `TIMEOUT` — polling or overall operation timed out
 * - `VALIDATION_ERROR` — retained for backwards-compatibility
 * - `UNKNOWN` — fallback when no other code fits
 */
export type SorobanErrorCode =
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "ALREADY_EXISTS"
  | "INVALID_INPUT"
  | "INVALID_ADDRESS"
  | "INVALID_PROOF"
  | "INVALID_ARGUMENT"
  | "NETWORK_ERROR"
  | "NETWORK_TIMEOUT"
  | "RPC_ERROR"
  | "CONTRACT_ERROR"
  | "CONTRACT_PANIC"
  | "INSUFFICIENT_FEE"
  | "LEDGER_CLOSED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "VALIDATION_ERROR"
  | "UNKNOWN";

export interface SorobanIdentityErrorInit {
  code?: SorobanErrorCode;
  details?: Record<string, unknown>;
  originalError?: unknown;
  /** Transaction hash when the failure is tied to an on-chain submission. */
  txHash?: string;
}

function isInitObject(v: unknown): v is SorobanIdentityErrorInit {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

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
  readonly details?: Record<string, unknown>;
  /** The underlying error, if this wraps one. */
  readonly originalError?: unknown;
  /** Transaction hash when the failure is tied to an on-chain submission. */
  readonly txHash?: string;

  /**
   * Backwards-compatible positional signature:
   *   `new SorobanIdentityError(msg, codeString, originalError)`.
   * Init-object signature:
   *   `new SorobanIdentityError(msg, { code, details, originalError, txHash })`.
   *
   * @param message       Human-readable error message.
   * @param codeOrInit    {@link SorobanErrorCode} or init object. Defaults to `'UNKNOWN'`.
   * @param originalError Optional wrapped error (positional form only).
   */
  constructor(
    message: string,
    codeOrInit: SorobanErrorCode | SorobanIdentityErrorInit = "UNKNOWN",
    originalError?: unknown,
  ) {
    super(message);
    this.name = "SorobanIdentityError";
    if (isInitObject(codeOrInit)) {
      this.code = codeOrInit.code ?? "UNKNOWN";
      this.details = codeOrInit.details;
      this.originalError = codeOrInit.originalError ?? originalError;
      this.txHash = codeOrInit.txHash;
    } else {
      this.code = codeOrInit;
      this.originalError = originalError;
    }
  }

  toEnvelope(): { code: SorobanErrorCode; message: string; details?: Record<string, unknown>; txHash?: string } {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
      ...(this.txHash ? { txHash: this.txHash } : {}),
    };
  }
}

/**
 * Thrown when the RPC provider responds with HTTP 429 and the SDK has
 * exhausted its retry budget. Consumers should honour `retryAfterMs`
 * before re-submitting the request.
 *
 * @example
 * ```ts
 * import { RateLimitError } from '@soroban-identity/sdk';
 * try {
 *   await identity.resolveDid(address);
 * } catch (err) {
 *   if (err instanceof RateLimitError) {
 *     await sleep(err.retryAfterMs);
 *     // retry…
 *   }
 * }
 * ```
 */
export class RateLimitError extends Error {
  /** Milliseconds to wait before the next request attempt. */
  readonly retryAfterMs: number;
  readonly code: SorobanErrorCode = "RATE_LIMITED";

  constructor(retryAfterMs: number) {
    super(`Rate limited — retry after ${retryAfterMs}ms`);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
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
    this.name = "ContractError";
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
    const code = parseInt(match[1] as string, 10);
    if (Number.isNaN(code)) return null;
    return new ContractError(code, errorMap);
  }

  toEnvelope(): { code: SorobanErrorCode; message: string; details: Record<string, unknown> } {
    return {
      code: "CONTRACT_ERROR",
      message: this.message,
      details: { contractCode: this.code },
    };
  }
}

/**
 * Thrown by {@link CredentialClient.issueCredential} when a `schemaId` is
 * supplied and the provided `claims` fail validation against the on-chain
 * schema.
 *
 * `fieldErrors` maps each failing claim key to a human-readable message so
 * callers can surface actionable feedback.
 */
export class ClaimsValidationError extends Error {
  readonly code = "INVALID_INPUT" as const;
  /** Per-field validation messages — key is the claim field path. */
  readonly fieldErrors: Record<string, string>;

  constructor(message: string, fieldErrors: Record<string, string>) {
    super(message);
    this.name = "ClaimsValidationError";
    this.fieldErrors = fieldErrors;
  }
}

/**
 * Map a free-form error message (panic string, RPC error message,
 * etc.) to the envelope code. Falls back to `UNKNOWN` so call sites
 * can wrap-and-rethrow without case explosion.
 */
export function classifyError(message: string): SorobanErrorCode {
  const m = message.toLowerCase();
  if (/already\s+(registered|exists|active|issued)/u.test(m)) return "ALREADY_EXISTS";
  if (/not\s+(found|registered|active)|no such/u.test(m)) return "NOT_FOUND";
  if (/unauthori[sz]ed|forbidden|permission denied/u.test(m)) return "UNAUTHORIZED";
  if (/rate limit|too many requests/u.test(m)) return "RATE_LIMITED";
  if (/insufficient.*(fee|balance)|fee.*too.*low/u.test(m)) return "INSUFFICIENT_FEE";
  if (/ledger.*closed|seq.*too.*old/u.test(m)) return "LEDGER_CLOSED";
  if (/panic|host environment/u.test(m)) return "CONTRACT_PANIC";
  if (/invalid.*address|not.*valid.*stellar/u.test(m)) return "INVALID_ADDRESS";
  if (/invalid.*argument|required.*argument/u.test(m)) return "INVALID_ARGUMENT";
  if (/invalid|malformed|bad request|missing/u.test(m)) return "INVALID_INPUT";
  if (/network.*timed?\s*out|connection.*timed?\s*out/u.test(m)) return "NETWORK_TIMEOUT";
  if (/timed?\s*out|timeout/u.test(m)) return "TIMEOUT";
  if (/econnrefused|enotfound|network|fetch failed/u.test(m)) return "NETWORK_ERROR";
  if (/rpc.*error|rpc.*fail/u.test(m)) return "RPC_ERROR";
  if (/#\d+/.test(m)) return "CONTRACT_ERROR";
  return "UNKNOWN";
}

/**
 * Wrap any thrown value into a `SorobanIdentityError` with a code
 * derived from its message. Idempotent — already-wrapped errors
 * pass through.
 */
export function wrapError(err: unknown, fallbackMessage = "unexpected SDK error"): SorobanIdentityError {
  if (err instanceof SorobanIdentityError) return err;
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : fallbackMessage;
  return new SorobanIdentityError(message, { code: classifyError(message), originalError: err });
}
