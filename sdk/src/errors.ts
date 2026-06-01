/**
 * Discriminator for {@link SorobanIdentityError}. Callers can branch on
 * `err.code` to handle each class without parsing the message.
 *
 * - `NOT_FOUND` — record (DID, credential, reporter) does not exist
 * - `UNAUTHORIZED` — caller is not authorised for the requested operation
 * - `ALREADY_EXISTS` — creation conflicts; record already registered (#249)
 * - `INVALID_INPUT` — caller-provided data failed schema/shape validation (#249)
 * - `NETWORK_ERROR` — transport failure, RPC timeout, etc.
 * - `CONTRACT_ERROR` — contract returned a non-zero error code or simulation failed
 * - `RATE_LIMITED` — rate limit exhaustion (#254)
 * - `VALIDATION_ERROR` — retained for backwards-compatibility
 * - `UNKNOWN` — fallback when no other code fits
 */
export type SorobanErrorCode =
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "ALREADY_EXISTS"
  | "INVALID_INPUT"
  | "NETWORK_ERROR"
  | "CONTRACT_ERROR"
  | "RATE_LIMITED"
  | "VALIDATION_ERROR"
  | "UNKNOWN";

export interface SorobanIdentityErrorInit {
  code?: SorobanErrorCode;
  details?: Record<string, unknown>;
  originalError?: unknown;
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

  /**
   * Backwards-compatible positional signature:
   *   `new SorobanIdentityError(msg, codeString, originalError)`.
   * Init-object signature:
   *   `new SorobanIdentityError(msg, { code, details, originalError })`.
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
    } else {
      this.code = codeOrInit;
      this.originalError = originalError;
    }
  }

  toEnvelope(): { code: SorobanErrorCode; message: string; details?: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
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
  if (/invalid|malformed|bad request|missing/u.test(m)) return "INVALID_INPUT";
  if (/timeout|econnrefused|enotfound|network|fetch failed/u.test(m)) return "NETWORK_ERROR";
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
