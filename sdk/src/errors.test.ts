import { describe, it, expect } from "vitest";
import { parseContractError, SorobanIdentityError } from "./errors";

describe("parseContractError", () => {
  it("parses IdentityError variants", () => {
    const raw = new Error("Simulation failed: Error(Contract, #2)");
    const parsed = parseContractError(raw, "identity");
    expect(parsed).toBeInstanceOf(SorobanIdentityError);
    expect(parsed.code).toBe("ALREADY_EXISTS");
    expect(parsed.contractCode).toBe(2);
  });

  it("parses CredentialError variants", () => {
    const raw = new Error("Error(Contract, 5)");
    const parsed = parseContractError(raw, "credential");
    expect(parsed.code).toBe("NOT_AN_ISSUER");
    expect(parsed.contractCode).toBe(5);
  });

  it("parses ReputationError variants", () => {
    const raw = "Host error: contract error #3";
    const parsed = parseContractError(raw, "reputation");
    expect(parsed.code).toBe("NOT_A_REPORTER");
    expect(parsed.contractCode).toBe(3);
  });

  it("returns UNKNOWN for generic errors", () => {
    const parsed = parseContractError(new Error("Network disconnect"), "identity");
    expect(parsed.code).toBe("UNKNOWN");
import {
  ContractError,
  SorobanIdentityError,
  classifyError,
  wrapError,
} from "./errors";
import { SorobanErrorCodes } from "./error-codes";

describe("SorobanIdentityError envelope (#249)", () => {
  it("accepts the legacy positional constructor", () => {
    const err = new SorobanIdentityError("not found", "NOT_FOUND");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("not found");
    expect(err.toEnvelope()).toEqual({ code: "NOT_FOUND", message: "not found" });
  });

  it("accepts the init-object constructor with details", () => {
    const err = new SorobanIdentityError("bad input", {
      code: "INVALID_INPUT",
      details: { field: "issuer" },
      originalError: new Error("inner"),
    });
    expect(err.code).toBe("INVALID_INPUT");
    expect(err.details).toEqual({ field: "issuer" });
    expect(err.toEnvelope()).toEqual({
      code: "INVALID_INPUT",
      message: "bad input",
      details: { field: "issuer" },
    });
    expect((err.originalError as Error).message).toBe("inner");
  });

  it("defaults code to UNKNOWN when nothing is provided", () => {
    const err = new SorobanIdentityError("???");
    expect(err.code).toBe("UNKNOWN");
  });
});

describe("ContractError.toEnvelope", () => {
  it("emits CONTRACT_ERROR with the panic number in details", () => {
    const err = new ContractError(7, { 7: "not authorized" });
    expect(err.code).toBe(7);
    expect(err.message).toBe("not authorized");
    expect(err.toEnvelope()).toEqual({
      code: "CONTRACT_ERROR",
      message: "not authorized",
      details: { contractCode: 7 },
    });
  });

  it("falls back to a generic message for unknown codes", () => {
    const err = new ContractError(99, {});
    expect(err.message).toBe("Contract error code 99");
  });

  it("extracts a code from a #N panic string", () => {
    const extracted = ContractError.extract("HostError: contract #5 failed", { 5: "expired" });
    expect(extracted).toBeInstanceOf(ContractError);
    expect(extracted?.code).toBe(5);
  });

  it("returns null when the panic string has no #N marker", () => {
    expect(ContractError.extract("no marker here", {})).toBeNull();
  });
});

describe("classifyError", () => {
  it.each([
    ["already exists in registry", "ALREADY_EXISTS"],
    ["DID not found for address", "NOT_FOUND"],
    ["Unauthorized: caller is not admin", "UNAUTHORIZED"],
    ["Too many requests — rate limit hit", "RATE_LIMITED"],
    ["invalid claims payload", "INVALID_INPUT"],
    ["fetch failed: ECONNREFUSED", "NETWORK_ERROR"],
    ["HostError: contract #4", "CONTRACT_ERROR"],
    ["something else entirely", "UNKNOWN"],
    ["insufficient fee for transaction", "INSUFFICIENT_FEE"],
    ["ledger closed before transaction", "LEDGER_CLOSED"],
    ["contract panic: host environment error", "CONTRACT_PANIC"],
    ["network connection timed out", "NETWORK_TIMEOUT"],
    ["InvalidAddress: not a valid Stellar address", "INVALID_ADDRESS"],
    ["invalid argument: missing required field", "INVALID_ARGUMENT"],
  ])("classifies %j as %s", (msg, expected) => {
    expect(classifyError(msg)).toBe(expected);
  });
});

describe("SorobanErrorCodes", () => {
  it("exposes all expected code constants", () => {
    expect(SorobanErrorCodes.NOT_FOUND).toBe("NOT_FOUND");
    expect(SorobanErrorCodes.UNAUTHORIZED).toBe("UNAUTHORIZED");
    expect(SorobanErrorCodes.INVALID_ADDRESS).toBe("INVALID_ADDRESS");
    expect(SorobanErrorCodes.INVALID_PROOF).toBe("INVALID_PROOF");
    expect(SorobanErrorCodes.INVALID_ARGUMENT).toBe("INVALID_ARGUMENT");
    expect(SorobanErrorCodes.NETWORK_TIMEOUT).toBe("NETWORK_TIMEOUT");
    expect(SorobanErrorCodes.RPC_ERROR).toBe("RPC_ERROR");
    expect(SorobanErrorCodes.CONTRACT_PANIC).toBe("CONTRACT_PANIC");
    expect(SorobanErrorCodes.INSUFFICIENT_FEE).toBe("INSUFFICIENT_FEE");
    expect(SorobanErrorCodes.LEDGER_CLOSED).toBe("LEDGER_CLOSED");
    expect(SorobanErrorCodes.UNKNOWN).toBe("UNKNOWN");
  });

  it("codes are usable as SorobanIdentityError codes", () => {
    const err = new SorobanIdentityError("fee too low", SorobanErrorCodes.INSUFFICIENT_FEE);
    expect(err.code).toBe("INSUFFICIENT_FEE");
  });
});

describe("wrapError", () => {
  it("returns input unchanged when already a SorobanIdentityError", () => {
    const inner = new SorobanIdentityError("dup", "ALREADY_EXISTS");
    expect(wrapError(inner)).toBe(inner);
  });

  it("wraps a plain Error with a classified code", () => {
    const wrapped = wrapError(new Error("DID not found"));
    expect(wrapped).toBeInstanceOf(SorobanIdentityError);
    expect(wrapped.code).toBe("NOT_FOUND");
    expect(wrapped.originalError).toBeInstanceOf(Error);
  });

  it("wraps a thrown string", () => {
    const wrapped = wrapError("rate limit exceeded");
    expect(wrapped.code).toBe("RATE_LIMITED");
  });

  it("falls back to UNKNOWN for opaque throws", () => {
    const wrapped = wrapError({ weird: true });
    expect(wrapped.code).toBe("UNKNOWN");
    expect(wrapped.message).toBe("unexpected SDK error");
  });
});
