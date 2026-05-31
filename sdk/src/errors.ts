// Standardised error envelope for the SDK + server layer (#249).
//
// Every SDK / server error is shaped as `SorobanIdentityError`, which
// carries a stable `code` enum the caller can switch on, an optional
// `details` map for structured context, and the original error
// preserved for debugging. `ContractError` is intentionally a
// sibling (not a subclass) of `SorobanIdentityError` because its
// public `code` field is a *contract panic number* — different shape
// from the envelope's string enum, and renaming it would be a
// breaking change. Use `toEnvelope()` on either to get the
// uniform JSON shape.

export type SorobanErrorCode =
  // Lookups
  | "NOT_FOUND"
  // Auth surface (#253)
  | "UNAUTHORIZED"
  // Creation conflicts (#249)
  | "ALREADY_EXISTS"
  // Caller-provided data failed schema / shape validation (#249)
  | "INVALID_INPUT"
  // RPC / Horizon connectivity failures
  | "NETWORK_ERROR"
  // Soroban contract panics (translated by ContractError)
  | "CONTRACT_ERROR"
  // Rate limit exhaustion (#254)
  | "RATE_LIMITED"
  // Retained for backwards-compatibility with the previous code set
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

export class SorobanIdentityError extends Error {
  readonly code: SorobanErrorCode;
  readonly details?: Record<string, unknown>;
  readonly originalError?: unknown;

  /** Backwards-compatible positional signature:
   *  `new SorobanIdentityError(msg, codeString, originalError)`.
   *  New init-object signature:
   *  `new SorobanIdentityError(msg, { code, details, originalError })`. */
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

export class ContractError extends Error {
  readonly code: number;

  constructor(code: number, errorMap: Record<number, string>) {
    super(errorMap[code] ?? `Contract error code ${code}`);
    this.name = "ContractError";
    this.code = code;
  }

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
