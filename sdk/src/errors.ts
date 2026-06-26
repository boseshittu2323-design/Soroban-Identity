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
}
